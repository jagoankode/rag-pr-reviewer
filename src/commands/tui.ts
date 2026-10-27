import { parseModelNames, registerProvider, assignModels, selectModel, removeModels, removeProvider, updateProviderState } from '../core/provider-state.js';
import chalk from 'chalk';
import boxen from 'boxen';
import { select, input, confirm, password } from '../core/nav.js';
import { ingestCommand, ingestDirectRuleCommand } from './ingest.js';
import { reviewCommand } from './review.js';
import { inspectGuidelinesCommand } from './guidelines.js';
import { doctorCommand } from './doctor.js';
import { learnFeatureCommand } from './learn.js';
import { runInteractiveKnowledgeDialog } from './dialog.js';
import { isGitRepo, getAvailableBranches, getCurrentBranch } from '../core/git.js';
import { loadConfig, AppConfig, DatabaseType, ProviderProfile, resolveProviderForModel } from '../core/config.js';
import { Language, setLanguage, t } from '../core/i18n.js';
import { listSavedReports, resolveReportDir, deleteReportFile, clearAllReports } from '../core/history.js';
import { getAppVersion } from '../core/version.js';
import { readRecentLogs, clearAllLogs, getLogFilePath, logError } from '../core/logger.js';
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

function renderOpenCodeHeader(config: AppConfig, inRepo: boolean, currentBranch: string) {
  console.clear();
  const version = getAppVersion();
  const resolved = resolveProviderForModel(config);
  const lang = config.language || 'id';

  const termW = Math.max(60, Math.min(100, process.stdout.columns || 80));

  // 1. Sleek Brand Header
  const brand = `${chalk.bold.hex('#F59E0B')('✨ Lumio')} ${chalk.gray(`v${version}`)}`;
  const tagline = chalk.gray(t('tagline'));
  const gitBadge = inRepo
    ? chalk.cyan(`git:(${chalk.bold.green(currentBranch)})`)
    : chalk.gray('git:(offline)');

  const topSpace = Math.max(2, termW - stripAnsi(`${brand}  ${tagline}`).length - stripAnsi(gitBadge).length);
  console.log(`${brand}  ${tagline}${' '.repeat(topSpace)}${gitBadge}`);

  // 2. Minimalist Status Chip Line (OpenCode Style)
  const provChip = resolved.providerId
    ? `${chalk.gray(`${t('provider')}:`)} ${chalk.bold.yellow(resolved.providerId)}`
    : `${chalk.gray(`${t('provider')}:`)} ${chalk.red(t('unset'))}`;

  const modelChip = config.defaultModel
    ? `${chalk.gray(`${t('model')}:`)} ${chalk.bold.cyan(config.defaultModel)}`
    : `${chalk.gray(`${t('model')}:`)} ${chalk.yellow(t('unset'))}`;

  const dbChip =
    config.dbType === 'qdrant'
      ? config.qdrantUrl && config.qdrantCollection
        ? `${chalk.gray(`${t('db')}:`)} ${chalk.green(`qdrant[${config.qdrantCollection}]`)}`
        : `${chalk.gray(`${t('db')}:`)} ${chalk.yellow('qdrant[unconfigured]')}`
      : `${chalk.gray(`${t('db')}:`)} ${chalk.blue('lancedb[local]')}`;

  const langChip = `${chalk.gray('lang:')} ${chalk.bold.magenta(lang.toUpperCase())}`;

  console.log(`${chalk.gray('─'.repeat(termW))}`);
  console.log(` ${provChip}  ${chalk.gray('•')}  ${modelChip}  ${chalk.gray('•')}  ${dbChip}  ${chalk.gray('•')}  ${langChip}`);
  console.log(`${chalk.gray('─'.repeat(termW))}\n`);
}

function printHeader(breadcrumb: string) {
  console.clear();
  const version = getAppVersion();
  console.log(`${chalk.bold.hex('#F59E0B')('✨ Lumio')} ${chalk.gray(`v${version}`)} ${chalk.gray('›')} ${chalk.bold.yellow(breadcrumb)}\n`);
}

