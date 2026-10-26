#!/usr/bin/env node
// Matikan deprecation & schema warning internal AI SDK agar terminal tetap bersih
process.env.AI_SDK_LOG_WARNINGS = 'false';

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { initNavigationGuard } from './core/nav.js';
import { ingestCommand } from './commands/ingest.js';
import { reviewCommand } from './commands/review.js';
import { rulesCompileCommand } from './commands/rules.js';
import { learnFeatureCommand } from './commands/learn.js';
import { runInteractiveTUI } from './commands/tui.js';
import { getAppVersion } from './core/version.js';
import { checkAndUpgradeApp, syncGuidelinesRules } from './core/updater.js';

dotenv.config();
initNavigationGuard();

const program = new Command();

program
  .name('lumio')
  .description(chalk.cyan('✨ Lumio — AI-Powered PR Reviewer & Centralized Knowledge Engine'))
  .version(getAppVersion(), '-v, --version', 'Tampilkan versi Lumio yang terinstall')
  .action(async () => {
    // Tier 1: Check App Upgrade saat lumio dipanggil
    await checkAndUpgradeApp();
    // Warm-up & sync rules cache di background
    syncGuidelinesRules({ quiet: true }).catch(() => {});
    await runInteractiveTUI();
  });

program
  .command('ui')
  .description('Launch the interactive Terminal User Interface (TUI)')
  .action(async () => {
    await checkAndUpgradeApp();
    syncGuidelinesRules({ quiet: true }).catch(() => {});
    await runInteractiveTUI();
  });

program
  .command('sync')
  .description('Force check & update guidelines rules from server Qdrant')
  .action(async () => {
    console.log(chalk.cyan('🔍 Checking guidelines revision from server...'));
    const rules = await syncGuidelinesRules({ force: true, quiet: false });
    console.log(chalk.green(`✔ Sync selesai! Total ${rules.length} aturan aktif di cache lokal.`));
  });

program
  .command('upgrade')
  .description('Check and upgrade Lumio app to latest release')
  .action(async () => {
    const upgraded = await checkAndUpgradeApp(false);
    if (!upgraded) {
      console.log(chalk.green(`✔ Lumio sudah versi paling baru (v${getAppVersion()}).`));
    }
  });

program
  .command('learn')
  .description('Learn conventions from a local feature folder or route path (hulu-ke-hilir)')
  .argument('<path>', 'Path to local folder/route containing code (e.g. ./src/features/payment or src/routes/users)')
  .action(async (pathArg) => {
    await checkAndUpgradeApp();
    await learnFeatureCommand(pathArg);
  });

program
  .command('ingest')
  .description('Ingest markdown guidelines/coding standards into vector DB')
  .argument('<path>', 'Path to file or folder containing markdown guidelines')
  .action(async (pathArg) => {
    await checkAndUpgradeApp();
    await ingestCommand(pathArg);
  });

const rules = program
  .command('rules')
  .description('Manage the machine-checkable part of the rules in the database');

rules
  .command('compile')
  .description('Draft `checks` from rule text with AI, try them on code, and save them after approval (admin)')
  .option('-r, --rule <ids...>', 'Rule ids or title fragments (default: every non-meta rule without checks)')
  .option('--force', 'Also redraft rules that already have checks')
  .option('-m, --model <model>', 'LLM model to use (default: the active model set in the TUI)')
  .option('--lang <language>', 'Language for check messages: id | en (default: en, like AI review comments)')
  .option('--try <path>', 'Try the drafts on the files in this folder before approval')
  .option('-o, --out <file>', 'Write the drafts to a JSON file for review instead of saving')
  .option('--from <file>', 'Save drafts from a reviewed JSON file (no AI call)')
  .option('-y, --yes', 'Save without asking')
  .action(async (options) => {
    if (options.lang && !['id', 'en'].includes(options.lang)) {
      console.error(chalk.red('--lang harus id atau en'));
      process.exit(1);
    }
    try {
      await rulesCompileCommand({ ...options, language: options.lang });
    } catch (error: any) {
      console.error(chalk.red(`✖ ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('review')
  .description('Review git changes against team rules and pinpoint exact line violations')
  .option('-s, --staged', 'Review only staged changes')
  .option('-b, --branch <branch>', 'Review diff against a specific git branch (legacy alias for --target)')
  .option('--source <branch>', 'Source / feature branch to review (e.g. feature-x or origin/feature-x)')
  .option('--target <branch>', 'Target / base branch to compare against (e.g. main or origin/main)')
  .option('--fetch', 'Fetch remote branches before comparing (git fetch --all)')
  .option('--scope <scope>', 'full = audit whole changed files, diff = only added lines', 'full')
  .option('-m, --model <model>', 'LLM model to use (default: the active model set in the TUI)')
  .option('--concurrency <number>', 'Files audited by AI in parallel', (val) => parseInt(val, 10), 4)
  .option('--no-save', 'Disable saving review report to markdown in .lumio-reviews/')
  .option('--output-dir <path>', 'Custom directory to save markdown reports (default: .lumio-reviews)')
  .option('--json', 'Output review result as raw JSON')
  .option('--core-only', 'Run deterministic rule checkers only (fast, no AI)')
  .option('--fail-on <level>', 'Exit with code 1 when findings reach this level: error | warning | never', 'error')
  .option('--max-violations <number>', 'Batas maksimal temuan sebelum review berhenti & generate report', (val) => parseInt(val, 10))
  .action(async (options) => {
    if (!['full', 'diff'].includes(options.scope)) {
      console.error(chalk.red(`--scope harus 'full' atau 'diff', bukan '${options.scope}'.`));
      process.exit(2);
    }
    // Tier 1: Check App Version
    await checkAndUpgradeApp(!!options.json, 2);
    // Tier 2: Real-time Check Guidelines Revision sebelum review berjalan
    await syncGuidelinesRules({ quiet: !!options.json });

    const result = await reviewCommand({
      ...options,
      fetchRemote: options.fetch,
      saveReport: options.save !== false,
    });
    // Non-zero exit lets the review gate a git hook or CI step.
    if (!result) process.exitCode = 2;
    else if (options.failOn === 'warning' && result.status !== 'APPROVE') process.exitCode = 1;
    else if (options.failOn === 'error' && result.status === 'REQUEST_CHANGES') process.exitCode = 1;
  });

program
  .command('history')
  .description('View saved review reports history')
  .action(async () => {
    await runInteractiveTUI();
  });

program.parse(process.argv);
