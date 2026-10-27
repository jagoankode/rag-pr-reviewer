import { execFileSync } from 'child_process';
import { resolveReviewRefs, snapshotReview } from '../core/review-snapshot.js';
import chalk from 'chalk';
import ora from 'ora';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { parseAnnotatedDiffFiles } from '../core/diff-parser.js';
import { loadReviewRules } from '../core/review-rules.js';
import { captureReviewInputs, ReviewInput } from '../core/review-input.js';
import { auditFile, coreAudit, summarizeAudit, FileAudit } from '../core/review-engine.js';
import { readRepoContext, repoAudit } from '../core/checkers/git.js';
import { buildHybridPrompt } from '../core/review-prompt.js';
import { saveReviewReport } from '../core/history.js';
import { loadConfig } from '../core/config.js';
import { callLLM } from '../core/llm-client.js';

import { logError } from '../core/logger.js';
import { out, t } from '../core/i18n.js';
import { createProcessAbortController, clearActiveAbortController } from '../core/nav.js';
import { FileReviewResult, PRReviewResult, LineViolation } from '../core/schema.js';

export interface ReviewOptions {
  staged?: boolean;
  branch?: string;        // target/base branch
  source?: string;        // source/feature branch
  target?: string;        // target/base branch
  scope?: 'full' | 'diff'; // 'full' = review 1 file utuh terdampak | 'diff' = review baris diff saja (default: 'full')
  fetchRemote?: boolean;
  model?: string;
  limit?: number;
  json?: boolean;
  coreOnly?: boolean;
  saveReport?: boolean;
  outputDir?: string;
  maxViolations?: number; // Jumlah temuan maksimal di laporan; audit berhenti begitu batas tercapai
  concurrency?: number;   // Jumlah file yang diaudit AI secara paralel
}

const AI_TIMEOUT_MS = 180_000;

export function extractReviewResult(rawText: string): FileReviewResult {
  const text = (rawText || '').trim();

  // 1. Coba parse langsung
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        violations: Array.isArray(parsed.violations) ? parsed.violations : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      };
    }
  } catch {}

  // 2. Ekstrak dari blok markdown ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object') {
        return {
          violations: Array.isArray(parsed.violations) ? parsed.violations : [],
          notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        };
      }
    } catch {}
  }

  // 3. Ambil substring antara kurung kurawal terluar { ... } (mengabaikan thinking process Claude)
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      const candidate = text.substring(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return {
          violations: Array.isArray(parsed.violations) ? parsed.violations : [],
          notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        };
      }
    } catch {}
  }

  // 4. Fallback toleran jika JSON terpotong sebagian di akhir
  const violations: LineViolation[] = [];
  const lineMatches = text.matchAll(/\{\s*"file"[^\}]+\}/g);
  for (const m of lineMatches) {
    try {
      const v = JSON.parse(m[0]);
      if (v.file && v.line) violations.push(v);
    } catch {}
  }

  return { violations, notes: [] };
}