export async function runInteractiveTUI() {
  while (true) {
    const inRepo = await isGitRepo();
    const currentBranch = inRepo ? await getCurrentBranch() : 'no-git';
    const config = await loadConfig();
    const lang = config.language || 'id';

    renderOpenCodeHeader(config, inRepo, currentBranch);

    if (!inRepo) {
      console.log(chalk.yellow(t('notGitRepoWarn')));
    }

    const mainChoice = await select({
      isRootMenu: true,
      message: t('chooseAction'),
      choices: [
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuReviewTitle'), 26))} ${chalk.gray(t('menuReviewDesc'))}`,
          value: 'review',
          disabled: !inRepo ? t('notGitRepoBadge') : false,
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuKnowledgeTitle'), 26))} ${chalk.gray(t('menuKnowledgeDesc'))}`,
          value: 'knowledge_base',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuModelTitle'), 26))} ${chalk.gray(t('menuModelDesc'))}`,
          value: 'quick_switch_model',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuProviderTitle'), 26))} ${chalk.gray(t('menuProviderDesc'))}`,
          value: 'config_ai',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuHistoryTitle'), 26))} ${chalk.gray(t('menuHistoryDesc'))}`,
          value: 'history',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('menuSettingsTitle'), 26))} ${chalk.gray(t('menuSettingsDesc'))}`,
          value: 'settings',
        },
        {
          name: chalk.red(t('menuExit')),
          value: 'exit',
        },
      ],
    });

    if (mainChoice === 'exit') {
      console.log(chalk.gray(`\n${t('goodbye')}`));
      process.exit(0);
    }

    if (mainChoice === 'knowledge_base') {
      await knowledgeBaseMenuUI(config);
    } else if (mainChoice === 'settings') {
      await settingsMenuUI(config, inRepo);
    } else if (mainChoice === 'review') {
      await reviewWorkflowUI(config);
    } else if (mainChoice === 'history') {
      await viewHistoryUI(config.defaultReportDir || '.lumio-reviews');
    } else if (mainChoice === 'quick_switch_model') {
      await quickSwitchModelUI(config);
    } else if (mainChoice === 'config_ai') {
      await configureAIProviderUI(config);
    }
  }
}

async function settingsMenuUI(config: AppConfig, inRepo: boolean) {
  while (true) {
    const freshConfig = await loadConfig();
    const lang = freshConfig.language || 'id';
    printHeader(t('settingsMenuTitle'));

    const settingChoice = await select({
      message: t('chooseAction'),
      choices: [
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('settingStatusTitle'), 32))} ${chalk.gray(t('settingStatusDesc'))}`,
          value: 'status',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('settingLangTitle'), 32))} ${chalk.gray(t('settingLangDesc'))}`,
          value: 'language',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('settingDbTitle'), 32))} ${chalk.gray(t('settingDbDesc'))}`,
          value: 'database',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('settingDoctorTitle'), 32))} ${chalk.gray(t('settingDoctorDesc'))}`,
          value: 'doctor',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('settingLogTitle'), 32))} ${chalk.gray(t('settingLogDesc'))}`,
          value: 'logs',
        },
      ],
    });

    if (settingChoice === 'back') {
      return;
    }

    if (settingChoice === 'status') {
      await showStatusUI(inRepo, freshConfig);
    } else if (settingChoice === 'language') {
      await switchLanguageUI(freshConfig);
    } else if (settingChoice === 'database') {
      // The form edits the global config, so it starts from the global values, not project overrides.
      await configureDatabaseUI(await loadConfig(false));
    } else if (settingChoice === 'doctor') {
      await doctorCommand();
      await waitBackPrompt();
    } else if (settingChoice === 'logs') {
      await viewLogsUI();
    }
  }
}

