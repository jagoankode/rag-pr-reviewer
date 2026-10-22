import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '@inquirer/prompts';
import { ingestCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { isGitRepo } from '../core/git.js';
import { loadConfig, saveConfig, AppConfig } from '../core/config.js';

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
    const config = await loadConfig();

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
          name: `🤖 Configure AI Provider (${chalk.cyan(config.provider)})`,
          value: 'config_ai',
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

    if (choice === 'config_ai') {
      await configureAIProviderUI(config);
    } else if (choice === 'ingest') {
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

      const defaultModel = config.defaultModel || 'gpt-4o';
      const model = await select<string>({
        message: 'Pilih model LLM untuk review:',
        choices: [
          { name: `⚡ ${defaultModel} (Default Provider Model)`, value: defaultModel },
          { name: '🧠 gpt-4o-mini', value: 'gpt-4o-mini' },
          { name: '🧪 Custom Model (ketik manual)', value: 'custom' },
        ],
      });

      let selectedModel: string = model;
      if (model === 'custom') {
        selectedModel = await input({
          message: 'Nama model AI:',
          default: defaultModel,
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
      console.log(`AI Provider     : ${chalk.bold.magenta(config.provider)}`);
      console.log(`Base URL        : ${config.baseUrl || chalk.gray('(Default OpenAI)')}`);
      console.log(`Default Model   : ${chalk.cyan(config.defaultModel)}`);
      console.log(`API Key Status  : ${config.apiKey || process.env.OPENAI_API_KEY ? chalk.green('Configured ✅') : chalk.red('Missing ❌')}`);
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

async function configureAIProviderUI(currentConfig: AppConfig) {
  console.log(chalk.bold.cyan('\n⚙️  Pengaturan AI Provider & API Key'));

  const provider = await select<AppConfig['provider']>({
    message: 'Pilih AI Provider:',
    choices: [
      { name: '🌐 9router (Multi-model Gateway / ag/*)', value: '9router' },
      { name: '🟢 OpenAI Official (gpt-4o, o3, etc.)', value: 'openai' },
      { name: '🌌 OpenRouter (OpenRouter API)', value: 'openrouter' },
      { name: '💻 Ollama (Local Self-hosted)', value: 'ollama' },
      { name: '🛠️  Custom OpenAI-Compatible Provider', value: 'custom' },
    ],
  });

  let baseUrl = '';
  let defaultModel = 'gpt-4o';
  let embeddingModel = 'text-embedding-3-small';

  if (provider === '9router') {
    baseUrl = await input({
      message: '9router Base URL:',
      default: currentConfig.baseUrl || 'https://api.9router.com/v1',
    });
    defaultModel = await input({
      message: 'Default Model (contoh: ag/gemini-3.8-flash, ag/gpt-4o):',
      default: currentConfig.defaultModel || 'ag/gemini-3.8-flash',
    });
    embeddingModel = await input({
      message: 'Embedding Model (untuk LanceDB RAG):',
      default: currentConfig.embeddingModel || 'text-embedding-3-small',
    });
  } else if (provider === 'openai') {
    baseUrl = '';
    defaultModel = await input({
      message: 'Default Model:',
      default: currentConfig.defaultModel || 'gpt-4o',
    });
    embeddingModel = 'text-embedding-3-small';
  } else if (provider === 'openrouter') {
    baseUrl = 'https://openrouter.ai/api/v1';
    defaultModel = await input({
      message: 'Default Model (contoh: anthropic/claude-3.5-sonnet, openai/gpt-4o):',
      default: currentConfig.defaultModel || 'openai/gpt-4o',
    });
    embeddingModel = await input({
      message: 'Embedding Model:',
      default: currentConfig.embeddingModel || 'text-embedding-3-small',
    });
  } else if (provider === 'ollama') {
    baseUrl = await input({
      message: 'Ollama Base URL:',
      default: currentConfig.baseUrl || 'http://localhost:11434/v1',
    });
    defaultModel = await input({
      message: 'Ollama Model:',
      default: currentConfig.defaultModel || 'qwen2.5-coder',
    });
    embeddingModel = await input({
      message: 'Ollama Embedding Model:',
      default: currentConfig.embeddingModel || 'nomic-embed-text',
    });
  } else if (provider === 'custom') {
    baseUrl = await input({
      message: 'Custom Base URL:',
      default: currentConfig.baseUrl || 'https://api.example.com/v1',
    });
    defaultModel = await input({
      message: 'Default Model:',
      default: currentConfig.defaultModel || 'gpt-4o',
    });
    embeddingModel = await input({
      message: 'Embedding Model:',
      default: currentConfig.embeddingModel || 'text-embedding-3-small',
    });
  }

  let apiKey = '';
  if (provider !== 'ollama') {
    apiKey = await password({
      message: `Masukkan API Key untuk ${provider} (kosongkan jika tidak ingin mengubah):`,
      mask: '*',
    });
    if (!apiKey) {
      apiKey = currentConfig.apiKey;
    }
  }

  const newConfig: AppConfig = {
    provider,
    apiKey,
    baseUrl,
    defaultModel,
    embeddingModel,
  };

  await saveConfig(newConfig);
  console.log(chalk.green(`\n✔ Konfigurasi AI Provider (${provider}) berhasil disimpan ke ~/.pr-rag/config.json!\n`));
}
