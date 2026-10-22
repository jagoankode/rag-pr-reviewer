import chalk from 'chalk';
import ora from 'ora';
import { generateObject, generateText } from 'ai';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { parseAnnotatedDiffFiles } from '../core/diff-parser.js';
import { searchRelevantGuidelines } from '../core/db.js';
import { getActiveAIProvider } from '../core/config.js';
import { saveReviewReport } from '../core/history.js';
import { FileReviewResultSchema, PRReviewResult, LineViolation } from '../core/schema.js';

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

export async function reviewCommand(options: ReviewOptions): Promise<PRReviewResult | void> {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(chalk.red('Error: Perintah harus dijalankan di dalam git repository!'));
    return;
  }

  const spinner = ora(chalk.blue('Mengambil git diff...')).start();

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

    const { client, config } = await getActiveAIProvider();
    const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';

    const totalFiles = fileDiffs.length;
    spinner.succeed(chalk.green(`Ditemukan ${totalFiles} file yang berubah. Memulai analisis per file...\n`));

    const allViolations: LineViolation[] = [];
    const generalFeedback: string[] = [];

    // Iterasi per file dengan progress indicator real-time [1 dari N file]
    for (let i = 0; i < totalFiles; i++) {
      const fileDiff = fileDiffs[i];
      const progressLabel = `[${i + 1}/${totalFiles}]`;
      const fileSpinner = ora(
        chalk.magenta(`${progressLabel} Menganalisis ${chalk.bold.underline(fileDiff.file)} (${fileDiff.addedLinesCount} baris)...`)
      ).start();

      try {
        // Cari RAG guideline yang spesifik untuk file/diff ini
        let relevantRules: string[] = [];
        try {
          const chunks = await searchRelevantGuidelines(`${fileDiff.file}\n${fileDiff.annotatedText}`, options.limit || 5);
          relevantRules = chunks.map((c) => `[Source: ${c.title}]\n${c.content}`);
        } catch {
          // fallback jika db kosong
        }

        const prompt = `You are a strict Senior Tech Lead and Code Reviewer.
Audit the following file changes against the provided code conventions.

${
  relevantRules.length > 0
    ? `### Relevant Coding Standards & Architecture Rules:\n${relevantRules.join('\n\n---\n\n')}`
    : 'Standard industry conventions: enforce strict typing (no any), error handling, and clean architecture.'
}

### Guidelines for Review:
1. Review newly added or modified lines marked with \`+ L<number>:\`.
2. Map every convention violation directly to its exact \`file\` and \`line\` number.
3. If no violation is found, return an empty violations array.
4. SuggestedFix must be a string snippet or null if not applicable.

### File Diff to Review:
${fileDiff.annotatedText}
`;

        const { object } = await generateObject({
          model: client(modelName),
          schema: FileReviewResultSchema,
          prompt,
        });

        if (object.violations && object.violations.length > 0) {
          allViolations.push(...object.violations);
          fileSpinner.warn(
            chalk.yellow(`${progressLabel} ${fileDiff.file} ➔ Ditemukan ${object.violations.length} pelanggaran`)
          );
        } else {
          fileSpinner.succeed(chalk.gray(`${progressLabel} ${fileDiff.file} ➔ Bersih (Clean)`));
        }

        if (object.notes && object.notes.length > 0) {
          generalFeedback.push(...object.notes);
        }
      } catch (err: any) {
        fileSpinner.fail(chalk.red(`${progressLabel} ${fileDiff.file} ➔ Gagal dianalisis: ${err.message}`));
      }
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