async function knowledgeBaseMenuUI(config: AppConfig) {
  while (true) {
    const lang = config.language || 'id';
    printHeader(t('kbMenuTitle'));

    const kbChoice = await select({
      message: t('chooseAction'),
      choices: [
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('kbDialogTitle'), 38))} ${chalk.gray(t('kbDialogDesc'))}`,
          value: 'dialog',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('kbInspectTitle'), 38))} ${chalk.gray(t('kbInspectDesc'))}`,
          value: 'inspect_rules',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('kbLearnTitle'), 38))} ${chalk.gray(t('kbLearnDesc'))}`,
          value: 'learn_code',
        },
        {
          name: `${chalk.bold.cyan(padAnsiEnd(t('kbIngestTitle'), 38))} ${chalk.gray(t('kbIngestDesc'))}`,
          value: 'ingest',
        },
      ],
    });

    if (kbChoice === 'back') {
      return;
    }

    if (kbChoice === 'dialog') {
      await runInteractiveKnowledgeDialog();
    } else if (kbChoice === 'inspect_rules') {
      await inspectGuidelinesCommand();
    } else if (kbChoice === 'learn_code') {
      await learnWorkflowUI(config);
    } else if (kbChoice === 'ingest') {
      await ingestWorkflowUI();
    }
  }
}

async function switchLanguageUI(currentConfig: AppConfig) {
  printHeader(t('langMenuTitle'));
  const currentLang = currentConfig.language || 'id';

  const chosenLang = await select<Language | 'back'>({
    message: t('switchLangPrompt'),
    choices: [
      {
        name: `🇮🇩 Bahasa Indonesia${currentLang === 'id' ? ` (${t('active')})` : ''}`,
        value: 'id',
      },
      {
        name: `🇬🇧 English${currentLang === 'en' ? ` (${t('active')})` : ''}`,
        value: 'en',
      },
    ],
  });

  if (chosenLang === 'back') return;

  await updateProviderState(latest => ({ ...latest, language: chosenLang }));
  setLanguage(chosenLang);
  console.log(chalk.green(`\n${t('langSwitched')}\n`));
  await waitBackPrompt();
}

async function configureDatabaseUI(currentConfig: AppConfig) {
  let selectedMode: DatabaseType | 'back' = currentConfig.dbType || 'qdrant';
  let qdrantUrl = currentConfig.qdrantUrl || '';
  let qdrantApiKey = currentConfig.qdrantApiKey || '';
  let qdrantCollection = currentConfig.qdrantCollection || '';

  printHeader(t('dbMenuTitle'));

  const chosenMode = await select<DatabaseType | 'back'>({
    message: t('dbChoose'),
    choices: [
      {
        name: '🌐 Remote VPS Qdrant (Shared Team Knowledge)',
        value: 'qdrant',
        description: t('dbQdrantDesc'),
      },
      {
        name: '💻 Local LanceDB (Personal / Offline Mode)',
        value: 'local',
        description: t('dbLocalDesc'),
      },
    ],
  });

  if (chosenMode === 'back') return;
  selectedMode = chosenMode;

  if (selectedMode === 'qdrant') {
    // Escape (or typing back) returns 'back': abort the form without saving.
    let inputUrl = await input({
      message: 'Qdrant VPS Server URL:',
      default: qdrantUrl,
      validate: (v) => (v.trim().length > 0 ? true : t('dbUrlEmpty')),
    });
    if (inputUrl === 'back') return;
    inputUrl = inputUrl.trim();
    if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
      inputUrl = `https://${inputUrl}`;
    }
    qdrantUrl = inputUrl;

    const enteredCollection = await input({
      message: t('dbCollectionPrompt'),
      default: qdrantCollection,
      validate: (v) => (v.trim().length > 0 ? true : t('dbCollectionEmpty')),
    });
    if (enteredCollection === 'back') return;
    qdrantCollection = enteredCollection.trim();

    const enteredKey = await password({
      message: t('dbKeyPrompt'),
      mask: '*',
    });
    if (enteredKey === 'back') return;
    if (enteredKey) {
      qdrantApiKey = enteredKey;
    }
  }

  // REVIEW & EDIT CONFIRMATION LOOP UNTUK DATABASE
  while (true) {
    printHeader(t('dbConfirmTitle'));

    console.log(chalk.cyan(t('dbSummary')));
    console.log(`1. ${t('dbModeLabel')} : ${selectedMode === 'qdrant' ? chalk.bold.green('🌐 Remote VPS Qdrant') : chalk.bold.blue('💻 Local LanceDB')}`);
    if (selectedMode === 'qdrant') {
      console.log(`2. Server URL   : ${chalk.yellow(qdrantUrl)}`);
      console.log(`3. Collection   : ${chalk.cyan(qdrantCollection)}`);
      console.log(`4. API Key      : ${qdrantApiKey ? chalk.green('Configured (***)') : chalk.gray(t('dbNoKey'))}`);
    } else {
      console.log(`2. Path Disk    : ${chalk.yellow('~/.lumio/db')}`);
    }
    console.log(chalk.cyan('─────────────────────────────────────────────\n'));

    const dbConfirm = await select({
      message: t('dbConfirmPrompt'),
      choices: [
        { name: t('dbSave'), value: 'save' },
        ...(selectedMode === 'qdrant' ? [{ name: t('dbEdit'), value: 'edit' }] : []),
      ],
    });

    if (dbConfirm === 'cancel' || dbConfirm === 'back') {
      console.log(chalk.gray(`\n${t('dbCancelled')}\n`));
      await waitBackPrompt();
      return;
    }

    if (dbConfirm === 'save') {
      const mode = selectedMode;
      await updateProviderState(latest => ({
        ...latest,
        dbType: mode,
        ...(mode === 'qdrant' ? { qdrantUrl, qdrantApiKey, qdrantCollection } : {}),
      }));
      console.log(chalk.green(`\n${t('dbSaved', { mode: selectedMode === 'qdrant' ? '🌐 VPS Qdrant' : '💻 Local LanceDB' })}\n`));
      await waitBackPrompt();
      return;
    }

    if (dbConfirm === 'edit') {
      const field = await select({
        message: t('dbEditPrompt'),
        choices: [
          { name: `🌐 Server URL [${qdrantUrl}]`, value: 'url' },
          { name: `📂 Collection Name [${qdrantCollection}]`, value: 'collection' },
          { name: `🔑 API Key`, value: 'key' },
          { name: t('dbEditDone'), value: 'back' },
        ],
      });

      if (field === 'url') {
        let inputUrl = await input({
          message: t('dbEditUrl'),
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
          message: t('dbEditCollection'),
          default: qdrantCollection,
        });
        if (val && val !== 'back') qdrantCollection = val.trim();
      } else if (field === 'key') {
        const val = await password({
          message: t('dbEditKey'),
          mask: '*',
        });
        if (val !== 'back') qdrantApiKey = val.trim();
      }
    }
  }
}

