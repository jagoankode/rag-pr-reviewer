import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '../core/nav.js';
import { ingestCommand, ingestDirectRuleCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { inspectGuidelinesCommand } from './guidelines.js';
import { learnFeatureCommand } from './learn.js';
import { runInteractiveKnowledgeDialog } from './dialog.js';
import { isGitRepo, getAvailableBranches, getCurrentBranch } from '../core/git.js';
import { loadConfig, saveConfig, AppConfig, DatabaseType, ProviderProfile, resolveProviderForModel } from '../core/config.js';
import { listSavedReports, resolveReportDir, deleteReportFile, clearAllReports } from '../core/history.js';
import { getAppVersion } from '../core/version.js';
import { promises as fs } from 'fs';

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function visibleWidth(str: string): string {
  return str;
}

function padAnsiEnd(str: string, targetWidth: number): string {
  const currentLen = stripAnsi(str).length;
  if (currentLen >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - currentLen);
}

function renderBox(title: string, lines: string[], width: number, borderColor = chalk.cyan): string[] {
  const innerW = width - 2;
  const titlePart = title ? `─ ${title} ` : '';
  const titleLen = stripAnsi(titlePart).length;
  const remainingTop = Math.max(0, innerW - titleLen);
  const top = borderColor(`╭${titlePart}${'─'.repeat(remainingTop)}╮`);
  const bottom = borderColor(`╰${'─'.repeat(innerW)}╯`);

  const body = lines.map((line) => {
    const rawLen = stripAnsi(line).length;
    const padding = Math.max(0, width - 4 - rawLen);
    return borderColor('│ ') + line + ' '.repeat(padding) + borderColor(' │');
  });

  return [top, ...body, bottom];
}

async function renderDashboardHeader(config: AppConfig, inRepo: boolean) {
  const version = getAppVersion();
  const currentBranch = inRepo ? await getCurrentBranch() : 'no-git';
  const resolved = resolveProviderForModel(config);
  const reports = await listSavedReports(config.defaultReportDir || '.lumio-reviews');

  const termW = Math.max(76, Math.min(100, process.stdout.columns || 80));
  const leftW = Math.floor((termW - 2) * 0.48);
  const rightW = termW - 2 - leftW;

  // 1. Top Header Line: ✨ Lumio v2.4.0 | AI-Powered PR Reviewer           git:(branch)
  const leftHeader = `${chalk.bold.yellow('✨ Lumio')} ${chalk.bold.cyan(`v${version}`)} ${chalk.gray('|')} ${chalk.gray('AI-Powered PR Reviewer')}`;
  const rightHeader = inRepo ? chalk.cyan(`git:(${chalk.bold.green(currentBranch)}) ᚶ`) : chalk.gray('git:(offline)');
  const spaceHeader = Math.max(2, termW - stripAnsi(leftHeader).length - stripAnsi(rightHeader).length);
  
  console.log(`${leftHeader}${' '.repeat(spaceHeader)}${rightHeader}\n`);

  // 2. Left Panel: COMMANDS overview
  const commandLines = [
    `${chalk.cyan('🚀 /review  ')} ${chalk.white('Review PR / Git Changes')}`,
    `${chalk.cyan('💬 /dialog  ')} ${chalk.white('Interactive RAG Chat')}`,
    `${chalk.cyan('🧠 /learn   ')} ${chalk.white('Audit Local Feature Code')}`,
    `${chalk.cyan('⚡ /model   ')} ${chalk.white('Ganti Model AI Cepat')}`,
    `${chalk.cyan('🤖 /provider')} ${chalk.white('Setup AI Provider (9router)')}`,
    `${chalk.cyan('💾 /db      ')} ${chalk.white('Storage Mode (LanceDB/Qdrant)')}`,
    `${chalk.cyan('📜 /history ')} ${chalk.white('View Saved Reports')}`,
    `${chalk.cyan('🚪 /quit    ')} ${chalk.white('Exit Lumio')}`,
  ];
  const leftBox = renderBox('COMMANDS', commandLines, leftW, chalk.blue);

  // 3. Right Top Panel: ACTIVE CONTEXT & METRICS
  const provId = resolved.providerId || 'none';
  const modelId = config.defaultModel ? chalk.bold.green(config.defaultModel) : chalk.yellow('Belum Diset');
  const dbStatus =
    config.dbType === 'qdrant'
      ? config.qdrantUrl && config.qdrantCollection
        ? `${chalk.cyan(`Qdrant (${config.qdrantCollection})`)} ${chalk.green('● Online')}`
        : `${chalk.yellow('Qdrant')} ${chalk.red('● Unset')}`
      : `${chalk.blue('Local LanceDB')} ${chalk.green('● Ready')}`;

  const contextLines = [
    `• Provider: ${chalk.bold.bgCyan.black(` ${provId} `)}`,
    `• Active Model: ${modelId}`,
    `• Vector DB: ${dbStatus}`,
    `• Git Target: ${inRepo ? chalk.cyan(currentBranch) : chalk.gray('Not a git repository')}`,
  ];
  const rightTopBox = renderBox('ACTIVE CONTEXT & METRICS', contextLines, rightW, chalk.cyan);

  // 4. Right Bottom Panel: LAST AUDIT STATUS
  let auditLines: string[] = [];
  if (reports.length > 0) {
    const last = reports[0];
    auditLines = [
      `Last report: ${chalk.white(last.filename.slice(0, rightW - 17))}`,
      `${chalk.green('✔')} ${reports.length} report review tersimpan di history.`,
    ];
  } else {
    auditLines = [
      'No critical issues found in recent review.',
      chalk.gray('Belum ada audit tersimpan. Jalankan /review.'),
    ];
  }
  const rightBottomBox = renderBox('LAST AUDIT STATUS', auditLines, rightW, chalk.magenta);

  const rightCombined = [...rightTopBox, ...rightBottomBox];

  // Print 2 columns side by side
  const totalRows = Math.max(leftBox.length, rightCombined.length);
  for (let i = 0; i < totalRows; i++) {
    const leftText = padAnsiEnd(leftBox[i] || '', leftW);
    const rightText = rightCombined[i] || '';
    console.log(`${leftText}  ${rightText}`);
  }
  console.log('');
}

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
    console.clear();
    const inRepo = await isGitRepo();
    const config = await loadConfig();

    await renderDashboardHeader(config, inRepo);

    const mainChoice = await select({
      message: chalk.cyan('> Select command or type action:'),
      choices: [
        {
          name: `${chalk.bold.cyan('🚀 /review    ')} ${chalk.white('Review Git Changes / PR Branch')}`,
          value: 'review',
          disabled: !inRepo ? '(Bukan git repo)' : false,
        },
        {
          name: `${chalk.bold.cyan('💬 /dialog    ')} ${chalk.white('Interactive RAG Chat (Tanya Jawab Aturan)')}`,
          value: 'dialog',
        },
        {
          name: `${chalk.bold.cyan('🧠 /learn     ')} ${chalk.white('Learn from Local Feature Code (Audit Scaffold)')}`,
          value: 'learn_code',
        },
        {
          name: `${chalk.bold.cyan('⚡ /model     ')} ${chalk.white('Ganti Model AI Cepat (Switch / Reset)')}`,
          value: 'quick_switch_model',
        },
        {
          name: `${chalk.bold.cyan('⚙️  /provider  ')} ${chalk.white('Configure AI Provider & Credentials')}`,
          value: 'config_ai',
        },
        {
          name: `${chalk.bold.cyan('💾 /db        ')} ${chalk.white('Database Storage Mode (VPS Qdrant / LanceDB)')}`,
          value: 'config_db',
        },
        {
          name: `${chalk.bold.cyan('📖 /rules     ')} ${chalk.white('Inspect Active Rules in Vector DB')}`,
          value: 'inspect_rules',
        },
        {
          name: `${chalk.bold.cyan('📚 /ingest    ')} ${chalk.white('Ingest Knowledge / Conventions ke Vector DB')}`,
          value: 'ingest',
        },
        {
          name: `${chalk.bold.cyan('📜 /history   ')} ${chalk.white('View & Manage Review History')}`,
          value: 'history',
        },
        {
          name: `${chalk.bold.cyan('📊 /status    ')} ${chalk.white('Check Environment & System Status')}`,
          value: 'status',
        },
        {
          name: `${chalk.bold.red('🚪 /quit      ')} ${chalk.red('Exit Lumio')}`,
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
  let qdrantUrl = currentConfig.qdrantUrl || '';
  let qdrantApiKey = currentConfig.qdrantApiKey || '';
  let qdrantCollection = currentConfig.qdrantCollection || '';

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
  let selectedModel = config.defaultModel;

  if (!selectedModel) {
    console.log(chalk.yellow('\n⚠️  Belum ada model AI yang dipilih/aktif!'));
    selectedModel = await input({
      message: 'Masukkan nama model AI untuk review (contoh: ag/gemini-3.8-flash, gpt-4o):',
      validate: (v) => (v.trim().length > 0 ? true : 'Model tidak boleh kosong'),
    });
    selectedModel = selectedModel.trim();
  }

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
  let activeModel = currentConfig.defaultModel || '';
  let savedModels = currentConfig.savedModels ? [...currentConfig.savedModels] : [];

  while (true) {
    const resolvedActive = resolveProviderForModel(currentConfig, activeModel);
    printHeader('Menu Utama > ⚡ Ganti Model Cepat');

    console.log(chalk.cyan(`Provider Aktif : ${resolvedActive.providerId ? chalk.bold.yellow(resolvedActive.providerId) : chalk.gray('(Belum diset)')}`));
    console.log(chalk.cyan(`Model Aktif    : ${activeModel ? chalk.bold.green(activeModel) : chalk.yellow('(Kosong / Belum Dipilih)')}`));
    console.log(chalk.gray(`Base URL       : ${resolvedActive.baseUrl || '(Default)'}\n`));

    const choices = [
      ...savedModels.map((m) => {
        const info = resolveProviderForModel(currentConfig, m);
        const provBadge = chalk.gray(`[${info.providerId}]`);
        return {
          name: m === activeModel ? `🟢 ${m} ${provBadge} (Sedang Aktif)` : `⚪ ${m} ${provBadge}`,
          value: `select:${m}`,
        };
      }),
      { name: '➕ Tambah Model Baru ke Daftar', value: 'add' },
      ...(savedModels.length > 0 ? [{ name: '🗑️  Hapus Model dari Daftar', value: 'delete' }] : []),
      ...(activeModel ? [{ name: '⏸️  Kosongkan Model Aktif (Nonaktifkan)', value: 'clear_active' }] : []),
      ...(savedModels.length > 0 ? [{ name: '🧹 Kosongkan Semua Model (Reset Daftar Model)', value: 'clear_all' }] : []),
      { name: '🔙 Kembali ke Menu Utama', value: 'back' },
    ];

    const action = await select({
      message: 'Pilih model yang ingin diaktifkan atau kelola daftar model:',
      choices,
    });

    if (action === 'back') {
      return;
    }

    if (action === 'clear_active') {
      activeModel = '';
      const updatedConfig: AppConfig = {
        ...currentConfig,
        defaultModel: '',
        savedModels,
      };
      await saveConfig(updatedConfig);
      console.log(chalk.yellow(`\n✔ Model aktif berhasil dikosongkan.\n`));
      await pressEnterToContinue();
      continue;
    }

    if (action === 'clear_all') {
      const confirmClear = await confirm({
        message: 'Apakah Anda yakin ingin MENGOSONGKAN SEMUA model dari daftar?',
        default: false,
      });
      if (confirmClear) {
        activeModel = '';
        savedModels = [];
        const updatedConfig: AppConfig = {
          ...currentConfig,
          defaultModel: '',
          savedModels: [],
          modelProviderMap: {},
        };
        await saveConfig(updatedConfig);
        console.log(chalk.green(`\n✔ Semua model berhasil dihapus. Daftar model sekarang kosong.\n`));
        await pressEnterToContinue();
      }
      continue;
    }

    if (action.startsWith('select:')) {
      const chosen = action.replace('select:', '');
      activeModel = chosen;
      const targetResolved = resolveProviderForModel(currentConfig, activeModel);

      const updatedConfig: AppConfig = {
        ...currentConfig,
        defaultModel: activeModel,
        provider: targetResolved.providerId,
        baseUrl: targetResolved.baseUrl,
        apiKey: targetResolved.apiKey,
        savedModels,
      };
      await saveConfig(updatedConfig);
      console.log(chalk.green(`\n✔ Model aktif berhasil diganti ke: ${chalk.bold(activeModel)}`));
      console.log(chalk.cyan(`✔ Provider aktif otomatis berganti ke: ${chalk.bold.yellow(targetResolved.providerId)}\n`));
      await pressEnterToContinue();
      return;
    }

    if (action === 'add') {
      const newModelName = await input({
        message: 'Masukkan nama model baru (contoh: ag/claude-sonnet-4-6, deepseek-r1):',
        validate: (v) => (v.trim().length > 0 ? true : 'Nama model tidak boleh kosong'),
      });

      if (newModelName && newModelName !== 'back') {
        const trimmed = newModelName.trim();

        const knownProviders = Object.keys(currentConfig.providers || { '9router': 1, 'openai': 1 });
        const providerChoices = [
          ...knownProviders.map((p) => {
            const prof = currentConfig.providers?.[p];
            return {
              name: `📦 ${prof?.name || p} (${p})`,
              value: p,
            };
          }),
          { name: '➕ Hubungkan ke Custom Provider Baru...', value: 'new_custom' },
        ];

        let targetProvider = await select({
          message: `Model "${trimmed}" ini disediakan oleh provider mana?`,
          choices: providerChoices,
        });

        const providersMap = { ...(currentConfig.providers || {}) };

        if (targetProvider === 'new_custom') {
          const customName = await input({
            message: 'Nama identifier custom provider (contoh: groq, vllm-local, together):',
            validate: (v) => (v.trim().length > 0 ? true : 'Nama provider tidak boleh kosong'),
          });
          const customId = customName.trim().toLowerCase().replace(/\s+/g, '-');
          const customBaseUrl = await input({
            message: 'Base URL provider ini (contoh: https://api.groq.com/openai/v1):',
            validate: (v) => (v.trim().length > 0 ? true : 'Base URL tidak boleh kosong'),
          });
          const customApiKey = await password({
            message: `API Key untuk "${customId}":`,
            mask: '*',
          });

          providersMap[customId] = {
            id: customId,
            name: customName.trim(),
            providerType: 'custom',
            apiKey: customApiKey && customApiKey !== 'back' ? customApiKey.trim() : '',
            baseUrl: customBaseUrl.trim(),
            models: [trimmed],
          };
          targetProvider = customId;
        }

        if (!savedModels.includes(trimmed)) {
          savedModels.push(trimmed);
        }
        activeModel = trimmed;

        const modelProviderMap = { ...(currentConfig.modelProviderMap || {}) };
        modelProviderMap[trimmed] = targetProvider;

        if (providersMap[targetProvider] && !providersMap[targetProvider].models.includes(trimmed)) {
          providersMap[targetProvider].models.push(trimmed);
        }

        const resolved = resolveProviderForModel({
          ...currentConfig,
          providers: providersMap,
          modelProviderMap,
        }, activeModel);

        const updatedConfig: AppConfig = {
          ...currentConfig,
          defaultModel: activeModel,
          provider: resolved.providerId,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          savedModels,
          providers: providersMap,
          modelProviderMap,
        };
        await saveConfig(updatedConfig);
        console.log(chalk.green(`\n✔ Model ${chalk.bold(trimmed)} ditambahkan ke provider ${chalk.bold.yellow(targetProvider)} dan dijadikan model aktif!\n`));
        await pressEnterToContinue();
      }
    }

    if (action === 'delete') {
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
          activeModel = savedModels.length > 0 ? savedModels[0] : '';
        }
        const modelProviderMap = { ...(currentConfig.modelProviderMap || {}) };
        delete modelProviderMap[modelToDelete];

        const targetResolved = resolveProviderForModel({
          ...currentConfig,
          modelProviderMap,
        }, activeModel);

        const updatedConfig: AppConfig = {
          ...currentConfig,
          defaultModel: activeModel,
          provider: targetResolved.providerId,
          baseUrl: targetResolved.baseUrl,
          apiKey: targetResolved.apiKey,
          savedModels,
          modelProviderMap,
        };
        await saveConfig(updatedConfig);
        console.log(chalk.green(`\n✔ Model ${chalk.bold(modelToDelete)} berhasil dihapus dari daftar.\n`));
        await pressEnterToContinue();
      }
    }
  }
}

async function configureAIProviderUI(currentConfig: AppConfig) {
  while (true) {
    printHeader('Menu Utama > 🤖 Configure AI Provider');

    const resolved = resolveProviderForModel(currentConfig);
    console.log(chalk.cyan(`Provider Aktif : ${resolved.providerId ? chalk.bold.yellow(resolved.providerId) : chalk.gray('(Belum diset)')}`));
    console.log(chalk.cyan(`Base URL       : ${chalk.white(resolved.baseUrl || '(Default)')}`));
    console.log(chalk.cyan(`Model Aktif    : ${chalk.green(currentConfig.defaultModel || '(Kosong)')}\n`));

    const existingProviders = Object.keys(currentConfig.providers || {});

    const menuAction = await select({
      message: 'Pilih aksi pengelolaan AI Provider:',
      choices: [
        { name: '✏️  Pilih / Edit Konfigurasi Provider Terdaftar', value: 'edit' },
        { name: '➕ Tambah Provider Baru (Custom / Proxy / Official)', value: 'add' },
        ...(existingProviders.length > 0 ? [{ name: '🗑️  Hapus Provider Terdaftar', value: 'delete' }] : []),
        { name: '🔙 Kembali ke Menu Utama', value: 'back' },
      ],
    });

    if (menuAction === 'back') {
      return;
    }

    if (menuAction === 'delete') {
      const providerToDelete = await select({
        message: 'Pilih provider yang ingin dihapus:',
        choices: [
          ...existingProviders.map((p) => {
            const prof = currentConfig.providers?.[p];
            const isCurrent = currentConfig.provider === p ? chalk.yellow(' (Sedang Aktif)') : '';
            return {
              name: `🗑️  ${prof?.name || p} [${p}]${isCurrent}`,
              value: p,
            };
          }),
          { name: '🔙 Batalkan', value: 'back' },
        ],
      });

      if (providerToDelete !== 'back') {
        const confirmDel = await confirm({
          message: `Hapus provider "${providerToDelete}" beserta pemetaan modelnya?`,
          default: false,
        });

        if (confirmDel) {
          const providers = { ...(currentConfig.providers || {}) };
          delete providers[providerToDelete];

          const modelProviderMap = { ...(currentConfig.modelProviderMap || {}) };
          for (const [model, prov] of Object.entries(modelProviderMap)) {
            if (prov === providerToDelete) {
              delete modelProviderMap[model];
            }
          }

          const remainingProviders = Object.keys(providers);
          const newActiveProvider = currentConfig.provider === providerToDelete
            ? (remainingProviders.length > 0 ? remainingProviders[0] : '')
            : (currentConfig.provider || '');

          const targetResolved = resolveProviderForModel({
            ...currentConfig,
            providers,
            modelProviderMap,
            provider: newActiveProvider,
          }, currentConfig.defaultModel);

          currentConfig = {
            ...currentConfig,
            providers,
            modelProviderMap,
            provider: newActiveProvider,
            baseUrl: targetResolved.baseUrl,
            apiKey: targetResolved.apiKey,
          };
          await saveConfig(currentConfig);
          console.log(chalk.green(`\n✔ Provider [${chalk.bold(providerToDelete)}] berhasil dihapus!\n`));
          await pressEnterToContinue();
        }
      }
      continue;
    }

    let provider = '';
    let baseUrl = '';
    let defaultModel = currentConfig.defaultModel || 'ag/gemini-3.8-flash';
    let apiKey = '';
    let defaultReportDir = currentConfig.defaultReportDir || '.lumio-reviews';
    let embeddingModel = currentConfig.embeddingModel || 'local';
    let customProviderName = '';

    if (menuAction === 'add') {
      const providerTypeChoice = await select({
        message: 'Pilih tipe provider yang ingin ditambahkan:',
        choices: [
          { name: '🛠️  Custom OpenAI-Compatible (Groq, Together, vLLM, DeepSeek, dsb.)', value: 'custom' },
          { name: '🌐 9router Multi-Model Gateway', value: '9router' },
          { name: '🟢 OpenAI Official', value: 'openai' },
          { name: '🌌 OpenRouter API', value: 'openrouter' },
          { name: '💻 Ollama Local Self-Hosted', value: 'ollama' },
          { name: '🔙 Batalkan', value: 'back' },
        ],
      });

      if (providerTypeChoice === 'back') continue;

      if (providerTypeChoice === 'custom') {
        const rawName = await input({
          message: 'Nama identifier Provider baru (contoh: groq, vllm-local, together-ai):',
          validate: (v) => (v.trim().length > 0 ? true : 'Nama provider tidak boleh kosong'),
        });
        const id = rawName.trim().toLowerCase().replace(/\s+/g, '-');
        provider = id;
        customProviderName = rawName.trim();

        baseUrl = await input({
          message: 'Base URL Provider:',
          default: 'https://api.groq.com/openai/v1',
          validate: (v) => (v.trim().length > 0 ? true : 'Base URL tidak boleh kosong'),
        });

        const enteredModel = await input({
          message: 'Model AI untuk provider ini (pisahkan dengan koma jika lebih dari satu):',
          default: 'llama-3.3-70b-versatile',
          validate: (v) => (v.trim().length > 0 ? true : 'Model tidak boleh kosong'),
        });
        defaultModel = enteredModel.split(',')[0].trim();
        embeddingModel = 'local';
      } else if (providerTypeChoice === '9router') {
        provider = '9router';
        customProviderName = '9router Gateway';
        baseUrl = await input({
          message: '9router Base URL:',
          default: 'http://localhost:20128/v1',
        });
        defaultModel = 'ag/gemini-3.8-flash';
        embeddingModel = 'local';
      } else if (providerTypeChoice === 'openai') {
        provider = 'openai';
        customProviderName = 'OpenAI Official';
        baseUrl = '';
        defaultModel = 'gpt-4o';
        embeddingModel = 'text-embedding-3-small';
      } else if (providerTypeChoice === 'openrouter') {
        provider = 'openrouter';
        customProviderName = 'OpenRouter API';
        baseUrl = 'https://openrouter.ai/api/v1';
        defaultModel = 'anthropic/claude-3.5-sonnet';
        embeddingModel = 'local';
      } else if (providerTypeChoice === 'ollama') {
        provider = 'ollama';
        customProviderName = 'Ollama Local';
        baseUrl = await input({
          message: 'Ollama Base URL:',
          default: 'http://localhost:11434/v1',
        });
        defaultModel = 'qwen2.5-coder';
        embeddingModel = 'local';
      }
    } else if (menuAction === 'edit') {
      const providerListChoices = existingProviders.map((p) => {
        const prof = currentConfig.providers?.[p];
        const isCurrent = currentConfig.provider === p ? chalk.yellow(' [Sedang Aktif]') : '';
        return {
          name: `📦 ${prof?.name || p} (${p})${isCurrent}`,
          value: p,
        };
      });

      if (providerListChoices.length === 0) {
        console.log(chalk.yellow('\n⚠️  Belum ada provider yang terdaftar. Silakan pilih "Tambah Provider Baru".\n'));
        await pressEnterToContinue();
        continue;
      }

      providerListChoices.push({ name: '🔙 Batalkan', value: 'back' });

      const targetP = await select({
        message: 'Pilih provider yang ingin diedit/diaktifkan:',
        choices: providerListChoices,
      });

      if (targetP === 'back') continue;

      provider = targetP;
      const prof = currentConfig.providers?.[targetP];
      customProviderName = prof?.name || targetP;
      baseUrl = prof?.baseUrl || (targetP === '9router' ? 'http://localhost:20128/v1' : '');
      defaultModel = prof?.models?.[0] || currentConfig.defaultModel || 'gpt-4o';
      apiKey = prof?.apiKey || (currentConfig.provider === targetP ? (currentConfig.apiKey || '') : '');

      baseUrl = await input({
        message: `Base URL untuk [${customProviderName}]:`,
        default: baseUrl,
      });

      defaultModel = await input({
        message: `Default Model untuk [${customProviderName}]:`,
        default: defaultModel,
      });

      embeddingModel = await input({
        message: 'Embedding Model (text-embedding-3-large, text-embedding-3-small, atau "local"):',
        default: currentConfig.embeddingModel || 'local',
      });
    }

    if (provider !== 'ollama') {
      const existingKey = currentConfig.providers?.[provider]?.apiKey || (currentConfig.provider === provider ? (currentConfig.apiKey || '') : '');
      const enteredKey = await password({
        message: `Masukkan API Key untuk ${provider} (kosongkan jika tidak ingin mengubah):`,
        mask: '*',
      });
      if (enteredKey && enteredKey !== 'back') {
        apiKey = enteredKey;
      } else {
        apiKey = existingKey;
      }
    }

    // REVIEW & EDIT CONFIRMATION LOOP
    while (true) {
      printHeader('Menu Utama > 🤖 Configure AI Provider > Konfirmasi');

      const maskedKey = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : chalk.gray('(Tidak ada / kosong)');

      console.log(chalk.cyan('─── Ringkasan Konfigurasi AI (Cek Typo Sebelum Simpan) ───'));
      console.log(`1. Provider        : ${chalk.bold.yellow(provider)}`);
      console.log(`2. Base URL        : ${chalk.white(baseUrl || chalk.gray('(Default SDK)'))}`);
      console.log(`3. Default Model   : ${chalk.bold.green(defaultModel)}`);
      console.log(`4. Embedding Model : ${chalk.bold.magenta(embeddingModel || 'local')}`);
      console.log(`5. API Key         : ${chalk.white(maskedKey)}`);
      console.log(`6. Report Dir      : ${chalk.white(defaultReportDir)}`);
      console.log(chalk.cyan('──────────────────────────────────────────────────────────\n'));

      const reviewAction = await select({
        message: 'Apakah konfigurasi di atas sudah sesuai?',
        choices: [
          { name: '✅ Ya, Simpan & Terapkan Konfigurasi', value: 'save' },
          { name: '✏️  Edit Field Tertentu (Koreksi Typo)', value: 'edit_field' },
          { name: '🔙 Batalkan (Tanpa Simpan)', value: 'cancel' },
        ],
      });

      if (reviewAction === 'cancel' || reviewAction === 'back') {
        console.log(chalk.gray('\nPerubahan konfigurasi AI dibatalkan.\n'));
        await pressEnterToContinue();
        break;
      }

      if (reviewAction === 'save') {
        const providers = { ...(currentConfig.providers || {}) };
        const modelProviderMap = { ...(currentConfig.modelProviderMap || {}) };

        providers[provider] = {
          id: provider,
          name: customProviderName || provider,
          providerType: (['9router', 'openai', 'openrouter', 'ollama'].includes(provider) ? provider : 'custom') as any,
          apiKey,
          baseUrl,
          models: Array.from(new Set([defaultModel, ...(providers[provider]?.models || [])])),
        };

        modelProviderMap[defaultModel] = provider;

        const savedModels = currentConfig.savedModels && currentConfig.savedModels.length > 0
          ? [...currentConfig.savedModels]
          : [];
        if (!savedModels.includes(defaultModel)) {
          savedModels.push(defaultModel);
        }

        currentConfig = {
          ...currentConfig,
          provider,
          apiKey,
          baseUrl,
          defaultModel,
          embeddingModel,
          defaultReportDir,
          providers,
          modelProviderMap,
          savedModels,
        };
        await saveConfig(currentConfig);
        console.log(chalk.green(`\n✔ Konfigurasi provider [${chalk.bold(provider)}] berhasil disimpan!\n`));
        await pressEnterToContinue();
        break;
      }

      if (reviewAction === 'edit_field') {
        const fieldToEdit = await select({
          message: 'Pilih data yang ingin diperbaiki:',
          choices: [
            { name: `🌐 Base URL [${baseUrl}]`, value: 'baseUrl' },
            { name: `⚡ Default Model [${defaultModel}]`, value: 'model' },
            { name: `📐 Embedding Model [${embeddingModel}]`, value: 'embeddingModel' },
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
        } else if (fieldToEdit === 'embeddingModel') {
          const val = await input({
            message: 'Koreksi Embedding Model:',
            default: embeddingModel,
          });
          if (val && val !== 'back') embeddingModel = val.trim();
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
}

async function showStatusUI(inRepo: boolean, config: AppConfig) {
  printHeader('Menu Utama > ⚙️ System Status');
  const currentBranch = inRepo ? await getCurrentBranch() : '-';
  const reportDir = resolveReportDir(config.defaultReportDir || '.lumio-reviews');
  const version = getAppVersion();
  const resolved = resolveProviderForModel(config);

  console.log(chalk.cyan('─── Status Konfigurasi & Lingkungan ───'));
  console.log(`Brand Engine     : ${chalk.bold.yellow(`✨ Lumio v${version}`)}`);
  console.log(`Git Repository   : ${inRepo ? chalk.green(`Aktif (Branch: ${currentBranch})`) : chalk.red('Tidak Terdeteksi')}`);
  console.log(`Database Mode    : ${config.dbType === 'qdrant' ? chalk.bold.green('🌐 Remote VPS Qdrant') : chalk.bold.blue('💻 Local LanceDB')}`);
  if (config.dbType === 'qdrant') {
    console.log(`Qdrant Server    : ${config.qdrantUrl ? chalk.yellow(config.qdrantUrl) : chalk.red('(Belum diset)')}`);
    console.log(`Collection Name  : ${config.qdrantCollection ? chalk.cyan(config.qdrantCollection) : chalk.red('(Belum diset)')}`);
  } else {
    console.log(`Vector DB Path   : ${chalk.yellow('~/.lumio/db')}`);
  }
  console.log(`Report Directory : ${chalk.yellow(reportDir)}`);
  console.log(`Active Provider  : ${chalk.bold.magenta(resolved.providerId)}`);
  console.log(`Base URL         : ${resolved.baseUrl || chalk.gray('(Default OpenAI)')}`);
  console.log(`Default Model    : ${chalk.cyan(config.defaultModel)}`);
  console.log(`API Key Status   : ${resolved.apiKey ? chalk.green('Configured ✅') : chalk.red('Missing ❌')}`);
  console.log(chalk.cyan('───────────────────────────────────────\n'));

  await pressEnterToContinue();
}

async function pressEnterToContinue() {
  await input({
    message: chalk.gray('Tekan [Enter] untuk kembali ke Menu Utama...'),
  });
}
