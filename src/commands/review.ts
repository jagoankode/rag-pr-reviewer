import chalk from 'chalk';
import ora from 'ora';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { parseAnnotatedDiffFiles } from '../core/diff-parser.js';
import { searchRelevantGuidelines } from '../core/db.js';
import { saveReviewReport } from '../core/history.js';
import { loadConfig } from '../core/config.js';
import { callLLM } from '../core/llm-client.js';
import { setActiveAbortController, createProcessAbortController, clearActiveAbortController } from '../core/nav.js';
import { FileReviewResult, PRReviewResult, LineViolation } from '../core/schema.js';

export interface ReviewOptions {
  staged?: boolean;
  branch?: string;        // target/base branch
  source?: string;        // source/feature branch
  target?: string;        // target/base branch
  fetchRemote?: boolean;
  model?: string;
  limit?: number;
  json?: boolean;
  saveReport?: boolean;
  outputDir?: string;
}

function extractReviewResult(rawText: string): FileReviewResult {
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

    const rawDiff = await getGitDiff({
      staged: options.staged,
      branch: targetBranch,
      targetBranch: targetBranch,
      sourceBranch: sourceBranch,
      fetchRemote: options.fetchRemote,
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
    const fileDiffs = parseAnnotatedDiffFiles(rawDiff);

    if (fileDiffs.length === 0) {
      spinner.info(chalk.yellow('Tidak ada perubahan baris kode (mungkin hanya file biner/dihapus).'));
      return;
    }

    const config = await loadConfig();
    const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';

    const totalFiles = fileDiffs.length;
    spinner.succeed(chalk.green(`Ditemukan ${totalFiles} file yang berubah. Memulai analisis per file...\n`));

    const allViolations: LineViolation[] = [];
    const generalFeedback: string[] = [];

    // Iterasi per file dengan progress indicator real-time [1 dari N file]
    for (let i = 0; i < totalFiles; i++) {
      if (abortController.signal.aborted) {
        console.log(chalk.yellow('\n⚠️  Review dibatalkan oleh pengguna di tengah proses.'));
        break;
      }

      const fileDiff = fileDiffs[i];
      const progressLabel = `[${i + 1}/${totalFiles}]`;
      const fileSpinner = ora(
        chalk.magenta(`${progressLabel} Menganalisis ${chalk.bold.underline(fileDiff.file)} (${fileDiff.addedLinesCount} baris)... (Ctrl+C: Batal)`)
      ).start();

      try {
        // Cari RAG guideline yang spesifik untuk file/diff ini
        let relevantRules: string[] = [];
        try {
          const chunks = await searchRelevantGuidelines(`${fileDiff.file}\n${fileDiff.annotatedText}`, options.limit || 5);
          relevantRules = chunks.map((c) => `[Rule Title: ${c.title}]\n${c.content}`);
        } catch {
          // fallback jika db kosong
        }

        // STRICT GROUNDING: Jika tidak ada rule sama sekali di RAG/Qdrant, JANGAN izinkan AI berasumsi!
        if (relevantRules.length === 0) {
          fileSpinner.succeed(chalk.gray(`${progressLabel} ${fileDiff.file} ➔ Bersih (Tidak ada aturan terkait di Vector DB)`));
          continue;
        }

        const prompt = `You are a strict Code Convention Auditor.
Your ONLY job is to verify if this code violates the EXPLICIT registered conventions provided below.

### REGISTERED TEAM CONVENTIONS (EXACT TRUTH):
${relevantRules.join('\n\n---\n\n')}

### STRICT AUDIT RULES:
1. ZERO ASSUMPTIONS: You must ONLY flag violations against the exact rules listed in "REGISTERED TEAM CONVENTIONS" above.
2. DO NOT use generic best practices, personal styling preferences, clean architecture opinions, or external internet standards.
3. If an added line does NOT directly violate any rule in the REGISTERED TEAM CONVENTIONS above, it is 100% VALID. Return empty violations array [].
4. Every violation MUST cite the exact [Rule Title] from the registered conventions as its "rule" property.
5. Only inspect newly added/modified lines marked with \`+ L<number>:\`.
6. SuggestedFix must be a replacement string snippet or null if not applicable.

### File Diff to Audit:
${fileDiff.annotatedText}
`;

        let object: FileReviewResult | null = null;

        try {
          const rawResponse = await callLLM(prompt, modelName, abortController.signal);
          object = extractReviewResult(rawResponse);
        } catch (callErr: any) {
          if (abortController.signal.aborted || callErr.name === 'AbortError') {
            fileSpinner.warn(chalk.yellow(`${progressLabel} ${fileDiff.file} ➔ Dibatalkan (Aborted).`));
            break;
          }
          throw callErr;
        }

        if (object && object.violations && object.violations.length > 0) {
          allViolations.push(...object.violations);
          fileSpinner.warn(
            chalk.yellow(`${progressLabel} ${fileDiff.file} ➔ Ditemukan ${object.violations.length} pelanggaran`)
          );
        } else {
          fileSpinner.succeed(chalk.gray(`${progressLabel} ${fileDiff.file} ➔ Bersih (Clean)`));
        }

        if (object && object.notes && object.notes.length > 0) {
          generalFeedback.push(...object.notes);
        }
      } catch (err: any) {
        if (abortController.signal.aborted || err.name === 'AbortError') {
          fileSpinner.warn(chalk.yellow(`${progressLabel} ${fileDiff.file} ➔ Dibatalkan.`));
          break;
        }
        fileSpinner.fail(chalk.red(`${progressLabel} ${fileDiff.file} ➔ Gagal dianalisis: ${err.message}`));
      }
    }

    if (abortController.signal.aborted) {
      console.log(chalk.yellow('\nℹ️  Proses review dihentikan dan kembali ke menu.\n'));
      return;
    }

    // Tentukan status akhir PR
    const hasErrors = allViolations.some((v) => v.severity === 'error');
    const finalStatus: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' =
      hasErrors ? 'REQUEST_CHANGES' : allViolations.length > 0 ? 'COMMENT' : 'APPROVE';

    const finalSummary = `Telah selesai mereview ${totalFiles} file yang diubah. Ditemukan total ${allViolations.length} pelanggaran code convention.`;

    const reviewResult: PRReviewResult = {
      status: finalStatus,
      summary: finalSummary,
      violations: allViolations,
      generalFeedback: Array.from(new Set(generalFeedback)),
    };

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
        console.warn(chalk.yellow(`Peringatan: Gagal menyimpan report markdown: ${err.message}`));
      }
    }

    return reviewResult;
  } catch (error: any) {
    spinner.fail(chalk.red(`Review gagal: ${error.message}`));
    console.log(chalk.yellow('\n💡 Tips: Pastikan konfigurasi AI Provider, API key, atau nama branch sudah benar di menu TUI.\n'));
    return;
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

  if (result.violations.length === 0) {
    console.log(chalk.green('✔ Tidak ditemukan pelanggaran code convention pada semua file yang diubah!'));
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

  if (result.generalFeedback && result.generalFeedback.length > 0) {
    console.log(chalk.bold.cyan('\n📌 General Architecture Notes:'));
    result.generalFeedback.forEach((note) => {
      console.log(` • ${note}`);
    });
  }

  console.log(chalk.bold.cyan('\n══════════════════════════════════════════════════════════════════════\n'));
}
