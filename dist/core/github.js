"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postPRReviewToGitHub = postPRReviewToGitHub;
const rest_1 = require("@octokit/rest");
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
/**
 * Memposting review comments ke GitHub PR secara langsung per baris kode
 */
async function postPRReviewToGitHub(reviewResult, options) {
    const token = options.token || process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN environment variable atau --token wajib disediakan untuk post ke GitHub PR.');
    }
    const octokit = new rest_1.Octokit({ auth: token });
    const spinner = (0, ora_1.default)(chalk_1.default.blue(`Memposting review ke GitHub PR #${options.pullNumber}...`)).start();
    try {
        const comments = reviewResult.violations.map((v) => ({
            path: v.file,
            line: v.line,
            side: 'RIGHT',
            body: `**[${v.severity.toUpperCase()}] Rule Violation:** \`${v.rule}\`\n\n${v.comment}${v.suggestedFix ? `\n\n\`\`\`suggestion\n${v.suggestedFix}\n\`\`\`` : ''}`,
        }));
        const event = reviewResult.status === 'APPROVE'
            ? 'APPROVE'
            : reviewResult.status === 'REQUEST_CHANGES'
                ? 'REQUEST_CHANGES'
                : 'COMMENT';
        await octokit.pulls.createReview({
            owner: options.owner,
            repo: options.repo,
            pull_number: options.pullNumber,
            commit_id: options.commitId,
            body: `### 🤖 RAG PR Review Summary\n\n${reviewResult.summary}\n\n*Status:* **${reviewResult.status}**`,
            event: event,
            comments: comments,
        });
        spinner.succeed(chalk_1.default.green(`Berhasil memposting ${comments.length} inline line-by-line comment ke GitHub PR!`));
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Gagal memposting ke GitHub PR: ${error.message}`));
        throw error;
    }
}
