#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { ingestCommand } from './commands/ingest.js';
import { reviewCommand } from './commands/review.js';
import { learnFeatureCommand } from './commands/learn.js';
import { runInteractiveTUI } from './commands/tui.js';
import { getAppVersion } from './core/version.js';

dotenv.config();

const program = new Command();

program
  .name('lumio')
  .description(chalk.cyan('✨ Lumio — AI-Powered PR Reviewer & Centralized Knowledge Engine'))
  .version(getAppVersion(), '-v, --version', 'Tampilkan versi Lumio yang terinstall')
  .action(async () => {
    await runInteractiveTUI();
  });

program
  .command('ui')
  .description('Launch the interactive Terminal User Interface (TUI)')
  .action(async () => {
    await runInteractiveTUI();
  });

program
  .command('learn')
  .description('Learn conventions from a local feature folder or route path (hulu-ke-hilir)')
  .argument('<path>', 'Path to local folder/route containing code (e.g. ./src/features/payment or src/routes/users)')
  .action(async (pathArg) => {
    await learnFeatureCommand(pathArg);
  });

program
  .command('ingest')
  .description('Ingest markdown guidelines/coding standards into vector DB')
  .argument('<path>', 'Path to file or folder containing markdown guidelines')
  .action(async (pathArg) => {
    await ingestCommand(pathArg);
  });

program
  .command('review')
  .description('Review git changes with AI and pinpoint exact line violations')
  .option('-s, --staged', 'Review only staged changes')
  .option('-b, --branch <branch>', 'Review diff against a specific git branch (legacy alias for --target)')
  .option('--source <branch>', 'Source / feature branch to review (e.g. feature-x or origin/feature-x)')
  .option('--target <branch>', 'Target / base branch to compare against (e.g. main or origin/main)')
  .option('--fetch', 'Fetch remote branches before comparing (git fetch --all)')
  .option('-m, --model <model>', 'LLM model to use (default: config model or ag/gemini-3.8-flash)')
  .option('-l, --limit <number>', 'Number of relevant guidelines to retrieve', (val) => parseInt(val, 10), 7)
  .option('--no-save', 'Disable saving review report to markdown in .lumio-reviews/')
  .option('--output-dir <path>', 'Custom directory to save markdown reports (default: .lumio-reviews)')
  .option('--json', 'Output review result as raw JSON')
  .action(async (options) => {
    await reviewCommand({
      ...options,
      fetchRemote: options.fetch,
      saveReport: options.save !== false,
    });
  });

program
  .command('history')
  .description('View saved review reports history')
  .action(async () => {
    await runInteractiveTUI();
  });

program.parse(process.argv);
