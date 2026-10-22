import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { ingestCommand } from './commands/ingest.js';
import { reviewCommand } from './commands/review.js';

dotenv.config();

const program = new Command();

program
  .name('pr-rag')
  .description(chalk.cyan('AI-powered Pull Request reviewer using local embedded RAG (LanceDB)'))
  .version('1.0.0');

program
  .command('ingest')
  .description('Ingest markdown guidelines/coding standards into local vector DB')
  .argument('<path>', 'Path to file or folder containing markdown guidelines')
  .action(async (pathArg) => {
    await ingestCommand(pathArg);
  });

program
  .command('review')
  .description('Review local git changes or branch diff with RAG-enhanced AI')
  .option('-s, --staged', 'Review only staged changes')
  .option('-b, --branch <branch>', 'Review diff against a specific git branch (e.g. main)')
  .option('-m, --model <model>', 'LLM model to use (default: gpt-4o)', 'gpt-4o')
  .option('-l, --limit <number>', 'Number of relevant guidelines to retrieve', (val) => parseInt(val, 10), 5)
  .action(async (options) => {
    await reviewCommand(options);
  });

program.parse(process.argv);
