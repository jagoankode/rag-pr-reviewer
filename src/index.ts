#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { ingestCommand } from './commands/ingest.js';
import { reviewCommand } from './commands/review.js';
import { runInteractiveTUI } from './commands/tui.js';

dotenv.config();

const program = new Command();

program
  .name('pr-rag')
  .description(chalk.cyan('AI-powered local Pull Request reviewer using embedded RAG (LanceDB) & Line-by-Line Convention Audit'))
  .version('1.2.0')
  .action(async () => {
    // Jalankan mode interaktif TUI jika dipanggil tanpa sub-perintah (cth: `pr-rag` langsung)
    await runInteractiveTUI();
  });

program
  .command('ui')
  .description('Launch the interactive Terminal User Interface (TUI)')
  .action(async () => {
    await runInteractiveTUI();
  });

program
  .command('ingest')
  .description('Ingest markdown guidelines/coding standards into local vector DB')
  .argument('<path>', 'Path to file or folder containing markdown guidelines')
  .action(async (pathArg) => {
    await ingestCommand(pathArg);
  });

program
  .command('review')
  .description('Review local git changes with RAG-enhanced AI and pinpoint exact line violations')
  .option('-s, --staged', 'Review only staged changes')
  .option('-b, --branch <branch>', 'Review diff against a specific git branch (e.g. main)')
  .option('-m, --model <model>', 'LLM model to use (default: gpt-4o)', 'gpt-4o')
  .option('-l, --limit <number>', 'Number of relevant guidelines to retrieve', (val) => parseInt(val, 10), 7)
  .option('--json', 'Output review result as raw JSON')
  .action(async (options) => {
    await reviewCommand(options);
  });

program.parse(process.argv);