async function reviewWorkflowUI(config: AppConfig) {
  printHeader(t('reviewMenuTitle'));
  const currentBranch = await getCurrentBranch();

  const diffType = await select({
    message: t('reviewModePrompt'),
    choices: [
      {
        name: t('reviewModePr'),
        value: 'pr_branches',
      },
      {
        name: t('reviewModeUncommitted'),
        value: 'uncommitted',
      },
      {
        name: t('reviewModeStaged'),
        value: 'staged',
      },
    ],
  });

  if (diffType === 'back') return;

  let targetBranch: string | undefined = undefined;
  let sourceBranch: string | undefined = undefined;
  let doFetch = false;

  if (diffType === 'pr_branches') {
    const fetchChoice = await select({
      message: t('reviewFetchPrompt'),
      choices: [
        { name: t('reviewFetchYes'), value: 'yes' },
        { name: t('reviewFetchNo'), value: 'no' },
      ],
    });

    if (fetchChoice === 'back') return;
    doFetch = fetchChoice === 'yes';

    const { local, remote } = await getAvailableBranches();
    const allBranches = Array.from(new Set([...local, ...remote]));

    // 1. Tanyakan Source/Feature Branch terlebih dahulu
    const defaultSource = currentBranch !== 'HEAD' ? currentBranch : allBranches[0] || 'HEAD';
    const rawSource = await input({
      message: t('reviewSourcePrompt'),
      default: defaultSource,
    });
    if (rawSource.trim().toLowerCase() === 'b' || rawSource.trim().toLowerCase() === 'back') return;
    sourceBranch = rawSource.trim();

    // 2. Kemudian tanyakan Target/Base Branch pembanding (tanpa default)
    const rawTarget = await input({
      message: t('reviewTargetPrompt'),
      validate: (val) => (val.trim().length > 0 ? true : t('reviewTargetEmpty')),
    });
    if (rawTarget.trim().toLowerCase() === 'b' || rawTarget.trim().toLowerCase() === 'back') return;
    targetBranch = rawTarget.trim();
  }

  const outputDir = config.defaultReportDir || '.lumio-reviews';
  let selectedModel = config.defaultModel;

  // Opsi Scope Review: Full file vs Diff changes only (Default: Full file)
  const scopeChoice = await select<'full' | 'diff' | 'back'>({
    message: t('reviewScopePrompt'),
    choices: [
      {
        name: t('reviewScopeFull'),
        value: 'full',
      },
      {
        name: t('reviewScopeDiff'),
        value: 'diff',
      },
    ],
  });

  if (scopeChoice === 'back') return;
  const reviewScope = scopeChoice === 'diff' ? 'diff' : 'full';

  if (!selectedModel) {
    console.log(chalk.yellow(`\n${t('reviewNoModelSelected')}`));
    selectedModel = await input({
      message: t('reviewModelPrompt'),
      validate: (v) => (v.trim().length > 0 ? true : t('modelEmpty')),
    });
    selectedModel = selectedModel.trim();
  }

  const maxViolationsInput = await input({
    message: t('reviewMaxPrompt'),
  });
  let maxViolations: number | undefined;
  if (maxViolationsInput && maxViolationsInput !== 'back' && !isNaN(parseInt(maxViolationsInput, 10))) {
    maxViolations = parseInt(maxViolationsInput, 10);
  }

  const limitDesc = maxViolations ? `Max Violations: ${chalk.yellow(maxViolations)}` : `Max Violations: ${t('unlimited')}`;
  console.log(chalk.gray(`\nℹ️  Model: ${chalk.cyan(selectedModel)} | Scope: ${chalk.cyan(reviewScope.toUpperCase())} | ${limitDesc} | Output: ${chalk.cyan(outputDir)}\n`));
  await reviewCommand({
    staged: diffType === 'staged',
    target: targetBranch,
    source: sourceBranch,
    scope: reviewScope,
    fetchRemote: doFetch,
    model: selectedModel,
    outputDir: outputDir,
    maxViolations,
    saveReport: true,
  });

  await waitBackPrompt();
}

