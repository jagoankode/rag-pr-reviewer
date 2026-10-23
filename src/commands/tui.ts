import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '../core/nav.js';
import { ingestCommand, ingestDirectRuleCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { inspectGuidelinesCommand } from './guidelines.js';
import { learnFeatureCommand } from './learn.js';
import { runInteractiveKnowledgeDialog } from './dialog.js';
import { isGitRepo, getAvailableBranches, getCurrentBranch } from '../core/git.js';
import { loadConfig, saveConfig, AppConfig, DatabaseType } from '../core/config.js';
import { listSavedReports, resolveReportDir, deleteReportFile, clearAllReports } from '../core/history.js';
import { getAppVersion } from '../core/version.js';
import { promises as fs } from 'fs';

function printHeader(breadcrumb: string) {
  console.clear();
  const version = getAppVersion();
  const banner = boxen(
    `${chalk.bold.cyan('✨ Lumio')} ${chalk.gray(`v${version}`)}\n${chalk.gray(
      'AI-Powered PR Reviewer & Centralized Knowledge Engine'
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

    const dbBadge =
      config.dbType === 'qdrant'
        ? chalk.bold.green('🌐 VPS Qdrant (knowlage.jagoankode.site)')
        : chalk.bold.blue('💻 Local LanceDB (~/.lumio/db)');

    const mainChoice = await select({
      message: `Pilih aksi [DB Aktif: ${dbBadge}]:`,
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
          name: `💾 Database Storage Mode (${config.dbType === 'qdrant' ? '🌐 VPS Qdrant' : '💻 Local LanceDB'})`,
          value: 'config_db',
        },
        {
          name: '📜 View & Manage Review History (Buka / Hapus Report)',
          value: 'history',
        },
        {
          name: `⚡ Ganti Model Cepat (${chalk.green(config.defaultModel)})`,
          value: 'quick_switch_model',
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
    } else if (mainChoice === 'config_db') {
      await configureDatabaseUI(config);
    } else if (mainChoice === 'history') {
      await viewHistoryUI(config.defaultReportDir || '.lumio-reviews');
    } else if (mainChoice === 'quick_switch_model') {
      await quickSwitchModelUI(config);
    } else if (mainChoice === 'config_ai') {
      await configureAIProviderUI(config);
    } else if (mainChoice === 'status') {
      await showStatusUI(inRepo, config);
    }
  }
}

async function configureDatabaseUI(currentConfig: AppConfig) {
  let selectedMode: DatabaseType | 'back' = currentConfig.dbType || 'qdrant';
  let qdrantUrl = currentConfig.qdrantUrl || 'https://knowlage.jagoankode.site';
  let qdrantApiKey = currentConfig.qdrantApiKey || '';
  let qdrantCollection = currentConfig.qdrantCollection || 'guidelines';

  printHeader('Menu Utama > 💾 Database Storage Mode');

  const chosenMode = await select<DatabaseType | 'back'>({
    message: 'Pilih lokasi Vector Database untuk Knowledge Base tim:',
    choices: [
      {
        name: '🌐 Remote VPS Qdrant (Shared Team Knowledge)',
        value: 'qdrant',
        description: 'Menyimpan & menarik aturan dari server Qdrant VPS (Single Source of Truth tim)',
      },
      {
        name: '💻 Local LanceDB (Personal / Offline Mode)',
        value: 'local',
        description: 'Menyimpan & menarik aturan secara lokal di disk laptop (~/.lumio/db)',
      },
      {
        name: '🔙 Batalkan & Kembali ke Menu Utama',
        value: 'back',
      },
    ],
  });

  if (chosenMode === 'back') return;
  selectedMode = chosenMode;

  if (selectedMode === 'qdrant') {
    let inputUrl = await input({
      message: 'Qdrant VPS Server URL:',
      default: qdrantUrl,
      validate: (v) => (v.trim().length > 0 ? true : 'URL tidak boleh kosong'),
    });
    inputUrl = inputUrl.trim();
    if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
      inputUrl = `https://${inputUrl}`;
    }
    qdrantUrl = inputUrl;

    qdrantCollection = await input({
      message: 'Nama Collection di Qdrant:',
      default: qdrantCollection,
      validate: (v) => (v.trim().length > 0 ? true : 'Collection tidak boleh kosong'),
    });

    const enteredKey = await password({
      message: 'Qdrant API Key (tekan Enter jika tanpa autentikasi):',
      mask: '*',
    });
    if (enteredKey && enteredKey !== 'back') {
      qdrantApiKey = enteredKey;
    }
  }

  // REVIEW & EDIT CONFIRMATION LOOP UNTUK DATABASE
  while (true) {
    printHeader('Menu Utama > 💾 Database Storage Mode > Konfirmasi');

    console.log(chalk.cyan('─── Ringkasan Konfigurasi Vector Database ───'));
    console.log(`1. Mode Storage : ${selectedMode === 'qdrant' ? chalk.bold.green('🌐 Remote VPS Qdrant') : chalk.bold.blue('💻 Local LanceDB')}`);
    if (selectedMode === 'qdrant') {
      console.log(`2. Server URL   : ${chalk.yellow(qdrantUrl)}`);
      console.log(`3. Collection   : ${chalk.cyan(qdrantCollection)}`);
      console.log(`4. API Key      : ${qdrantApiKey ? chalk.green('Configured (***)') : chalk.gray('(Tanpa Key)')}`);
    } else {
      console.log(`2. Path Disk    : ${chalk.yellow('~/.lumio/db')}`);
    }
    console.log(chalk.cyan('─────────────────────────────────────────────\n'));

    const dbConfirm = await select({
      message: 'Apakah konfigurasi database sudah benar?',
      choices: [
        { name: '✅ Ya, Simpan & Terapkan', value: 'save' },
        ...(selectedMode === 'qdrant' ? [{ name: '✏️  Koreksi URL / Collection / Key (Edit Typo)', value: 'edit' }] : []),
        { name: '🔙 Batalkan & Kembali ke Menu Utama', value: 'cancel' },
      ],
    });

    if (dbConfirm === 'cancel' || dbConfirm === 'back') {
      console.log(chalk.gray('\nPengaturan database dibatalkan.\n'));
      await pressEnterToContinue();
      return;
    }

    if (dbConfirm === 'save') {
      const updatedConfig: AppConfig = {
        ...currentConfig,
        dbType: selectedMode,
        qdrantUrl,
        qdrantApiKey,
        qdrantCollection,
      };

      await saveConfig(updatedConfig);
      console.log(chalk.green(`\n✔ Database storage mode berhasil dialihkan ke: ${selectedMode === 'qdrant' ? '🌐 VPS Qdrant' : '💻 Local LanceDB'}\n`));
      await pressEnterToContinue();
      return;
    }

    if (dbConfirm === 'edit') {
      const field = await select({
        message: 'Pilih parameter Qdrant yang ingin dikoreksi:',
        choices: [
          { name: `🌐 Server URL [${qdrantUrl}]`, value: 'url' },
          { name: `📂 Collection Name [${qdrantCollection}]`, value: 'collection' },
          { name: `🔑 API Key`, value: 'key' },
          { name: '🔙 Selesai Edit', value: 'back' },
        ],
      });

      if (field === 'url') {
        let inputUrl = await input({
          message: 'Koreksi Qdrant URL:',
          default: qdrantUrl,
        });
        inputUrl = inputUrl.trim();
        if (inputUrl && inputUrl !== 'back') {
          if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
            inputUrl = `https://${inputUrl}`;
          }
          qdrantUrl = inputUrl;
        }
      } else if (field === 'collection') {
        const val = await input({
          message: 'Koreksi Nama Collection:',
          default: qdrantCollection,
        });
        if (val && val !== 'back') qdrantCollection = val.trim();
      } else if (field === 'key') {
        const val = await password({
          message: 'Masukkan API Key baru (atau Enter untuk kosong):',
          mask: '*',
        });
        if (val !== 'back') qdrantApiKey = val.trim();
      }
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

  const outputDir = config.defaultReportDir || '.lumio-reviews';
  const selectedModel = config.defaultModel || 'ag/gemini-3.8-flash';

  console.log(chalk.gray(`\nℹ️  Menggunakan Model: ${chalk.cyan(selectedModel)} | Output: ${chalk.cyan(outputDir)}\n`));
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
        name: '📁 Dari File / Folder Dokumen / Web URL (.md, .txt, http/https)',
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
      message: 'Masukkan path file/folder dokumen atau Web URL (atau ketik "b" untuk batal):',
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

async function viewHistoryUI(defaultDir: string = '.lumio-reviews') {
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

async function quickSwitchModelUI(currentConfig: AppConfig) {
  let activeModel = currentConfig.defaultModel || 'ag/gemini-3.8-flash';
  let savedModels = currentConfig.savedModels && currentConfig.savedModels.length > 0
    ? [...currentConfig.savedModels]
    : [activeModel, 'ag/claude-sonnet-4-6', 'cx/gpt-6-astra'];

  if (!savedModels.includes(activeModel)) {
    savedModels.unshift(activeModel);
  }

  while (true) {
    printHeader('Menu Utama > ⚡ Ganti Model Cepat');

    console.log(chalk.cyan(`Provider Aktif : ${chalk.bold.yellow(currentConfig.provider)}`));
    console.log(chalk.cyan(`Model Aktif    : ${chalk.bold.green(activeModel)}\n`));

    const choices = [
      ...savedModels.map((m) => ({
        name: m === activeModel ? `🟢 ${m} (Sedang Aktif)` : `⚪ ${m}`,
        value: `select:${m}`,
      })),
      { name: '➕ Tambah Model Baru ke Daftar', value: 'add' },
      { name: '🗑️  Hapus Model dari Daftar', value: 'delete' },
      { name: '🔙 Kembali ke Menu Utama', value: 'back' },
    ];

    const action = await select({
      message: 'Pilih model yang ingin diaktifkan atau kelola daftar model:',
      choices,
    });

    if (action === 'back') {
      return;
    }

    if (action.startsWith('select:')) {
      const chosen = action.replace('select:', '');
      activeModel = chosen;
      const updatedConfig: AppConfig = {
        ...currentConfig,
        defaultModel: activeModel,
        savedModels,
      };
      await saveConfig(updatedConfig);
      console.log(chalk.green(`\n✔ Model aktif berhasil diganti ke: ${chalk.bold(activeModel)}\n`));
      await pressEnterToContinue();
      return;
    }

    if (action === 'add') {
      const newModelName = await input({
        message: 'Masukkan nama model baru (contoh: ag/claude-sonnet-4-6, deepseek/deepseek-r1):',
        validate: (v) => (v.trim().length > 0 ? true : 'Nama model tidak boleh kosong'),
      });

      if (newModelName && newModelName !== 'back') {
        const trimmed = newModelName.trim();
        if (!savedModels.includes(trimmed)) {
          savedModels.push(trimmed);
        }
        activeModel = trimmed;
        const updatedConfig: AppConfig = {
          ...currentConfig,
          defaultModel: activeModel,
          savedModels,
        };
        await saveConfig(updatedConfig);
        console.log(chalk.green(`\n✔ Model ${chalk.bold(trimmed)} ditambahkan dan langsung dijadikan model aktif!\n`));
        await pressEnterToContinue();
      }
    }

    if (action === 'delete') {
      if (savedModels.length <= 1) {
        console.log(chalk.yellow('\n⚠️  Tidak bisa menghapus model terakhir dari daftar.\n'));
        await pressEnterToContinue();
        continue;
      }

      const modelToDelete = await select({
        message: 'Pilih model yang ingin dihapus dari daftar:',
        choices: [
          ...savedModels.map((m) => ({
            name: m === activeModel ? `⚠️  ${m} (Sedang Aktif)` : m,
            value: m,
          })),
          { name: '🔙 Batalkan', value: 'back' },
        ],
      });

      if (modelToDelete !== 'back') {
        savedModels = savedModels.filter((m) => m !== modelToDelete);
        if (activeModel === modelToDelete) {
          activeModel = savedModels[0];
        }
        const updatedConfig: AppConfig = {
          ...currentConfig,
          defaultModel: activeModel,
          savedModels,
        };
        await saveConfig(updatedConfig);
        console.log(chalk.green(`\n✔ Model ${chalk.bold(modelToDelete)} berhasil dihapus dari daftar.\n`));
        await pressEnterToContinue();
      }
    }
  }
}

async function configureAIProviderUI(currentConfig: AppConfig) {
  let provider = currentConfig.provider || '9router';
  let baseUrl = currentConfig.baseUrl || (provider === '9router' ? 'https://api.9router.com/v1' : '');
  let defaultModel = currentConfig.defaultModel || 'ag/gemini-3.8-flash';
  let apiKey = currentConfig.apiKey || '';
  let defaultReportDir = currentConfig.defaultReportDir || '.lumio-reviews';
  let embeddingModel = currentConfig.embeddingModel || 'local';

  // Wizard awal jika user baru pertama kali atau memilih konfigurasi
  printHeader('Menu Utama > 🤖 Configure AI Provider');

  const selectedProvider = await select<AppConfig['provider'] | 'back'>({
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

  if (selectedProvider === 'back') return;
  provider = selectedProvider;

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

  if (provider !== 'ollama') {
    const enteredKey = await password({
      message: `Masukkan API Key untuk ${provider} (kosongkan jika tidak ingin mengubah):`,
      mask: '*',
    });
    if (enteredKey && enteredKey !== 'back') {
      apiKey = enteredKey;
    }
  }

  const enteredDir = await input({
    message: 'Default folder simpan laporan review markdown:',
    default: currentConfig.defaultReportDir || '.lumio-reviews',
  });
  if (enteredDir && enteredDir !== 'back') {
    defaultReportDir = enteredDir;
  }

  // REVIEW & EDIT CONFIRMATION LOOP (Anti-Typo Safeguard)
  while (true) {
    printHeader('Menu Utama > 🤖 Configure AI Provider > Konfirmasi');

    const maskedKey = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : chalk.gray('(Tidak ada / kosong)');

    console.log(chalk.cyan('─── Ringkasan Konfigurasi AI (Cek Typo Sebelum Simpan) ───'));
    console.log(`1. Provider      : ${chalk.bold.yellow(provider)}`);
    console.log(`2. Base URL      : ${chalk.white(baseUrl || chalk.gray('(Default SDK)'))}`);
    console.log(`3. Default Model : ${chalk.bold.green(defaultModel)}`);
    console.log(`4. API Key       : ${chalk.white(maskedKey)}`);
    console.log(`5. Report Dir    : ${chalk.white(defaultReportDir)}`);
    console.log(chalk.cyan('──────────────────────────────────────────────────────────\n'));

    const reviewAction = await select({
      message: 'Apakah konfigurasi di atas sudah sesuai?',
      choices: [
        { name: '✅ Ya, Simpan & Terapkan Konfigurasi', value: 'save' },
        { name: '✏️  Edit Field Tertentu (Koreksi Typo)', value: 'edit_field' },
        { name: '🔄 Setup Ulang dari Awal', value: 'restart' },
        { name: '🔙 Batalkan & Kembali ke Menu Utama (Tanpa Simpan)', value: 'cancel' },
      ],
    });

    if (reviewAction === 'cancel' || reviewAction === 'back') {
      console.log(chalk.gray('\nPerubahan konfigurasi AI dibatalkan.\n'));
      await pressEnterToContinue();
      return;
    }

    if (reviewAction === 'save') {
      const newConfig: AppConfig = {
        ...currentConfig,
        provider,
        apiKey,
        baseUrl,
        defaultModel,
        embeddingModel,
        defaultReportDir,
      };
      await saveConfig(newConfig);
      console.log(chalk.green(`\n✔ Konfigurasi berhasil disimpan ke ~/.lumio/config.json!\n`));
      await pressEnterToContinue();
      return;
    }

    if (reviewAction === 'restart') {
      return await configureAIProviderUI(currentConfig);
    }

    if (reviewAction === 'edit_field') {
      const fieldToEdit = await select({
        message: 'Pilih data yang ingin diperbaiki:',
        choices: [
          { name: `🌐 Base URL [${baseUrl}]`, value: 'baseUrl' },
          { name: `⚡ Default Model [${defaultModel}]`, value: 'model' },
          { name: `🔑 API Key`, value: 'apiKey' },
          { name: `📁 Report Dir [${defaultReportDir}]`, value: 'reportDir' },
          { name: '🔙 Selesai Edit (Kembali ke Ringkasan)', value: 'back' },
        ],
      });

      if (fieldToEdit === 'baseUrl') {
        const val = await input({
          message: 'Koreksi Base URL:',
          default: baseUrl,
        });
        if (val && val !== 'back') baseUrl = val.trim();
      } else if (fieldToEdit === 'model') {
        const val = await input({
          message: 'Koreksi Default Model AI:',
          default: defaultModel,
        });
        if (val && val !== 'back') defaultModel = val.trim();
      } else if (fieldToEdit === 'apiKey') {
        const val = await password({
          message: 'Masukkan API Key baru:',
          mask: '*',
        });
        if (val && val !== 'back') apiKey = val.trim();
      } else if (fieldToEdit === 'reportDir') {
        const val = await input({
          message: 'Koreksi Report Dir:',
          default: defaultReportDir,
        });
        if (val && val !== 'back') defaultReportDir = val.trim();
      }
    }
  }
}

async function showStatusUI(inRepo: boolean, config: AppConfig) {
  printHeader('Menu Utama > ⚙️ System Status');
  const currentBranch = inRepo ? await getCurrentBranch() : '-';
  const reportDir = resolveReportDir(config.defaultReportDir || '.lumio-reviews');
  const version = getAppVersion();

  console.log(chalk.cyan('─── Status Konfigurasi & Lingkungan ───'));
  console.log(`Brand Engine     : ${chalk.bold.yellow(`✨ Lumio v${version}`)}`);
  console.log(`Git Repository   : ${inRepo ? chalk.green(`Aktif (Branch: ${currentBranch})`) : chalk.red('Tidak Terdeteksi')}`);
  console.log(`Database Mode    : ${config.dbType === 'qdrant' ? chalk.bold.green('🌐 Remote VPS Qdrant') : chalk.bold.blue('💻 Local LanceDB')}`);
  if (config.dbType === 'qdrant') {
    console.log(`Qdrant Server    : ${chalk.yellow(config.qdrantUrl || 'https://knowlage.jagoankode.site')}`);
    console.log(`Collection Name  : ${chalk.cyan(config.qdrantCollection || 'guidelines')}`);
  } else {
    console.log(`Vector DB Path   : ${chalk.yellow('~/.lumio/db')}`);
  }
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
