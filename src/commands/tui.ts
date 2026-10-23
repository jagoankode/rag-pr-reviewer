import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '@inquirer/prompts';
import { ingestCommand, ingestDirectRuleCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { inspectGuidelinesCommand } from './guidelines.js';
import { learnFeatureCommand } from './learn.js';
import { runInteractiveKnowledgeDialog } from './dialog.js';
import { isGitRepo, getAvailableBranches, getCurrentBranch } from '../core/git.js';
import { loadConfig, saveConfig, AppConfig } from '../core/config.js';
import { listSavedReports, resolveReportDir, deleteReportFile, clearAllReports } from '../core/history.js';
import { promises as fs } from 'fs';

function printHeader(breadcrumb: string) {
  console.clear();
  const banner = boxen(
    `${chalk.bold.cyan('🧪 RAG PR Reviewer')}\n${chalk.gray(
      'Embedded Local AI Code Review & Convention Auditor'
    )}\n\n${chalk.bold.yellow(`📍 ${breadcrumb}`)}`,
    {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: 'cyan',
      textAlignment: 'center',
    }
  );
  console.log(banner);
}

export async function runInteractiveTUI() {
  while (true) {
    printHeader('Menu Utama');
    const inRepo = await isGitRepo();
    const config = await loadConfig();

    if (!inRepo) {
      console.log(chalk.yellow('⚠️  Perhatian: Direktori saat ini bukan git repository. Opsi review dimatikan.\n'));
    }

    const mainChoice = await select({
      message: 'Pilih aksi yang ingin dijalankan:',
      choices: [
        {
          name: '🔍 Review Git Changes / PR Branch (Source vs Target)',
          value: 'review',
          disabled: !inRepo ? '(Bukan git repo)' : false,
        },
        {
          name: '💬 Chat / Dialog Interaktif RAG (Tanya Jawab & Diskusi Aturan)',
          value: 'dialog',
        },
        {
          name: '🧠 Learn from Local Feature Code (Belajar dari Folder/Route Lokal)',
          value: 'learn_code',
        },
        {
          name: '📖 Inspect Active Rules (Lihat Aturan yang Tersimpan di RAG)',
          value: 'inspect_rules',
        },
        {
          name: '📚 Ingest Knowledge / Conventions ke Vector DB',
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
          name: chalk.red('🚪 Keluar (Exit)'),
          value: 'exit',
        },
      ],
    });

    if (mainChoice === 'exit') {
      console.log(chalk.gray('\nSampai jumpa, Bos! 👋\n'));
      process.exit(0);
    }

    if (mainChoice === 'dialog') {
      await runInteractiveKnowledgeDialog();
    } else if (mainChoice === 'review') {
      await reviewWorkflowUI(config);
    } else if (mainChoice === 'learn_code') {
      await learnWorkflowUI(config);
    } else if (mainChoice === 'inspect_rules') {
      await inspectGuidelinesCommand();
    } else if (mainChoice === 'ingest') {
      await ingestWorkflowUI();
    } else if (mainChoice === 'history') {
      await viewHistoryUI(config.defaultReportDir || '.rag-reviews');
    } else if (mainChoice === 'config_ai') {
      await configureAIProviderUI(config);
    } else if (mainChoice === 'status') {
      await showStatusUI(inRepo, config);
    }
  }
}

async function reviewWorkflowUI(config: AppConfig) {
  printHeader('Menu Utama > 🔍 Review Git');
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
      {
        name: '🔙 Batalkan & Kembali ke Menu Utama',
        value: 'back',
      },
    ],
  });

  if (diffType === 'back') return;

  let targetBranch: string | undefined = undefined;
  let sourceBranch: string | undefined = undefined;
  let doFetch = false;

  if (diffType === 'pr_branches') {
    const fetchChoice = await select({
      message: 'Fetch branch remote terbaru dari origin (git fetch --all)?',
      choices: [
        { name: '✅ Ya, fetch remote terbaru sekarang', value: 'yes' },
        { name: '⏩ Lewati fetch (gunakan cache branch lokal saat ini)', value: 'no' },
        { name: '🔙 Batalkan review & kembali', value: 'back' },
      ],
    });

    if (fetchChoice === 'back') return;
    doFetch = fetchChoice === 'yes';

    const { local, remote } = await getAvailableBranches();
    const allBranches = Array.from(new Set([...local, ...remote]));

    const defaultTarget = allBranches.includes('origin/main')
      ? 'origin/main'
      : allBranches.includes('main')
      ? 'main'
      : 'origin/master';

    const rawTarget = await input({
      message: 'Target/Base Branch (tujuan PR, atau ketik "b" untuk batal):',
      default: defaultTarget,
    });
    if (rawTarget.trim().toLowerCase() === 'b' || rawTarget.trim().toLowerCase() === 'back') return;
    targetBranch = rawTarget.trim();

    const defaultSource = currentBranch !== 'HEAD' ? currentBranch : allBranches[0] || 'HEAD';
    const rawSource = await input({
      message: 'Source/Feature Branch (cabang yang mau direview, atau ketik "b" untuk batal):',
      default: defaultSource,
    });
    if (rawSource.trim().toLowerCase() === 'b' || rawSource.trim().toLowerCase() === 'back') return;
    sourceBranch = rawSource.trim();
  }

  // Pilih folder report
  const defaultDir = config.defaultReportDir || '.rag-reviews';
  const rawOutputDir = await input({
    message: 'Folder penyimpanan laporan Markdown review (atau "b" untuk batal):',
    default: defaultDir,
  });
  if (rawOutputDir.trim().toLowerCase() === 'b' || rawOutputDir.trim().toLowerCase() === 'back') return;
  const outputDir = rawOutputDir.trim();

  // Model LLM selection
  const defaultModel = config.defaultModel || 'ag/gemini-3.8-flash';
  const model = await select<string>({
    message: 'Pilih model LLM untuk review:',
    choices: [
      { name: `⚡ ${defaultModel} (Default Provider Model)`, value: defaultModel },
      { name: '🧠 gpt-4o-mini', value: 'gpt-4o-mini' },
      { name: '🧪 Custom Model (ketik manual)', value: 'custom' },
      { name: '🔙 Batalkan & Kembali', value: 'back' },
    ],
  });

  if (model === 'back') return;

  let selectedModel: string = model;
  if (model === 'custom') {
    const rawCustom = await input({
      message: 'Nama model AI (atau "b" untuk batal):',
      default: defaultModel,
    });
    if (rawCustom.trim().toLowerCase() === 'b' || rawCustom.trim().toLowerCase() === 'back') return;
    selectedModel = rawCustom.trim();
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

  await pressEnterToContinue();
}

