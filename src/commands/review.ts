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
  maxViolations?: number; // Batas maksimal temuan kumulatif sebelum berhenti & generate report
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
    console.error(chalk.red('Error: Perintah harus dijalankan di dalam git repository!'));
    return;
  }

  const abortController = createProcessAbortController();
  const log = (...args: unknown[]) => { if (!options.json) console.log(...args); };
  const spinner = ora({ text: chalk.blue('Mengambil git diff... (Tekan Ctrl+C untuk batalkan)'), isSilent: !!options.json }).start();

  try {
    const config = await loadConfig();
    const targetBranch = options.target || options.branch;
    const sourceBranch = options.source;

    if (targetBranch && sourceBranch) {
      spinner.text = chalk.blue(`Mengambil git diff: ${targetBranch}...${sourceBranch} (PR style)...`);
    } else if (targetBranch) {
      spinner.text = chalk.blue(`Mengambil git diff terhadap branch: ${targetBranch}...`);
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
      spinner.info(chalk.yellow('\nProses review dibatalkan.'));
      return;
    }

    if (!rawDiff || rawDiff.trim().length === 0) {
      spinner.info(
        chalk.yellow(
          options.staged
            ? 'Tidak ada perubahan staged (git diff --staged kosong).'
            : targetBranch && sourceBranch
            ? `Tidak ada perbedaan antara branch ${targetBranch} dan ${sourceBranch}.`
            : targetBranch
            ? `Tidak ada perbedaan terhadap branch ${targetBranch}.`
            : 'Tidak ada perubahan yang terdeteksi (git diff kosong).'
        )
      );
      return;
    }

    spinner.text = chalk.cyan('Mem-parse diff per file...');
    const fileDiffs = parseAnnotatedDiffFiles(rawDiff).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

    if (fileDiffs.length === 0) {
      spinner.info(chalk.yellow('Tidak ada perubahan baris kode (mungkin hanya file biner/dihapus).'));
      return;
    }

    const modelName = options.model || config.defaultModel || '';
    if (!options.coreOnly && !modelName) throw new Error('Belum ada model AI aktif. Pilih provider & model via TUI (`lumio` → Model), atau pakai --model, atau jalankan dengan --core-only.');
    spinner.text = chalk.cyan('Memuat rules dari database...');
    const rules = await loadReviewRules(config);
    spinner.succeed(chalk.green(`Ditemukan ${fileDiffs.length} file berubah, ${rules.rules.length} rules aktif. Memulai audit...\n`));

    const inputs = captureReviewInputs(fileDiffs, { ...options, target: targetBranch ? refs.base : undefined, source: sourceBranch && targetBranch ? refs.head : undefined });
    const maxViolations = typeof options.maxViolations === 'number' && options.maxViolations > 0 ? options.maxViolations : undefined;
    const audits = await auditInputs(inputs, {
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
    const reviewResult = summarizeAudit(audits, rules, repository);
    if (options.coreOnly) reviewResult.notes = ['Core-only: hanya checker deterministik; rule semantik tidak diperiksa AI.', ...(reviewResult.notes || [])];
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
        log(chalk.gray(`💾 History report tersimpan di: ${chalk.underline.cyan(savedPath)}\n`));
      } catch (err: any) {
        logError('SaveReviewReport', err);
      }
    }

    return reviewResult;
  } catch (error: any) {
    if (abortController.signal.aborted || error.name === 'AbortError') {
      spinner.info(chalk.yellow('\nReview dibatalkan oleh pengguna.'));
      return;
    }
    spinner.fail(chalk.red(`Review gagal: ${error.message}`));
    logError('ReviewCommand', error, { options });
    console.log(chalk.yellow('\n💡 Tips: Pastikan konfigurasi AI Provider, API key, atau nama branch sudah benar di menu TUI.\n'));
    return;
  } finally {
    clearActiveAbortController();
  }
}