export async function reviewCommand(options: ReviewOptions): Promise<PRReviewResult | void> {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(chalk.red(t('notGitRepoError')));
    return;
  }

  const abortController = createProcessAbortController();
  const log = (...args: unknown[]) => { if (!options.json) console.log(...args); };
  const spinner = ora({ text: chalk.blue(t('reviewFetchingDiff')), isSilent: !!options.json }).start();

  try {
    const config = await loadConfig();
    const targetBranch = options.target || options.branch;
    const sourceBranch = options.source;

    if (targetBranch && sourceBranch) {
      spinner.text = chalk.blue(t('reviewDiffPr', { target: targetBranch, source: sourceBranch }));
    } else if (targetBranch) {
      spinner.text = chalk.blue(t('reviewDiffTarget', { target: targetBranch }));
    }

    // Fetch before resolving refs, then use immutable SHAs for both diff and content.
    if (options.fetchRemote) execFileSync('git', ['fetch', '--all', '--prune'], { stdio: 'pipe' });
    const refs = resolveReviewRefs({ ...options, source: sourceBranch, target: targetBranch });
    const rawDiff = await getGitDiff({
      staged: options.staged,
      branch: targetBranch,
      // Self-review compares the worktree with the merge base, so changes already on the base are not reviewed.
      targetBranch: targetBranch ? (sourceBranch ? refs.base : refs.mergeBase) : undefined,
      sourceBranch: sourceBranch && targetBranch ? refs.head : undefined,
      fetchRemote: false,
    });

    if (abortController.signal.aborted) {
      spinner.info(chalk.yellow(`\n${t('reviewCancelled')}`));
      return;
    }

    if (!rawDiff || rawDiff.trim().length === 0) {
      spinner.info(
        chalk.yellow(
          options.staged
            ? t('reviewNoStaged')
            : targetBranch && sourceBranch
            ? t('reviewNoDiffBranches', { target: targetBranch, source: sourceBranch })
            : targetBranch
            ? t('reviewNoDiffTarget', { target: targetBranch })
            : t('reviewNoChanges')
        )
      );
      return;
    }

    spinner.text = chalk.cyan(t('reviewParsing'));
    const fileDiffs = parseAnnotatedDiffFiles(rawDiff).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

    if (fileDiffs.length === 0) {
      spinner.info(chalk.yellow(t('reviewNoLineChanges')));
      return;
    }

    const modelName = options.model || config.defaultModel || '';
    if (!options.coreOnly && !modelName) throw new Error(t('noModelReview'));
    spinner.text = chalk.cyan(t('loadingRules'));
    const rules = await loadReviewRules(config);
    spinner.succeed(chalk.green(`${t('reviewStarting', { files: fileDiffs.length, rules: rules.rules.length })}\n`));

    const inputs = captureReviewInputs(fileDiffs, { ...options, target: targetBranch ? refs.base : undefined, source: sourceBranch && targetBranch ? refs.head : undefined });
    const maxViolations = typeof options.maxViolations === 'number' && options.maxViolations > 0 ? options.maxViolations : undefined;
    const { audits, limitNote, partial } = await auditInputs(inputs, {
      concurrency: options.coreOnly ? inputs.length : Math.max(1, options.concurrency || 4),
      maxViolations,
      signal: abortController.signal,
      quiet: !!options.json,
      audit: input => options.coreOnly ? Promise.resolve(coreAudit(input, rules)) : auditFile(input, rules, (findings, aiRules) => callLLM(
        buildHybridPrompt(input, aiRules, findings), modelName, AbortSignal.any([abortController.signal, AbortSignal.timeout(AI_TIMEOUT_MS)]), config, { temperature: 0 }
      )),
    });
    if (abortController.signal.aborted) return;

    const repository = repoAudit(rules, readRepoContext(refs, sourceBranch));
    const reviewResult = summarizeAudit(audits, rules, repository, partial);
    if (limitNote) reviewResult.notes = [limitNote, ...(reviewResult.notes || [])];
    if (options.coreOnly) reviewResult.notes = [out('coreOnly'), ...(reviewResult.notes || [])];
    reviewResult.reviewSnapshot = snapshotReview(inputs, rules, rawDiff, refs, options.scope || 'full');

    if (options.json) {
      console.log(JSON.stringify(reviewResult, null, 2));
      return reviewResult;
    }

    log('');
    printReviewTerminalReport(reviewResult);

    // Simpan report history markdown secara default
    if (options.saveReport !== false) {
      try {
        const reportLabel = targetBranch && sourceBranch
          ? `${targetBranch.replace(/\//g, '_')}_vs_${sourceBranch.replace(/\//g, '_')}`
          : targetBranch || (options.staged ? 'staged' : 'local');

        const savedPath = await saveReviewReport(reviewResult, {
          branch: reportLabel,
          staged: options.staged,
          sourceBranch,
          targetBranch,
          model: options.coreOnly ? 'core-only' : modelName,
          outputDir: options.outputDir,
        });
        log(chalk.gray(`${t('reportSaved', { path: chalk.underline.cyan(savedPath) })}\n`));
      } catch (err: any) {
        logError('SaveReviewReport', err);
      }
    }

    return reviewResult;
  } catch (error: any) {
    if (abortController.signal.aborted || error.name === 'AbortError') {
      spinner.info(chalk.yellow(`\n${t('reviewCancelledByUser')}`));
      return;
    }
    spinner.fail(chalk.red(t('reviewFailed', { message: error.message })));
    logError('ReviewCommand', error, { options });
    console.log(chalk.yellow(`\n${t('reviewTips')}\n`));
    return;
  } finally {
    clearActiveAbortController();
  }
}

