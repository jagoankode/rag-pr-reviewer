import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm } from '@inquirer/prompts';
import { ingestCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { isGitRepo } from '../core/git.js';

export async function runInteractiveTUI() {
  console.clear();

  const banner = boxen(
    `${chalk.bold.cyan('🧪 RAG PR Reviewer')}\n${chalk.gray(
      'Embedded Local AI Code Review & Convention Auditor'
    )}`,
    {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      textAlignment: 'center',
    }
  );

  console.log(banner);

  const inRepo = await isGitRepo();
  if (!inRepo) {
    console.log(chalk.yellow('⚠️  Perhatian: Direktori saat ini bukan git repository. Opsi review hanya bisa dijalankan di git repo.\n'));
  }

  while (true) {
    const choice = await select({
      message: 'Pilih aksi yang ingin dijalankan:',
      choices: [
        {
          name: '🔍 Review Git Changes (Local RAG Review)',
          value: 'review',
          disabled: !inRepo ? '(Bukan git repo)' : false,
        },
        {
          name: '📚 Ingest Guidelines / Conventions ke Vector DB',
          value: 'ingest',
        },
        {
          name: '⚙️  Check Status & Config',
          value: 'status',
        },
        {
          name: '🚪 Keluar',
          value: 'exit',
        },
      ],
    });

    if (choice === 'exit') {
      console.log(chalk.gray('\nSampai jumpa, Bos! 👋\n'));
      process.exit(0);
    }

    if (choice === 'ingest') {
      const docPath = await input({
        message: 'Masukkan path file/folder panduan markdown:',
        default: './docs',
        validate: (val) => (val.trim().length > 0 ? true : 'Path tidak boleh kosong'),
      });

      console.log('');
      await ingestCommand(docPath);
      console.log('');
    } else if (choice === 'review') {
      const diffType = await select({
        message: 'Pilih jenis perubahan yang mau di-review:',
        choices: [
          { name: '📝 Uncommitted changes (Semua perubahan lokal)', value: 'uncommitted' },
          { name: '📦 Staged changes only (yang sudah di git add)', value: 'staged' },
          { name: '🌿 Compare branch (misal: vs main)', value: 'branch' },
        ],
      });

      let branchName: string | undefined = undefined;
      if (diffType === 'branch') {
        branchName = await input({
          message: 'Target branch pembanding:',
          default: 'main',
        });
      }

      const model = await select<string>({
        message: 'Pilih model LLM untuk review:',
        choices: [
          { name: '⚡ gpt-4o (Direkomendasikan - Cepat & Akurat)', value: 'gpt-4o' },
          { name: '🧠 gpt-4o-mini (Hemat token)', value: 'gpt-4o-mini' },
          { name: '🧪 Custom Model (masukkan manual)', value: 'custom' },
        ],
      });

      let selectedModel: string = model;
      if (model === 'custom') {
        selectedModel = await input({
          message: 'Nama model OpenAI/kompatibel:',
          default: 'gpt-4o',
        });
      }

      console.log('');
      await reviewCommand({
        staged: diffType === 'staged',
        branch: branchName,
        model: selectedModel,
      });
      console.log('');
    } else if (choice === 'status') {
      console.log(chalk.cyan('\n─── Status RAG Reviewer ───'));
      console.log(`Git Repo Active : ${inRepo ? chalk.green('Yes') : chalk.red('No')}`);
      console.log(`Vector DB Path  : ${chalk.yellow('~/.pr-rag/db')}`);
      console.log(`OpenAI API Key  : ${process.env.OPENAI_API_KEY ? chalk.green('Configured ✅') : chalk.red('Missing ❌')}`);
      console.log(chalk.cyan('───────────────────────────\n'));
    }

    const again = await confirm({
      message: 'Ingin melakukan aksi lain?',
      default: true,
    });

    if (!again) {
      console.log(chalk.gray('\nSampai jumpa, Bos! 👋\n'));
      break;
    }
    console.clear();
    console.log(banner);
  }
}
