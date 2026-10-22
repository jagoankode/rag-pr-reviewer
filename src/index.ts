import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { ingestCommand } from './commands/ingest.js';
import { reviewCommand } from './commands/review.js';
import { postPRReviewToGitHub } from './core/github.js';

dotenv.config();

const program = new Command();

program
  .name('pr-rag')
  .description(chalk.cyan('AI-powered Pull Request reviewer using local embedded RAG (LanceDB) & Line-by-Line Convention Audit'))
  .version('1.1.0');

program
  .command('ingest')
  .description('Ingest markdown guidelines/coding standards into local vector DB')
  .argument('<path>', 'Path to file or folder containing markdown guidelines')
  .action(async (pathArg) => {
    await ingestCommand(pathArg);
  });

program
  .command('review')
  .description('Review git changes with RAG-enhanced AI and pinpoint exact line violations')
  .option('-s, --staged', 'Review only staged changes')
  .option('-b, --branch <branch>', 'Review diff against a specific git branch (e.g. main)')
  .option('-m, --model <model>', 'LLM model to use (default: gpt-4o)', 'gpt-4o')
  .option('-l, --limit <number>', 'Number of relevant guidelines to retrieve', (val) => parseInt(val, 10), 7)
  .option('--json', 'Output review result as raw JSON')
  .option('--post-github', 'Post comments directly to GitHub PR (requires GITHUB_TOKEN)')
  .option('--repo <owner/repo>', 'GitHub repo name (e.g. jagoankode/rag-pr-reviewer)')
  .option('--pr <number>', 'GitHub Pull Request number', (val) => parseInt(val, 10))
  .option('--commit <hash>', 'Target commit SHA for GitHub PR review')
  .action(async (options) => {
    const result = await reviewCommand(options);

    if (options.postGithub && result) {
      if (!options.repo || !options.pr || !options.commit) {
        console.error(chalk.red('Error: --repo, --pr, dan --commit wajib diisi jika menggunakan --post-github!'));
        process.exit(1);
      }
      const [owner, repoName] = options.repo.split('/');
      await postPRReviewToGitHub(result, {
        owner,
        repo: repoName,
        pullNumber: options.pr,
        commitId: options.commit,
      });
    }
  });

program.parse(process.argv);

