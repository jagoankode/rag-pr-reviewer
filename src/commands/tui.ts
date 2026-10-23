import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '@inquirer/prompts';
import { ingestCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { inspectGuidelinesCommand } from './guidelines.js';
import { isGitRepo, getAvailableBranches, getCurrentBranch } from '../core/git.js';
import { loadConfig, saveConfig, AppConfig } from '../core/config.js';
import { listSavedReports, resolveReportDir, deleteReportFile, clearAllReports } from '../core/history.js';
import { marked } from 'marked';
import { promises as fs } from 'fs';

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
          name: '🔍 Review Git Changes / PR Branch (Source vs Target)',
          value: 'review',
          disabled: !inRepo ? '(Bukan git repo)' : false,
        },
        {
          name: '📖 Inspect Active Rules (Lihat Aturan yang Tersimpan di RAG)',
          value: 'inspect_rules',
        },
        {
          name: '📚 Ingest Guidelines / Conventions ke Vector DB',
          value: 'ingest',
        },
        {
          name: '📜 View & Manage Review History (Buka / Hapus Report)',
          value: 'history',
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

    if (choice === 'inspect_rules') {
      await inspectGuidelinesCommand();
    } else if (choice === 'config_ai') {
      await configureAIProviderUI(config);
    } else if (choice === 'history') {
      await viewHistoryUI(config.defaultReportDir || '.rag-reviews');
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
      const currentBranch = await getCurrentBranch();

      const diffType = await select({
        message: 'Pilih mode review git yang diinginkan:',
        choices: [
          {
            name: `🔀 PR Branch Review (Source Branch ⟵ Target / Origin)`,
            value: 'pr_branches',
          },
          {
            name: '📝 Uncommitted changes (Semua perubahan lokal yang belum di-commit)',
            value: 'uncommitted',
          },
          {
            name: '📦 Staged changes only (Perubahan yang sudah di git add)',
            value: 'staged',
          },
        ],
      });

      let targetBranch: string | undefined = undefined;
      let sourceBranch: string | undefined = undefined;
      let doFetch = false;

      if (diffType === 'pr_branches') {
        doFetch = await confirm({
          message: 'Fetch branch remote terbaru dari origin terlebih dahulu (git fetch --all)?',
          default: true,
        });

        const { local, remote } = await getAvailableBranches();
        const allBranches = Array.from(new Set([...local, ...remote]));

        const defaultTarget = allBranches.includes('origin/main')
          ? 'origin/main'
          : allBranches.includes('main')
          ? 'main'
          : 'origin/master';

        targetBranch = await input({
          message: 'Target/Base Branch (tujuan PR, misal: origin/main, main, develop):',
          default: defaultTarget,
          validate: (val) => (val.trim().length > 0 ? true : 'Target branch tidak boleh kosong'),
        });

        const defaultSource = currentBranch !== 'HEAD' ? currentBranch : (allBranches[0] || 'HEAD');
        sourceBranch = await input({
          message: 'Source/Feature Branch (cabang yang mau direview, misal: feature-a, origin/feature-a):',
          default: defaultSource,
          validate: (val) => (val.trim().length > 0 ? true : 'Source branch tidak boleh kosong'),
        });
      }

      // Konfigurasi output directory penyimpanan report markdown
      const defaultDir = config.defaultReportDir || '.rag-reviews';
      const outputDir = await input({
        message: 'Folder penyimpanan laporan Markdown review:',
        default: defaultDir,
        validate: (val) => (val.trim().length > 0 ? true : 'Folder tidak boleh kosong'),
      });

      const defaultModel = config.defaultModel || 'ag/gemini-3.8-flash';
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
        target: targetBranch,
        source: sourceBranch,
        fetchRemote: doFetch,
        model: selectedModel,
        outputDir: outputDir,
        saveReport: true,
      });
      console.log('');
    } else if (choice === 'status') {
      const currentBranch = inRepo ? await getCurrentBranch() : '-';
      const reportDir = resolveReportDir(config.defaultReportDir || '.rag-reviews');
      console.log(chalk.cyan('\n─── Status RAG Reviewer ───'));
      console.log(`Git Repo Active : ${inRepo ? chalk.green(`Yes (Current Branch: ${currentBranch})`) : chalk.red('No')}`);
      console.log(`Vector DB Path  : ${chalk.yellow('~/.pr-rag/db')}`);
      console.log(`Report Dir      : ${chalk.yellow(reportDir)}`);
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

async function viewHistoryUI(defaultDir: string = '.rag-reviews') {
  const customDir = await input({
    message: 'Folder laporan markdown yang ingin dikelola:',
    default: defaultDir,
  });

  const resolved = resolveReportDir(customDir);
  const reports = await listSavedReports(resolved);

  if (reports.length === 0) {
    console.log(chalk.yellow(`\nBelum ada history review yang tersimpan di ${resolved}\n`));
    return;
  }

  const choices: Array<{ name: string; value: string }> = reports.map((r) => ({
    name: `📄 ${chalk.cyan(r.filename)} ${chalk.gray(`(${r.date.toLocaleString()})`)}`,
    value: r.fullPath,
  }));

  choices.push({ name: chalk.red('🗑️  Hapus SEMUA report di folder ini'), value: 'clear_all' });
  choices.push({ name: '🔙 Kembali ke menu utama', value: 'back' });

  const chosenAction = await select({
    message: `Pilih laporan review di ${chalk.yellow(resolved)}:`,
    choices,
  });

  if (chosenAction === 'back') return;

  if (chosenAction === 'clear_all') {
    const sure = await confirm({
      message: `Yakin ingin menghapus seluruh (${reports.length}) file report di ${resolved}?`,
      default: false,
    });
    if (sure) {
      const deletedCount = await clearAllReports(resolved);
      console.log(chalk.green(`\n✔ Berhasil menghapus ${deletedCount} file report markdown.\n`));
    }
    return;
  }

  const fileAction = await select({
    message: `Aksi untuk ${chalk.cyan(chosenAction)}:`,
    choices: [
      { name: '📖 Baca isi laporan (View Report)', value: 'view' },
      { name: chalk.red('🗑️  Hapus file ini (Delete Report)'), value: 'delete' },
      { name: '🔙 Batal', value: 'cancel' },
    ],
  });

  if (fileAction === 'view') {
    const content = await fs.readFile(chosenAction, 'utf-8');
    console.log(chalk.bold.cyan('\n═════════════════════ SAVED REVIEW REPORT ═════════════════════\n'));
    console.log(marked(content));
    console.log(chalk.bold.cyan('═══════════════════════════════════════════════════════════════\n'));
  } else if (fileAction === 'delete') {
    const confirmDelete = await confirm({
      message: `Hapus file ${chosenAction}?`,
      default: true,
    });
    if (confirmDelete) {
      await deleteReportFile(chosenAction);
      console.log(chalk.green(`\n✔ File report berhasil dihapus.\n`));
    }
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
  let defaultModel = 'ag/gemini-3.8-flash';
  let embeddingModel = 'local';

  if (provider === '9router') {
    baseUrl = await input({
      message: '9router Base URL:',
      default: currentConfig.baseUrl || 'https://api.9router.com/v1',
    });
    defaultModel = await input({
      message: 'Default Model (contoh: ag/gemini-3.8-flash, cx/gpt-6-astra):',
      default: currentConfig.defaultModel || 'ag/gemini-3.8-flash',
    });
    embeddingModel = 'local';
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
    embeddingModel = 'local';
  } else if (provider === 'ollama') {
    baseUrl = await input({
      message: 'Ollama Base URL:',
      default: currentConfig.baseUrl || 'http://localhost:11434/v1',
    });
    defaultModel = await input({
      message: 'Ollama Model:',
      default: currentConfig.defaultModel || 'qwen2.5-coder',
    });
    embeddingModel = 'local';
  } else if (provider === 'custom') {
    baseUrl = await input({
      message: 'Custom Base URL:',
      default: currentConfig.baseUrl || 'https://api.example.com/v1',
    });
    defaultModel = await input({
      message: 'Default Model:',
      default: currentConfig.defaultModel || 'gpt-4o',
    });
    embeddingModel = 'local';
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

  const defaultReportDir = await input({
    message: 'Default folder simpan laporan review markdown:',
    default: currentConfig.defaultReportDir || '.rag-reviews',
  });

  const newConfig: AppConfig = {
    provider,
    apiKey,
    baseUrl,
    defaultModel,
    embeddingModel,
    defaultReportDir,
  };

  await saveConfig(newConfig);
  console.log(chalk.green(`\n✔ Konfigurasi berhasil disimpan ke ~/.pr-rag/config.json!\n`));
}