async function learnWorkflowUI(config: AppConfig) {
  printHeader(t('learnMenuTitle'));
  console.log(chalk.gray(`${t('learnIntro')}\n`));

  const folderPath = await input({
    message: t('learnPathPrompt'),
    default: './src',
  });

  if (folderPath.trim().toLowerCase() === 'b' || folderPath.trim().toLowerCase() === 'back') return;

  console.log('');
  await learnFeatureCommand(folderPath.trim(), config.defaultModel);
  await waitBackPrompt();
}

async function ingestWorkflowUI() {
  printHeader(t('ingestMenuTitle'));

  const ingestType = await select({
    message: t('ingestMethodPrompt'),
    choices: [
      {
        name: t('ingestFromFile'),
        value: 'file',
      },
      {
        name: t('ingestFromForm'),
        value: 'interactive',
      },
    ],
  });

  if (ingestType === 'back') return;

  if (ingestType === 'file') {
    const docPath = await input({
      message: t('ingestPathPrompt'),
      default: './docs',
    });

    if (docPath.trim().toLowerCase() === 'b' || docPath.trim().toLowerCase() === 'back') return;

    console.log('');
    await ingestCommand(docPath.trim());
  } else if (ingestType === 'interactive') {
    const title = await input({
      message: t('ingestTitlePrompt'),
    });
    if (!title.trim() || title.trim().toLowerCase() === 'b' || title.trim().toLowerCase() === 'back') return;

    const content = await input({
      message: t('ingestContentPrompt'),
    });
    if (!content.trim() || content.trim().toLowerCase() === 'b' || content.trim().toLowerCase() === 'back') return;

    console.log('');
    await ingestDirectRuleCommand(title.trim(), content.trim());
  }

  await waitBackPrompt();
}

