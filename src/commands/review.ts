import { execFileSync } from 'child_process';
import { resolveReviewRefs, snapshotReview } from '../core/review-snapshot.js';
import chalk from 'chalk';
import ora from 'ora';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { parseAnnotatedDiffFiles } from '../core/diff-parser.js';
import { loadReviewRules, snapshotRules, ReviewRule } from '../core/review-rules.js';
import { captureReviewInputs } from '../core/review-input.js';
import { auditFile, coreAudit, summarizeAudit, FileAudit, fileMatchesPattern } from '../core/review-engine.js';
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
}

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
  const spinner = ora(chalk.blue('Mengambil git diff... (Tekan Ctrl+C untuk batalkan)')).start();

  try {
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
      targetBranch: targetBranch ? refs.base : undefined,
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

    const config = await loadConfig();
    const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';

    const totalFiles = fileDiffs.length;
    spinner.succeed(chalk.green(`Ditemukan ${totalFiles} file yang berubah. Memulai analisis per file...\n`));

    const rules = await loadReviewRules(config);
    const inputs = captureReviewInputs(fileDiffs, { ...options, target: targetBranch ? refs.base : undefined, source: sourceBranch && targetBranch ? refs.head : undefined });
    const audits: FileAudit[] = [];
    const maxViolations = typeof options.maxViolations === 'number' && options.maxViolations > 0 ? options.maxViolations : undefined;
    let totalViolationsCount = 0;

    for (const input of inputs) {
      if (abortController.signal.aborted) return;
      const fileSpinner = ora(`Auditing ${input.file}...`).start();

      // Targeted RAG: kirim hanya rules yang applicable untuk file ini ke LLM
      const targetedRules = snapshotRules(
        rules.rules.filter(r => {
          if (r.category === 'meta') return false;
          if (r.targetFiles && r.targetFiles.length > 0 && !fileMatchesPattern(input.file, r.targetFiles)) return false;
          return true;
        }) as ReviewRule[]
      );

      const audit = options.coreOnly ? coreAudit(input, rules) : await auditFile(input, targetedRules.rules.length > 0 ? targetedRules : rules, findings => callLLM(
        buildHybridPrompt(input, targetedRules.rules.length > 0 ? targetedRules : rules, findings), modelName, AbortSignal.any([abortController.signal, AbortSignal.timeout(30_000)]), config, { temperature: 0 }
      ));
      audits.push(audit);
      totalViolationsCount += audit.violations.length;

      if (audit.violations.length) {
        fileSpinner.fail(`${input.file}: ${audit.violations.length} violations found`);
      } else {
        fileSpinner.succeed(`${input.file}: Passed (No violations)`);
      }

      if (maxViolations && totalViolationsCount >= maxViolations) {
        if (!options.json) {
          console.log(chalk.yellow(`\n⚠️  Batas maksimal temuan tercapai (${totalViolationsCount} >= ${maxViolations} violations). Menghentikan review & langsung membuat report...\n`));
        }
        break;
      }
    }
    if (abortController.signal.aborted) return;
    const reviewResult = summarizeAudit(audits, rules);
    reviewResult.reviewSnapshot = snapshotReview(inputs, rules, rawDiff, refs, options.scope || 'full');

    if (options.json) {
      console.log(JSON.stringify(reviewResult, null, 2));
      return reviewResult;
    }

    console.log('');
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
          model: modelName,
          outputDir: options.outputDir,
        });
        console.log(chalk.gray(`💾 History report tersimpan di: ${chalk.underline.cyan(savedPath)}\n`));
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

function printReviewTerminalReport(result: PRReviewResult) {
  const statusColor =
    result.status === 'APPROVE'
      ? chalk.bold.green
      : result.status === 'REQUEST_CHANGES'
      ? chalk.bold.red
      : chalk.bold.yellow;

  console.log(chalk.bold.cyan('═════════════════════ PULL REQUEST REVIEW REPORT ═════════════════════'));
  console.log(`Status  : ${statusColor(result.status)}`);
  console.log(`Summary : ${result.summary}\n`);
  if (result.reviewSnapshot) {
    const s = result.reviewSnapshot;
    console.log(`Review ID: ${s.fingerprint}`);
    console.log(`Base     : ${s.base}\nHead     : ${s.head}\nMerge base: ${s.mergeBase}`);
    console.log(`Engine   : ${s.engine} | ${s.mode} | scope=${s.scope}`);
    console.log(`Rules    : ${s.rules}`);
  }
  if (result.coverage) console.log(`Coverage : ${['PASS','FAIL','NOT_APPLICABLE','UNCERTAIN'].map(status => `${status}=${result.coverage!.filter(c => c.status === status).length}`).join(' | ')}\n`);
  console.log(chalk.yellow('AI analysis is unverified advisory only; it never changes the core verdict.'));

  if (result.violations.length === 0) {
    console.log((result.complete === false || result.status !== 'APPROVE' ? chalk.yellow : chalk.green)(result.status === 'APPROVE' ? '✔ No violations found with complete rule coverage.' : 'No confirmed violations; review does not provide a clean verdict.'));
  } else {
    console.log(chalk.bold.red(`🚨 Line-by-Line Violations & PR Comments (${result.violations.length}):\n`));

    result.violations.forEach((v) => {
      const tag =
        v.severity === 'error'
          ? chalk.bgRed.white.bold(' ERROR ')
          : v.severity === 'warning'
          ? chalk.bgYellow.black.bold(' WARN ')
          : chalk.bgBlue.white.bold(' INFO ');

      console.log(`${tag} ${chalk.bold.underline(v.file)} : ${chalk.bold.yellow(`line ${v.line}`)}`);
      console.log(`    Rule   : ${chalk.gray(v.rule)}`);
      console.log(`    Comment: ${chalk.whiteBright(v.comment)}`);
      if (v.suggestedFix) {
        console.log(`    Fix    : ${chalk.green(v.suggestedFix)}`);
      }
      console.log(chalk.gray('─'.repeat(70)));
    });
  }



  if (result.advisory?.length) {
    console.log(chalk.yellow('\nUnverified AI advisory (may vary between runs; not confirmed violations):'));
    result.advisory.forEach(v => console.log(` • ${v.file}:${v.line} [${v.ruleId}] ${v.comment}`));
  }

  console.log(chalk.bold.cyan('\n══════════════════════════════════════════════════════════════════════\n'));
}
