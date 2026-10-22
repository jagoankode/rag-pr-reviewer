#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const dotenv_1 = __importDefault(require("dotenv"));
const ingest_js_1 = require("./commands/ingest.js");
const review_js_1 = require("./commands/review.js");
const tui_js_1 = require("./commands/tui.js");
dotenv_1.default.config();
const program = new commander_1.Command();
program
    .name('pr-rag')
    .description(chalk_1.default.cyan('AI-powered local Pull Request reviewer using embedded RAG (LanceDB) & Line-by-Line Convention Audit'))
    .version('1.3.0')
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
    .command('ingest')
    .description('Ingest markdown guidelines/coding standards into local vector DB')
    .argument('<path>', 'Path to file or folder containing markdown guidelines')
    .action(async (pathArg) => {
    await (0, ingest_js_1.ingestCommand)(pathArg);
});
program
    .command('review')
    .description('Review git changes with RAG-enhanced AI and pinpoint exact line violations')
    .option('-s, --staged', 'Review only staged changes')
    .option('-b, --branch <branch>', 'Review diff against a specific git branch (legacy alias for --target)')
    .option('--source <branch>', 'Source / feature branch to review (e.g. feature-x or origin/feature-x)')
    .option('--target <branch>', 'Target / base branch to compare against (e.g. main or origin/main)')
    .option('--fetch', 'Fetch remote branches before comparing (git fetch --all)')
    .option('-m, --model <model>', 'LLM model to use (default: config model or ag/gemini-3.8-flash)')
    .option('-l, --limit <number>', 'Number of relevant guidelines to retrieve', (val) => parseInt(val, 10), 7)
    .option('--no-save', 'Disable saving review report to markdown in .rag-reviews/')
    .option('--output-dir <path>', 'Custom directory to save markdown reports (default: .rag-reviews)')
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
