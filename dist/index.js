#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Matikan deprecation & schema warning internal AI SDK agar terminal tetap bersih
process.env.AI_SDK_LOG_WARNINGS = 'false';
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const dotenv_1 = __importDefault(require("dotenv"));
const nav_js_1 = require("./core/nav.js");
const ingest_js_1 = require("./commands/ingest.js");
const review_js_1 = require("./commands/review.js");
const learn_js_1 = require("./commands/learn.js");
const tui_js_1 = require("./commands/tui.js");
const version_js_1 = require("./core/version.js");
dotenv_1.default.config();
(0, nav_js_1.initNavigationGuard)();
const program = new commander_1.Command();
program
    .name('lumio')
    .description(chalk_1.default.cyan('✨ Lumio — AI-Powered PR Reviewer & Centralized Knowledge Engine'))
    .version((0, version_js_1.getAppVersion)(), '-v, --version', 'Tampilkan versi Lumio yang terinstall')
    .action(async () => {
    await (0, tui_js_1.runInteractiveTUI)();
});
program
    .command('ui')
    .description('Launch the interactive Terminal User Interface (TUI)')
    .action(async () => {
    await (0, tui_js_1.runInteractiveTUI)();
});
program
    .command('learn')
    .description('Learn conventions from a local feature folder or route path (hulu-ke-hilir)')
    .argument('<path>', 'Path to local folder/route containing code (e.g. ./src/features/payment or src/routes/users)')
    .action(async (pathArg) => {
    await (0, learn_js_1.learnFeatureCommand)(pathArg);
});
program
    .command('ingest')
    .description('Ingest markdown guidelines/coding standards into vector DB')
    .argument('<path>', 'Path to file or folder containing markdown guidelines')
    .action(async (pathArg) => {
    await (0, ingest_js_1.ingestCommand)(pathArg);
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
    await (0, review_js_1.reviewCommand)({
        ...options,
        fetchRemote: options.fetch,
        saveReport: options.save !== false,
    });
});
program
    .command('history')
    .description('View saved review reports history')
    .action(async () => {
    await (0, tui_js_1.runInteractiveTUI)();
});
program.parse(process.argv);
