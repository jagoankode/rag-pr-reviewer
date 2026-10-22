import chalk from 'chalk';
import ora from 'ora';
import { generateObject } from 'ai';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { annotateDiffWithLineNumbers } from '../core/diff-parser.js';
import { searchRelevantGuidelines } from '../core/db.js';
import { buildLineReviewPrompt } from '../core/prompt.js';
import { getActiveAIProvider } from '../core/config.js';
import { saveReviewReport } from '../core/history.js';
import { PRReviewResultSchema, PRReviewResult } from '../core/schema.js';

export interface ReviewOptions {
  staged?: boolean;
  branch?: string;
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
    process.exit(1);
  }

  const spinner = ora(chalk.blue('Mengambil git diff...')).start();

  try {
    const rawDiff = await getGitDiff({
      staged: options.staged,
      branch: options.branch,
    });

    if (!rawDiff || rawDiff.trim().length === 0) {
      spinner.info(
        chalk.yellow(
          options.staged
            ? 'Tidak ada perubahan staged (git diff --staged kosong).'
            : 'Tidak ada perubahan yang terdeteksi (git diff kosong).'
        )
      );
      return;
    }

    spinner.text = chalk.cyan('Mem-parse diff dan mapping nomor baris...');
    const { annotatedText, files } = annotateDiffWithLineNumbers(rawDiff);

    spinner.text = chalk.cyan(`Mencari aturan coding terkait dari LanceDB (${files.length} file diubah)...`);
    let relevantRules: string[] = [];
    try {
      const chunks = await searchRelevantGuidelines(rawDiff, options.limit || 7);
      relevantRules = chunks.map((c) => `[Source: ${c.title}]\n${c.content}`);
      if (relevantRules.length > 0) {
        spinner.info(chalk.gray(`Ditemukan ${relevantRules.length} guideline yang relevan.`));
      } else {
        spinner.info(chalk.gray('Belum ada guideline yang di-ingest, mereview dengan standar umum.'));
      }
    } catch {
      spinner.info(chalk.gray('Vector store belum diinisialisasi atau kosong. Melanjutkan review umum.'));
    }

    const { client, config } = await getActiveAIProvider();
    const modelName = options.model || config.defaultModel || 'gpt-4o';
    spinner.start(chalk.magenta(`Menganalisis pelanggaran baris per baris via AI (${modelName})...`));

    const prompt = buildLineReviewPrompt(annotatedText, relevantRules);

    const { object: reviewResult } = await generateObject({
      model: client(modelName),
      schema: PRReviewResultSchema,
      prompt: prompt,
    });

    spinner.succeed(chalk.green(`Review selesai! Ditemukan ${reviewResult.violations.length} pelanggaran.\n`));

    if (options.json) {
      console.log(JSON.stringify(reviewResult, null, 2));
      return reviewResult;
    }

    printReviewTerminalReport(reviewResult);

    // Simpan report history markdown secara default (kecuali opsi json)
    if (options.saveReport !== false) {
      try {
        const savedPath = await saveReviewReport(reviewResult, {
          branch: options.branch,
          staged: options.staged,
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
    process.exit(1);
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
    console.log(chalk.green('✔ Tidak ditemukan pelanggaran code convention pada baris yang diubah!'));
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