/** Audits files with bounded parallelism; results keep input order. Stops scheduling once maxViolations is reached and trims the result to that many findings. */
async function auditInputs(inputs: ReviewInput[], opts: { concurrency: number; maxViolations?: number; signal: AbortSignal; quiet: boolean; audit: (input: ReviewInput) => Promise<FileAudit> }): Promise<{ audits: FileAudit[]; limitNote?: string; partial?: boolean }> {
  const results: (FileAudit | undefined)[] = new Array(inputs.length);
  const spinner = ora({ text: t('auditing', { done: 0, total: inputs.length }), isSilent: opts.quiet }).start();
  let next = 0, done = 0, total = 0, stopped = false;
  const worker = async () => {
    while (!stopped && !opts.signal.aborted && next < inputs.length) {
      const index = next++;
      const audit = await opts.audit(inputs[index]);
      results[index] = audit;
      done++;
      total += audit.violations.length;
      spinner.text = t('auditingFindings', { done, total: inputs.length, count: total });
      if (!opts.quiet && audit.violations.length) {
        spinner.stopAndPersist({ symbol: audit.violations.some(v => v.severity === 'error') ? chalk.red('✖') : chalk.yellow('▲'), text: t('fileFindings', { file: audit.file, count: audit.violations.length }) });
        spinner.start();
      }
      if (opts.maxViolations && total >= opts.maxViolations) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, inputs.length) }, worker));
  spinner.succeed(t('audited', { done, total: inputs.length, count: total }));
  const audits = results.filter((a): a is FileAudit => !!a);
  if (!stopped) return { audits };
  // Files already in flight finish past the limit; unaudited files leave the review incomplete.
  const limitNote = out('limitReached', { shown: opts.maxViolations!, total, unaudited: inputs.length - done });
  if (!opts.quiet) console.log(chalk.yellow(`\n⚠️  ${limitNote}\n`));
  return { audits: trimFindings(audits, opts.maxViolations!), limitNote, partial: done < inputs.length };
}

/** Keeps exactly `max` findings, errors before warnings (each in input order), so a dropped error never softens the verdict. */
export function trimFindings(audits: FileAudit[], max: number): FileAudit[] {
  const all = audits.flatMap(a => a.violations);
  const keep = new Set([...all.filter(v => v.severity === 'error'), ...all.filter(v => v.severity !== 'error')].slice(0, max));
  return audits.map(a => {
    const kept = a.violations.filter(v => keep.has(v));
    return kept.length === a.violations.length ? a : { ...a, violations: kept, complete: false };
  });
}

function printReviewTerminalReport(result: PRReviewResult) {
  const statusColor =
    result.status === 'APPROVE'
      ? chalk.bold.green
      : result.status === 'REQUEST_CHANGES'
      ? chalk.bold.red
      : chalk.bold.yellow;

  console.log(chalk.bold.cyan(`═════════════════════ ${out('reportTitle')} ═════════════════════`));
  const label = (key: 'statusLabel' | 'summaryLabel' | 'reviewLabel') => out(key).padEnd(9);
  console.log(`${label('statusLabel')}: ${statusColor(result.status)}`);
  console.log(`${label('summaryLabel')}: ${result.summary}`);
  if (result.reviewSnapshot) console.log(chalk.gray(`${label('reviewLabel')}: ${result.reviewSnapshot.fingerprint.slice(0, 16)} | ${result.reviewSnapshot.mode} | scope=${result.reviewSnapshot.scope}`));
  console.log('');

  for (const r of result.repository || []) {
    console.log(`${r.severity === 'error' ? chalk.bgRed.white.bold(' ERROR ') : chalk.bgYellow.black.bold(' WARN ')} ${chalk.bold('git')} ${chalk.gray(`[${r.rule}]`)}`);
    console.log(`    ${chalk.whiteBright(r.comment)}`);
    if (r.suggestedFix) console.log(`    ${chalk.green(`${out('fix')}: ${r.suggestedFix}`)}`);
  }
  if (result.repository?.length) console.log('');

  const byFile = new Map<string, LineViolation[]>();
  for (const v of result.violations) byFile.set(v.file, [...(byFile.get(v.file) || []), v]);
  for (const [file, items] of byFile) {
    const errors = items.filter(v => v.severity === 'error').length;
    console.log(`${chalk.bold.underline(file)} ${chalk.gray(out('fileCounts', { errors, warnings: items.length - errors }))}`);
    for (const v of items) {
      const tag = v.severity === 'error' ? chalk.red('error  ') : chalk.yellow('warning');
      console.log(`  ${chalk.gray(`${v.line}:${v.column ?? 1}`.padEnd(8))} ${tag} ${v.comment}`);
      console.log(`  ${' '.repeat(8)} ${chalk.gray(`↳ ${v.rule}`)}${v.suggestedFix ? chalk.green(`  ${out('fix')}: ${v.suggestedFix}`) : ''}`);
    }
    console.log('');
  }

  if (!result.violations.length && !result.repository?.length) {
    console.log(result.status === 'APPROVE' ? chalk.green(out('noViolations')) : chalk.yellow(out('noViolationsIncomplete')));
  }
  if (result.skippedFiles?.length) console.log(chalk.gray(`${out('skipped')}: ${result.skippedFiles.map(s => `${s.file} (${s.reason})`).join(', ')}`));
  for (const note of result.notes || []) console.log(chalk.yellow(`⚠ ${note}`));
  console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════════\n'));
}