async function viewHistoryUI(defaultDir: string = '.lumio-reviews') {
  printHeader(t('historyMenuTitle'));

  const customDir = await input({
    message: t('historyDirPrompt'),
    default: defaultDir,
  });

  if (customDir.trim().toLowerCase() === 'b' || customDir.trim().toLowerCase() === 'back') return;

  const resolved = resolveReportDir(customDir.trim());
  const reports = await listSavedReports(resolved);

  if (reports.length === 0) {
    console.log(chalk.yellow(`\n${t('historyEmpty', { dir: resolved })}\n`));
    await waitBackPrompt();
    return;
  }

  while (true) {
    const refreshedReports = await listSavedReports(resolved);
    if (refreshedReports.length === 0) {
      console.log(chalk.yellow(`\n${t('historyAllGone', { dir: resolved })}\n`));
      await waitBackPrompt();
      return;
    }

    const choices: Array<{ name: string; value: string }> = refreshedReports.map((r) => ({
      name: `📄 ${chalk.cyan(r.filename)} ${chalk.gray(`(${r.date.toLocaleString()})`)}`,
      value: r.fullPath,
    }));

    choices.push({ name: chalk.red(t('historyClearAll')), value: 'clear_all' });

    const chosenAction = await select({
      message: t('historyPick', { dir: chalk.yellow(resolved) }),
      choices,
    });

    if (chosenAction === 'back') return;

    if (chosenAction === 'clear_all') {
      const sure = await confirm({
        message: t('historyClearConfirm', { count: refreshedReports.length, dir: resolved }),
        default: false,
      });
      if (sure) {
        const deletedCount = await clearAllReports(resolved);
        console.log(chalk.green(`\n${t('historyCleared', { count: deletedCount })}\n`));
      }
      return;
    }

    const fileAction = await select({
      message: t('historyFileAction', { file: chalk.cyan(chosenAction) }),
      choices: [
        { name: t('historyView'), value: 'view' },
        { name: chalk.red(t('historyDelete')), value: 'delete' },
        { name: t('historyCancel'), value: 'cancel' },
      ],
    });

    if (fileAction === 'view') {
      const content = await fs.readFile(chosenAction, 'utf-8');
      console.log(chalk.bold.cyan('\n═════════════════════ SAVED REVIEW REPORT ═════════════════════\n'));
      console.log(chalk.white(content));
      console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════\n'));
      await waitBackPrompt();
    } else if (fileAction === 'delete') {
      const confirmDelete = await confirm({
        message: t('historyDeleteConfirm'),
        default: true,
      });
      if (confirmDelete) {
        await deleteReportFile(chosenAction);
        console.log(chalk.green(`\n${t('historyDeleted')}\n`));
      }
    }
  }
}

// Both menus use this draft-only helper. Escape at ANY stage discards the draft.
async function promptProvider(config: AppConfig, existing?: ProviderProfile): Promise<ProviderProfile | undefined> {
  let type = existing?.providerType;
  if (!type) {
    const choice = await select({ message: t('providerTypePrompt'), choices: [
      { name: 'Custom OpenAI-Compatible', value: 'custom' },
      ...['9router', 'openai', 'openrouter', 'ollama'].map(value => ({ name: value, value })),
    ] });
    if (choice === 'back') return;
    type = choice as ProviderProfile['providerType'];
  }
  let id = existing?.id || type;
  let name = existing?.name || type;
  if (!existing && type === 'custom') {
    const raw = await input({ message: t('providerIdPrompt'), validate: v => {
      const id = v.trim().toLowerCase().replace(/\s+/g, '-');
      return !id || ['back', 'b', 'new_custom'].includes(id) ? t('providerIdInvalid') : config.providers?.[id] ? t('providerExists') : true;
    } });
    if (raw === 'back') return;
    id = raw.trim().toLowerCase().replace(/\s+/g, '-'); name = raw.trim();
  }
  if (!existing && config.providers?.[id]) {
    console.log(chalk.yellow(t('providerExistsUseEdit')));
    await waitBackPrompt(); return;
  }
  const defaults: Record<string, string> = { '9router': 'http://127.0.0.1:20129/v1', openai: '', openrouter: 'https://openrouter.ai/api/v1', ollama: 'http://localhost:11434/v1', custom: '' };
  const baseUrl = await input({ message: t('providerUrlPrompt'), default: existing?.baseUrl ?? defaults[type], validate: v => {
    if (!v.trim()) return type === 'openai' ? true : t('providerUrlRequired');
    try { return ['http:', 'https:'].includes(new URL(v).protocol) || t('providerUrlHttp'); } catch { return t('urlInvalid'); }
  } });
  if (baseUrl === 'back') return;
  const key = await password({ message: t('providerKeyPrompt', { id, hint: t(existing ? 'providerKeyKeep' : 'providerKeyOptional') }), mask: '*' });
  if (key === 'back') return;
  console.log(`Provider: ${id}\nBase URL: ${baseUrl || '(OpenAI default)'}\nAPI Key: ${key || existing?.apiKey ? t('providerKeyStored') : t('emptyParen')}`);
  const action = await select({ message: t('providerSavePrompt'), choices: [{ name: t('save'), value: 'save' }, { name: t('cancelNoSave'), value: 'cancel' }] });
  if (action !== 'save') return;
  return { id, name, providerType: type, baseUrl: baseUrl.trim(), apiKey: key.trim() || existing?.apiKey || '', models: existing?.models || [] };
}