async function learnWorkflowUI(config: AppConfig) {
  printHeader('Menu Utama > 🧠 Learn Code');
  console.log(chalk.gray('AI akan membedah source code lokal dari hulu ke hilir untuk mempelajari pola arsitektur.\n'));

  const folderPath = await input({
    message: 'Masukkan path folder/route lokal (atau ketik "b" untuk kembali):',
    default: './src',
  });

  if (folderPath.trim().toLowerCase() === 'b' || folderPath.trim().toLowerCase() === 'back') return;

  console.log('');
  await learnFeatureCommand(folderPath.trim(), config.defaultModel);
  await pressEnterToContinue();
}

async function ingestWorkflowUI() {
  printHeader('Menu Utama > 📚 Ingest Knowledge');

  const ingestType = await select({
    message: 'Pilih metode memasukkan pengetahuan:',
    choices: [
      {
        name: '📁 Dari File / Folder Dokumen (.md, .txt)',
        value: 'file',
      },
      {
        name: '💬 Input Form Aturan Baru (Judul + Isi Text)',
        value: 'interactive',
      },
      {
        name: '🔙 Batalkan & Kembali ke Menu Utama',
        value: 'back',
      },
    ],
  });

  if (ingestType === 'back') return;

  if (ingestType === 'file') {
    const docPath = await input({
      message: 'Masukkan path file/folder dokumen (atau ketik "b" untuk batal):',
      default: './docs',
    });

    if (docPath.trim().toLowerCase() === 'b' || docPath.trim().toLowerCase() === 'back') return;

    console.log('');
    await ingestCommand(docPath.trim());
  } else if (ingestType === 'interactive') {
    const title = await input({
      message: 'Judul aturan / pengetahuan (atau "b" untuk batal):',
    });
    if (!title.trim() || title.trim().toLowerCase() === 'b' || title.trim().toLowerCase() === 'back') return;

    const content = await input({
      message: 'Isi aturan atau instruksi convention (atau "b" untuk batal):',
    });
    if (!content.trim() || content.trim().toLowerCase() === 'b' || content.trim().toLowerCase() === 'back') return;

    console.log('');
    await ingestDirectRuleCommand(title.trim(), content.trim());
  }

  await pressEnterToContinue();
}

