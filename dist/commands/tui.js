"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInteractiveTUI = runInteractiveTUI;
const chalk_1 = __importDefault(require("chalk"));
const boxen_1 = __importDefault(require("boxen"));
const prompts_1 = require("@inquirer/prompts");
const ingest_js_1 = require("./ingest.js");
const review_js_1 = require("./review.js");
const git_js_1 = require("../core/git.js");
const config_js_1 = require("../core/config.js");
const history_js_1 = require("../core/history.js");
const marked_1 = require("marked");
const fs_1 = require("fs");
async function runInteractiveTUI() {
    console.clear();
    const banner = (0, boxen_1.default)(`${chalk_1.default.bold.cyan('🧪 RAG PR Reviewer')}\n${chalk_1.default.gray('Embedded Local AI Code Review & Convention Auditor')}`, {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        textAlignment: 'center',
    });
    console.log(banner);
    const inRepo = await (0, git_js_1.isGitRepo)();
    if (!inRepo) {
        console.log(chalk_1.default.yellow('⚠️  Perhatian: Direktori saat ini bukan git repository. Opsi review hanya bisa dijalankan di git repo.\n'));
    }
    while (true) {
        const config = await (0, config_js_1.loadConfig)();
        const choice = await (0, prompts_1.select)({
            message: 'Pilih aksi yang ingin dijalankan:',
            choices: [
                {
                    name: '🔍 Review Git Changes / PR Branch (Source vs Target)',
                    value: 'review',
                    disabled: !inRepo ? '(Bukan git repo)' : false,
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
                    name: `🤖 Configure AI Provider (${chalk_1.default.cyan(config.provider)})`,
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
            console.log(chalk_1.default.gray('\nSampai jumpa, Bos! 👋\n'));
            process.exit(0);
        }
        if (choice === 'config_ai') {
            await configureAIProviderUI(config);
        }
        else if (choice === 'history') {
            await viewHistoryUI(config.defaultReportDir || '.rag-reviews');
        }
        else if (choice === 'ingest') {
            const docPath = await (0, prompts_1.input)({
                message: 'Masukkan path file/folder panduan markdown:',
                default: './docs',
                validate: (val) => (val.trim().length > 0 ? true : 'Path tidak boleh kosong'),
            });
            console.log('');
            await (0, ingest_js_1.ingestCommand)(docPath);
            console.log('');
        }
        else if (choice === 'review') {
            const currentBranch = await (0, git_js_1.getCurrentBranch)();
            const diffType = await (0, prompts_1.select)({
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
            let targetBranch = undefined;
            let sourceBranch = undefined;
            let doFetch = false;
            if (diffType === 'pr_branches') {
                doFetch = await (0, prompts_1.confirm)({
                    message: 'Fetch branch remote terbaru dari origin terlebih dahulu (git fetch --all)?',
                    default: true,
                });
                const { local, remote } = await (0, git_js_1.getAvailableBranches)();
                const allBranches = Array.from(new Set([...local, ...remote]));
                const defaultTarget = allBranches.includes('origin/main')
                    ? 'origin/main'
                    : allBranches.includes('main')
                        ? 'main'
                        : 'origin/master';
                targetBranch = await (0, prompts_1.input)({
                    message: 'Target/Base Branch (tujuan PR, misal: origin/main, main, develop):',
                    default: defaultTarget,
                    validate: (val) => (val.trim().length > 0 ? true : 'Target branch tidak boleh kosong'),
                });
                const defaultSource = currentBranch !== 'HEAD' ? currentBranch : (allBranches[0] || 'HEAD');
                sourceBranch = await (0, prompts_1.input)({
                    message: 'Source/Feature Branch (cabang yang mau direview, misal: feature-a, origin/feature-a):',
                    default: defaultSource,
                    validate: (val) => (val.trim().length > 0 ? true : 'Source branch tidak boleh kosong'),
                });
            }
            // Konfigurasi output directory penyimpanan report markdown
            const defaultDir = config.defaultReportDir || '.rag-reviews';
            const outputDir = await (0, prompts_1.input)({
                message: 'Folder penyimpanan laporan Markdown review:',
                default: defaultDir,
                validate: (val) => (val.trim().length > 0 ? true : 'Folder tidak boleh kosong'),
            });
            const defaultModel = config.defaultModel || 'ag/gemini-3.8-flash';
            const model = await (0, prompts_1.select)({
                message: 'Pilih model LLM untuk review:',
                choices: [
                    { name: `⚡ ${defaultModel} (Default Provider Model)`, value: defaultModel },
                    { name: '🧠 gpt-4o-mini', value: 'gpt-4o-mini' },
                    { name: '🧪 Custom Model (ketik manual)', value: 'custom' },
                ],
            });
            let selectedModel = model;
            if (model === 'custom') {
                selectedModel = await (0, prompts_1.input)({
                    message: 'Nama model AI:',
                    default: defaultModel,
                });
            }
            console.log('');
            await (0, review_js_1.reviewCommand)({
                staged: diffType === 'staged',
                target: targetBranch,
                source: sourceBranch,
                fetchRemote: doFetch,
                model: selectedModel,
                outputDir: outputDir,
                saveReport: true,
            });
            console.log('');
        }
        else if (choice === 'status') {
            const currentBranch = inRepo ? await (0, git_js_1.getCurrentBranch)() : '-';
            const reportDir = (0, history_js_1.resolveReportDir)(config.defaultReportDir || '.rag-reviews');
            console.log(chalk_1.default.cyan('\n─── Status RAG Reviewer ───'));
            console.log(`Git Repo Active : ${inRepo ? chalk_1.default.green(`Yes (Current Branch: ${currentBranch})`) : chalk_1.default.red('No')}`);
            console.log(`Vector DB Path  : ${chalk_1.default.yellow('~/.pr-rag/db')}`);
            console.log(`Report Dir      : ${chalk_1.default.yellow(reportDir)}`);
            console.log(`AI Provider     : ${chalk_1.default.bold.magenta(config.provider)}`);
            console.log(`Base URL        : ${config.baseUrl || chalk_1.default.gray('(Default OpenAI)')}`);
            console.log(`Default Model   : ${chalk_1.default.cyan(config.defaultModel)}`);
            console.log(`API Key Status  : ${config.apiKey || process.env.OPENAI_API_KEY ? chalk_1.default.green('Configured ✅') : chalk_1.default.red('Missing ❌')}`);
            console.log(chalk_1.default.cyan('───────────────────────────\n'));
        }
        const again = await (0, prompts_1.confirm)({
            message: 'Ingin melakukan aksi lain?',
            default: true,
        });
        if (!again) {
            console.log(chalk_1.default.gray('\nSampai jumpa, Bos! 👋\n'));
            break;
        }
        console.clear();
        console.log(banner);
    }
}
async function viewHistoryUI(defaultDir = '.rag-reviews') {
    const customDir = await (0, prompts_1.input)({
        message: 'Folder laporan markdown yang ingin dikelola:',
        default: defaultDir,
    });
    const resolved = (0, history_js_1.resolveReportDir)(customDir);
    const reports = await (0, history_js_1.listSavedReports)(resolved);
    if (reports.length === 0) {
        console.log(chalk_1.default.yellow(`\nBelum ada history review yang tersimpan di ${resolved}\n`));
        return;
    }
    const choices = reports.map((r) => ({
        name: `📄 ${chalk_1.default.cyan(r.filename)} ${chalk_1.default.gray(`(${r.date.toLocaleString()})`)}`,
        value: r.fullPath,
    }));
    choices.push({ name: chalk_1.default.red('🗑️  Hapus SEMUA report di folder ini'), value: 'clear_all' });
    choices.push({ name: '🔙 Kembali ke menu utama', value: 'back' });
    const chosenAction = await (0, prompts_1.select)({
        message: `Pilih laporan review di ${chalk_1.default.yellow(resolved)}:`,
        choices,
    });
    if (chosenAction === 'back')
        return;
    if (chosenAction === 'clear_all') {
        const sure = await (0, prompts_1.confirm)({
            message: `Yakin ingin menghapus seluruh (${reports.length}) file report di ${resolved}?`,
            default: false,
        });
        if (sure) {
            const deletedCount = await (0, history_js_1.clearAllReports)(resolved);
            console.log(chalk_1.default.green(`\n✔ Berhasil menghapus ${deletedCount} file report markdown.\n`));
        }
        return;
    }
    // Tampilkan submenu aksi untuk file yang dipilih
    const fileAction = await (0, prompts_1.select)({
        message: `Aksi untuk ${chalk_1.default.cyan(chosenAction)}:`,
        choices: [
            { name: '📖 Baca isi laporan (View Report)', value: 'view' },
            { name: chalk_1.default.red('🗑️  Hapus file ini (Delete Report)'), value: 'delete' },
            { name: '🔙 Batal', value: 'cancel' },
        ],
    });
    if (fileAction === 'view') {
        const content = await fs_1.promises.readFile(chosenAction, 'utf-8');
        console.log(chalk_1.default.bold.cyan('\n═════════════════════ SAVED REVIEW REPORT ═════════════════════\n'));
        console.log((0, marked_1.marked)(content));
        console.log(chalk_1.default.bold.cyan('═══════════════════════════════════════════════════════════════\n'));
    }
    else if (fileAction === 'delete') {
        const confirmDelete = await (0, prompts_1.confirm)({
            message: `Hapus file ${chosenAction}?`,
            default: true,
        });
        if (confirmDelete) {
            await (0, history_js_1.deleteReportFile)(chosenAction);
            console.log(chalk_1.default.green(`\n✔ File report berhasil dihapus.\n`));
        }
    }
}
async function configureAIProviderUI(currentConfig) {
    console.log(chalk_1.default.bold.cyan('\n⚙️  Pengaturan AI Provider & API Key'));
    const provider = await (0, prompts_1.select)({
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
        baseUrl = await (0, prompts_1.input)({
            message: '9router Base URL:',
            default: currentConfig.baseUrl || 'https://api.9router.com/v1',
        });
        defaultModel = await (0, prompts_1.input)({
            message: 'Default Model (contoh: ag/gemini-3.8-flash, cx/gpt-6-astra):',
            default: currentConfig.defaultModel || 'ag/gemini-3.8-flash',
        });
        embeddingModel = 'local';
    }
    else if (provider === 'openai') {
        baseUrl = '';
        defaultModel = await (0, prompts_1.input)({
            message: 'Default Model:',
            default: currentConfig.defaultModel || 'gpt-4o',
        });
        embeddingModel = 'text-embedding-3-small';
    }
    else if (provider === 'openrouter') {
        baseUrl = 'https://openrouter.ai/api/v1';
        defaultModel = await (0, prompts_1.input)({
            message: 'Default Model (contoh: anthropic/claude-3.5-sonnet, openai/gpt-4o):',
            default: currentConfig.defaultModel || 'openai/gpt-4o',
        });
        embeddingModel = 'local';
    }
    else if (provider === 'ollama') {
        baseUrl = await (0, prompts_1.input)({
            message: 'Ollama Base URL:',
            default: currentConfig.baseUrl || 'http://localhost:11434/v1',
        });
        defaultModel = await (0, prompts_1.input)({
            message: 'Ollama Model:',
            default: currentConfig.defaultModel || 'qwen2.5-coder',
        });
        embeddingModel = 'local';
    }
    else if (provider === 'custom') {
        baseUrl = await (0, prompts_1.input)({
            message: 'Custom Base URL:',
            default: currentConfig.baseUrl || 'https://api.example.com/v1',
        });
        defaultModel = await (0, prompts_1.input)({
            message: 'Default Model:',
            default: currentConfig.defaultModel || 'gpt-4o',
        });
        embeddingModel = 'local';
    }
    let apiKey = '';
    if (provider !== 'ollama') {
        apiKey = await (0, prompts_1.password)({
            message: `Masukkan API Key untuk ${provider} (kosongkan jika tidak ingin mengubah):`,
            mask: '*',
        });
        if (!apiKey) {
            apiKey = currentConfig.apiKey;
        }
    }
    const defaultReportDir = await (0, prompts_1.input)({
        message: 'Default folder simpan laporan review markdown:',
        default: currentConfig.defaultReportDir || '.rag-reviews',
    });
    const newConfig = {
        provider,
        apiKey,
        baseUrl,
        defaultModel,
        embeddingModel,
        defaultReportDir,
    };
    await (0, config_js_1.saveConfig)(newConfig);
    console.log(chalk_1.default.green(`\n✔ Konfigurasi berhasil disimpan ke ~/.pr-rag/config.json!\n`));
}