async function quickSwitchModelUI(currentConfig: AppConfig) {
  while (true) {
    currentConfig = await loadConfig(false);
    const saved = currentConfig.savedModels || [];
    printHeader(t('modelMenuTitle'));
    console.log(t('modelActive', { model: currentConfig.defaultModel || t('emptyParen') }));
    const action = await select({ message: t('modelPick'), choices: [
      ...saved.map(m => ({ name: `${m} [${currentConfig.modelProviderMap?.[m] || t('modelUnmapped')}]${m === currentConfig.defaultModel ? t('modelIsActive') : ''}`, value: `select:${m}` })),
      { name: t('modelAdd'), value: 'add' },
      ...(saved.length ? [{ name: t('modelDelete'), value: 'delete' }, { name: t('modelClearActive'), value: 'clear_active' }, { name: t('modelClearAll'), value: 'clear_all' }] : []),
    ] });
    if (action === 'back') return;
    try {
      if (action === 'add') {
        const raw = await input({ message: t('modelNamePrompt'), validate: v => { try { parseModelNames(v); return true; } catch { return t('modelNameInvalid'); } } });
        if (raw === 'back') continue;
        const models = parseModelNames(raw);
        const provider = await select({ message: t('modelProviderPrompt'), choices: [
          ...Object.values(currentConfig.providers || {}).map(p => ({ name: `${p.name} (${p.id})`, value: p.id })),
          { name: t('providerAddNew'), value: 'new_custom' },
        ] });
        if (provider === 'back') continue;
        const draft = provider === 'new_custom' ? await promptProvider(currentConfig) : undefined;
        if (provider === 'new_custom' && !draft) continue;
        currentConfig = await updateProviderState(latest => assignModels(draft ? registerProvider(latest, draft) : latest, models, draft?.id || provider));
        console.log(chalk.green(t('modelAdded')));
      } else if (action.startsWith('select:')) {
        currentConfig = await updateProviderState(latest => selectModel(latest, action.slice(7)));
        console.log(chalk.green(t('modelSwitched')));
        await waitBackPrompt(); return;
      } else if (action === 'clear_active') {
        await updateProviderState(latest => ({ ...latest, defaultModel: '' }));
      } else if (action === 'clear_all') {
        if (!await confirm({ message: t('modelClearAllConfirm'), default: false })) continue;
        await updateProviderState(latest => removeModels(latest, [...new Set([...(latest.savedModels || []), ...Object.keys(latest.modelProviderMap || {})]) ]));
      } else if (action === 'delete') {
        const model = await select({ message: t('modelDeletePick'), choices: saved.map(value => ({ name: value, value })) });
        if (model === 'back') continue;
        await updateProviderState(latest => removeModels(latest, [model]));
      }
      await waitBackPrompt();
    } catch (err: any) { logError('ModelMenu', err); console.log(chalk.red(err.message)); await waitBackPrompt(); }
  }
}

async function configureAIProviderUI(currentConfig: AppConfig) {
  while (true) {
    currentConfig = await loadConfig(false);
    printHeader(t('providerMenuTitle'));
    const profiles = Object.values(currentConfig.providers || {});
    console.log(t('providerList', { list: profiles.map(p => `${p.name} [${p.id}]`).join(', ') || t('emptyParen') }));
    console.log(t('providerModelsHint'));
    const action = await select({ message: t('providerActionPrompt'), choices: [
      ...profiles.map(p => ({ name: `Edit ${p.name} [${p.id}]`, value: `edit:${p.id}` })),
      { name: t('providerAdd'), value: 'add' },
      ...(profiles.length ? [{ name: t('providerDelete'), value: 'delete' }] : []),
    ] });
    if (action === 'back') return;
    try {
      if (action === 'delete') {
        const id = await select({ message: t('providerDeletePick'), choices: profiles.map(p => ({ name: p.name, value: p.id })) });
        if (id === 'back' || !await confirm({ message: t('providerDeleteConfirm'), default: false })) continue;
        await updateProviderState(latest => removeProvider(latest, id));
      } else {
        const existing = action.startsWith('edit:') ? currentConfig.providers?.[action.slice(5)] : undefined;
        const draft = await promptProvider(currentConfig, existing);
        if (!draft) continue;
        await updateProviderState(latest => registerProvider(latest, draft, !!existing));
      }
      console.log(chalk.green(t('providerSaved')));
      await waitBackPrompt();
    } catch (err: any) { logError('ProviderMenu', err); console.log(chalk.red(err.message)); await waitBackPrompt(); }
  }
}

