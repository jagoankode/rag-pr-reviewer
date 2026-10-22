import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import ora from 'ora';
import { PRReviewResult } from './schema.js';

export interface GitHubPostOptions {
  token?: string;
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
}

/**
 * Memposting review comments ke GitHub PR secara langsung per baris kode
 */
export async function postPRReviewToGitHub(
  reviewResult: PRReviewResult,
  options: GitHubPostOptions
) {
  const token = options.token || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable atau --token wajib disediakan untuk post ke GitHub PR.');
  }

  const octokit = new Octokit({ auth: token });
  const spinner = ora(chalk.blue(`Memposting review ke GitHub PR #${options.pullNumber}...`)).start();

  try {
    const comments = reviewResult.violations.map((v) => ({
      path: v.file,
      line: v.line,
      side: 'RIGHT' as const,
      body: `**[${v.severity.toUpperCase()}] Rule Violation:** \`${v.rule}\`\n\n${v.comment}${
        v.suggestedFix ? `\n\n\`\`\`suggestion\n${v.suggestedFix}\n\`\`\`` : ''
      }`,
    }));

    const event =
      reviewResult.status === 'APPROVE'
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

    spinner.succeed(chalk.green(`Berhasil memposting ${comments.length} inline line-by-line comment ke GitHub PR!`));
  } catch (error: any) {
    spinner.fail(chalk.red(`Gagal memposting ke GitHub PR: ${error.message}`));
    throw error;
  }
}