/** Audits files with bounded parallelism; results keep input order. Stops scheduling once maxViolations is reached. */
async function auditInputs(inputs: ReviewInput[], opts: { concurrency: number; maxViolations?: number; signal: AbortSignal; quiet: boolean; audit: (input: ReviewInput) => Promise<FileAudit> }): Promise<FileAudit[]> {
  const results: (FileAudit | undefined)[] = new Array(inputs.length);
  const spinner = ora({ text: `Auditing 0/${inputs.length} files...`, isSilent: opts.quiet }).start();
  let next = 0, done = 0, total = 0, stopped = false;
  const worker = async () => {
    while (!stopped && !opts.signal.aborted && next < inputs.length) {
      const index = next++;
      const audit = await opts.audit(inputs[index]);
      results[index] = audit;
      done++;
      total += audit.violations.length;
      spinner.text = `Auditing ${done}/${inputs.length} files... (${total} temuan)`;
      if (!opts.quiet && audit.violations.length) {
        spinner.stopAndPersist({ symbol: audit.violations.some(v => v.severity === 'error') ? chalk.red('✖') : chalk.yellow('▲'), text: `${audit.file}: ${audit.violations.length} temuan` });
        spinner.start();
      }
      if (opts.maxViolations && total >= opts.maxViolations) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, inputs.length) }, worker));
  spinner.succeed(`${done}/${inputs.length} files diaudit (${total} temuan)`);
  if (stopped && !opts.quiet) console.log(chalk.yellow(`\n⚠️  Batas maksimal temuan tercapai (${total} >= ${opts.maxViolations}). Review dihentikan lebih awal.\n`));
  return results.filter((a): a is FileAudit => !!a);
}

function printReviewTerminalReport(result: PRReviewResult) {
  const statusColor =
    result.status === 'APPROVE'
      ? chalk.bold.green
      : result.status === 'REQUEST_CHANGES'
      ? chalk.bold.red
      : chalk.bold.yellow;

  console.log(chalk.bold.cyan('═════════════════════ PULL REQUEST REVIEW REPORT ═════════════════════'));
  console.log(`Status  : ${statusColor(result.status)}`);
  console.log(`Summary : ${result.summary}`);
  if (result.reviewSnapshot) console.log(chalk.gray(`Review  : ${result.reviewSnapshot.fingerprint.slice(0, 16)} | ${result.reviewSnapshot.mode} | scope=${result.reviewSnapshot.scope}`));
  console.log('');

  for (const r of result.repository || []) {
    console.log(`${r.severity === 'error' ? chalk.bgRed.white.bold(' ERROR ') : chalk.bgYellow.black.bold(' WARN ')} ${chalk.bold('git')} ${chalk.gray(`[${r.rule}]`)}`);
    console.log(`    ${chalk.whiteBright(r.comment)}`);
    if (r.suggestedFix) console.log(`    ${chalk.green('Fix: ' + r.suggestedFix)}`);
  }
  if (result.repository?.length) console.log('');

  const byFile = new Map<string, LineViolation[]>();
  for (const v of result.violations) byFile.set(v.file, [...(byFile.get(v.file) || []), v]);
  for (const [file, items] of byFile) {
    const errors = items.filter(v => v.severity === 'error').length;
    console.log(`${chalk.bold.underline(file)} ${chalk.gray(`(${errors} error, ${items.length - errors} warning)`)}`);
    for (const v of items) {
      const tag = v.severity === 'error' ? chalk.red('error  ') : chalk.yellow('warning');
      const source = v.engine === 'ai' ? chalk.magenta(' [AI]') : '';
      console.log(`  ${chalk.gray(`${v.line}:${v.column ?? 1}`.padEnd(8))} ${tag} ${v.comment}${source}`);
      console.log(`  ${' '.repeat(8)} ${chalk.gray(`↳ ${v.rule}`)}${v.suggestedFix ? chalk.green(`  Fix: ${v.suggestedFix}`) : ''}`);
    }
    console.log('');
  }

  if (!result.violations.length && !result.repository?.length) {
    console.log(result.status === 'APPROVE' ? chalk.green('✔ Tidak ada pelanggaran.') : chalk.yellow('Tidak ada pelanggaran terkonfirmasi, tetapi review belum lengkap (lihat catatan).'));
  }
  if (result.skippedFiles?.length) console.log(chalk.gray(`Dilewati: ${result.skippedFiles.map(s => `${s.file} (${s.reason})`).join(', ')}`));
  for (const note of result.notes || []) console.log(chalk.yellow(`⚠ ${note}`));
  console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════════\n'));
}
