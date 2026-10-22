import chalk from 'chalk';
import ora from 'ora';
import { marked } from 'marked';
import { MarkedTerminal } from 'marked-terminal';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { isGitRepo, getGitDiff } from '../core/git.js';
import { searchRelevantGuidelines } from '../core/db.js';
import { buildReviewPrompt } from '../core/prompt.js';

// Setup markdown renderer untuk terminal
marked.setOptions({
  // @ts-ignore
  renderer: new MarkedTerminal(),
});

export interface ReviewOptions {
  staged?: boolean;
  branch?: string;
  model?: string;
  limit?: number;
}

export async function reviewCommand(options: ReviewOptions) {
  const isRepo = await isGitRepo();
  if (!isRepo) {
    console.error(chalk.red('Error: Perintah harus dijalankan di dalam git repository!'));
    process.exit(1);
  }

  const spinner = ora(chalk.blue('Mengambil git diff...')).start();

  try {
    const diff = await getGitDiff({
      staged: options.staged,
      branch: options.branch,
    });

    if (!diff || diff.trim().length === 0) {
      spinner.info(
        chalk.yellow(
          options.staged
            ? 'Tidak ada perubahan staged (git diff --staged kosong).'
            : 'Tidak ada perubahan yang terdeteksi (git diff kosong).'
        )
      );
      return;
    }

    spinner.text = chalk.cyan('Mencari aturan coding & context arsitektur terkait dari LanceDB...');
    let relevantRules: string[] = [];
    try {
      const chunks = await searchRelevantGuidelines(diff, options.limit || 5);
      relevantRules = chunks.map(
        (c) => `[Source: ${c.title}]\n${c.content}`
      );
      if (relevantRules.length > 0) {
        spinner.info(chalk.gray(`Menemukan ${relevantRules.length} guideline yang relevan.`));
      } else {
        spinner.info(chalk.gray('Belum ada guideline yang di-ingest, mereview dengan standar umum.'));
      }
    } catch {
      spinner.info(chalk.gray('Vector store belum diinisialisasi atau kosong. Melanjutkan review umum.'));
    }

    const modelName = options.model || 'gpt-4o';
    spinner.start(chalk.magenta(`Menganalisis diff dengan AI (${modelName})...`));

    const prompt = buildReviewPrompt(diff, relevantRules);

    const { text } = await generateText({
      model: openai(modelName),
      prompt: prompt,
    });

    spinner.succeed(chalk.green('Review selesai!\n'));

    console.log(chalk.bold.cyan('═════════════════════ RAG PR REVIEW RESULT ═════════════════════\n'));
    console.log(marked(text));
    console.log(chalk.bold.cyan('════════════════════════════════════════════════════════════════\n'));
  } catch (error: any) {
    spinner.fail(chalk.red(`Review gagal: ${error.message}`));
    process.exit(1);
  }
}