async function viewHistoryUI(defaultDir: string = '.rag-reviews') {
  printHeader('Menu Utama > 📜 Review History');

  const customDir = await input({
    message: 'Folder laporan markdown yang ingin dikelola (atau "b" untuk kembali):',
    default: defaultDir,
  });

  if (customDir.trim().toLowerCase() === 'b' || customDir.trim().toLowerCase() === 'back') return;

  const resolved = resolveReportDir(customDir.trim());
  const reports = await listSavedReports(resolved);

  if (reports.length === 0) {
    console.log(chalk.yellow(`\nBelum ada history review yang tersimpan di ${resolved}\n`));
    await pressEnterToContinue();
    return;
  }

  while (true) {
    const refreshedReports = await listSavedReports(resolved);
    if (refreshedReports.length === 0) {
      console.log(chalk.yellow(`\nSemua laporan di ${resolved} sudah kosong.\n`));
      await pressEnterToContinue();
      return;
    }

    const choices: Array<{ name: string; value: string }> = refreshedReports.map((r) => ({
      name: `📄 ${chalk.cyan(r.filename)} ${chalk.gray(`(${r.date.toLocaleString()})`)}`,
      value: r.fullPath,
    }));

    choices.push({ name: chalk.red('🗑️  Hapus SEMUA report di folder ini'), value: 'clear_all' });
    choices.push({ name: '🔙 Kembali ke Menu Utama', value: 'back' });

    const chosenAction = await select({
      message: `Pilih laporan review di ${chalk.yellow(resolved)}:`,
      choices,
    });

    if (chosenAction === 'back') return;

    if (chosenAction === 'clear_all') {
      const sure = await confirm({
        message: `Yakin ingin menghapus seluruh (${refreshedReports.length}) file report di ${resolved}?`,
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
        { name: '🔙 Batal / Pilih File Lain', value: 'cancel' },
      ],
    });

    if (fileAction === 'view') {
      const content = await fs.readFile(chosenAction, 'utf-8');
      console.log(chalk.bold.cyan('\n═════════════════════ SAVED REVIEW REPORT ═════════════════════\n'));
      console.log(chalk.white(content));
      console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════\n'));
      await pressEnterToContinue();
    } else if (fileAction === 'delete') {
      const confirmDelete = await confirm({
        message: `Hapus file ini secara permanen?`,
        default: true,
      });
      if (confirmDelete) {
        await deleteReportFile(chosenAction);
        console.log(chalk.green(`\n✔ File report berhasil dihapus.\n`));
      }
    }
  }
}

async function configureAIProviderUI(currentConfig: AppConfig) {
  printHeader('Menu Utama > 🤖 Configure AI Provider');

  const provider = await select<AppConfig['provider'] | 'back'>({
    message: 'Pilih AI Provider:',
    choices: [
      { name: '🌐 9router (Multi-model Gateway / ag/*)', value: '9router' },
      { name: '🟢 OpenAI Official (gpt-4o, o3, etc.)', value: 'openai' },
      { name: '🌌 OpenRouter (OpenRouter API)', value: 'openrouter' },
      { name: '💻 Ollama (Local Self-hosted)', value: 'ollama' },
      { name: '🛠️  Custom OpenAI-Compatible Provider', value: 'custom' },
      { name: '🔙 Batalkan & Kembali ke Menu Utama', value: 'back' },
    ],
  });

  if (provider === 'back') return;

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
  await pressEnterToContinue();
}

async function showStatusUI(inRepo: boolean, config: AppConfig) {
  printHeader('Menu Utama > ⚙️ System Status');
  const currentBranch = inRepo ? await getCurrentBranch() : '-';
  const reportDir = resolveReportDir(config.defaultReportDir || '.rag-reviews');

  console.log(chalk.cyan('─── Status Konfigurasi & Lingkungan ───'));
  console.log(`Git Repository   : ${inRepo ? chalk.green(`Aktif (Branch: ${currentBranch})`) : chalk.red('Tidak Terdeteksi')}`);
  console.log(`Vector DB Path   : ${chalk.yellow('~/.pr-rag/db')}`);
  console.log(`Report Directory : ${chalk.yellow(reportDir)}`);
  console.log(`Active Provider  : ${chalk.bold.magenta(config.provider)}`);
  console.log(`Base URL         : ${config.baseUrl || chalk.gray('(Default OpenAI)')}`);
  console.log(`Default Model    : ${chalk.cyan(config.defaultModel)}`);
  console.log(`API Key Status   : ${config.apiKey || process.env.OPENAI_API_KEY ? chalk.green('Configured ✅') : chalk.red('Missing ❌')}`);
  console.log(chalk.cyan('───────────────────────────────────────\n'));

  await pressEnterToContinue();
}

async function pressEnterToContinue() {
  await input({
    message: chalk.gray('Tekan [Enter] untuk kembali ke Menu Utama...'),
  });
}