async function viewLogsUI() {
  while (true) {
    printHeader(t('logsMenuTitle'));
    const logPath = getLogFilePath();
    const lines = await readRecentLogs(30);

    console.log(chalk.gray(`${t('logsPath', { path: chalk.cyan(logPath) })}\n`));
    console.log(chalk.cyan(t('logsHeader')));

    if (lines.length === 0) {
      console.log(chalk.gray(`\n${t('logsEmpty')}\n`));
    } else {
      console.log('');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const time = parsed.time || '';
          const level = parsed.level === 50 ? chalk.red('[ERROR]') : parsed.level === 40 ? chalk.yellow('[WARN]') : chalk.blue('[INFO]');
          const ctx = parsed.context ? chalk.magenta(`[${parsed.context}]`) : '';
          const msg = parsed.err?.message || parsed.message || line;
          console.log(`${chalk.gray(time)} ${level} ${ctx} ${msg}`);
          if (parsed.err?.stack) {
            const stackFirstLine = parsed.err.stack.split('\n')[1];
            if (stackFirstLine) console.log(chalk.gray(`    ${stackFirstLine.trim()}`));
          }
        } catch {
          console.log(chalk.gray(line));
        }
      }
      console.log('');
    }
    console.log(chalk.cyan('───────────────────────────────────────────────────────────\n'));

    const logAction = await select({
      message: t('logsActionPrompt'),
      choices: [
        { name: t('logsRefresh'), value: 'refresh' },
        { name: t('logsClear'), value: 'clear' },
        { name: t('logsBack'), value: 'back' },
      ],
    });

    if (logAction === 'back') return;

    if (logAction === 'clear') {
      const ok = await confirm({
        message: t('logsClearConfirm'),
        default: false,
      });

      if (ok) {
        await clearAllLogs();
        console.log(chalk.green(`\n${t('logsCleared')}\n`));
      }
    }
  }
}

async function showStatusUI(inRepo: boolean, config: AppConfig) {
  printHeader(t('statusMenuTitle'));
  const currentBranch = inRepo ? await getCurrentBranch() : '-';
  const reportDir = resolveReportDir(config.defaultReportDir || '.lumio-reviews');
  const version = getAppVersion();
  const resolved = resolveProviderForModel(config);

  console.log(chalk.cyan(t('statusHeader')));
  console.log(`Brand Engine     : ${chalk.bold.yellow(`✨ Lumio v${version}`)}`);
  console.log(`Git Repository   : ${inRepo ? chalk.green(t('statusGitActive', { branch: currentBranch })) : chalk.red(t('statusGitMissing'))}`);
  console.log(`Database Mode    : ${config.dbType === 'qdrant' ? chalk.bold.green('🌐 Remote VPS Qdrant') : chalk.bold.blue('💻 Local LanceDB')}`);
  if (config.dbType === 'qdrant') {
    console.log(`Qdrant Server    : ${config.qdrantUrl ? chalk.yellow(config.qdrantUrl) : chalk.red(t('unsetParen'))}`);
    console.log(`Collection Name  : ${config.qdrantCollection ? chalk.cyan(config.qdrantCollection) : chalk.red(t('unsetParen'))}`);
  } else {
    console.log(`Vector DB Path   : ${chalk.yellow('~/.lumio/db')}`);
  }
  console.log(`Report Directory : ${chalk.yellow(reportDir)}`);
  console.log(`Active Provider  : ${chalk.bold.magenta(resolved.providerId)}`);
  console.log(`Base URL         : ${resolved.baseUrl || chalk.gray('(Default OpenAI)')}`);
  console.log(`Default Model    : ${chalk.cyan(config.defaultModel)}`);
  console.log(`API Key Status   : ${resolved.apiKey ? chalk.green('Configured ✅') : chalk.red('Missing ❌')}`);
  console.log(chalk.cyan('───────────────────────────────────────\n'));

  await waitBackPrompt();
}

async function waitBackPrompt() {
  await select({
    message: t('waitBack'),
    choices: [
      {
        name: chalk.yellow('🔙 esc back'),
        value: 'back',
      },
    ],
  });
}
