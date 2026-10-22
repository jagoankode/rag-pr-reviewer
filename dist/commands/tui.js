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
                    name: '🔍 Review Git Changes (Local RAG Review)',
                    value: 'review',
                    disabled: !inRepo ? '(Bukan git repo)' : false,
                },
                {
                    name: '📚 Ingest Guidelines / Conventions ke Vector DB',
                    value: 'ingest',
                },
                {
                    name: '📜 View Review History (.rag-reviews)',
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
            await viewHistoryUI();
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
            const diffType = await (0, prompts_1.select)({
                message: 'Pilih jenis perubahan yang mau di-review:',
                choices: [
                    { name: '📝 Uncommitted changes (Semua perubahan lokal)', value: 'uncommitted' },
                    { name: '📦 Staged changes only (yang sudah di git add)', value: 'staged' },
                    { name: '🌿 Compare branch (misal: vs main)', value: 'branch' },
                ],
            });
            let branchName = undefined;
            if (diffType === 'branch') {
                branchName = await (0, prompts_1.input)({
                    message: 'Target branch pembanding:',
                    default: 'main',
                });
            }
            const defaultModel = config.defaultModel || 'gpt-4o';
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
                branch: branchName,
                model: selectedModel,
                saveReport: true,
            });
            console.log('');
        }
        else if (choice === 'status') {
            console.log(chalk_1.default.cyan('\n─── Status RAG Reviewer ───'));
            console.log(`Git Repo Active : ${inRepo ? chalk_1.default.green('Yes') : chalk_1.default.red('No')}`);
            console.log(`Vector DB Path  : ${chalk_1.default.yellow('~/.pr-rag/db')}`);
            console.log(`History Reports : ${chalk_1.default.yellow('./.rag-reviews/*.md')}`);
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
async function viewHistoryUI() {
    const reports = await (0, history_js_1.listSavedReports)();
    if (reports.length === 0) {
        console.log(chalk_1.default.yellow('\nBelum ada history review yang tersimpan di .rag-reviews/\n'));
        return;
    }
    const choices = reports.map((r) => ({
        name: `${chalk_1.default.cyan(r.filename)} ${chalk_1.default.gray(`(${r.date.toLocaleString()})`)}`,
        value: r.fullPath,
    }));
    choices.push({ name: '🔙 Kembali ke menu utama', value: 'back' });
    const chosenPath = await (0, prompts_1.select)({
        message: 'Pilih laporan review yang ingin dilihat:',
        choices,
    });
    if (chosenPath === 'back')
        return;
    const content = await fs_1.promises.readFile(chosenPath, 'utf-8');
    console.log(chalk_1.default.bold.cyan('\n═════════════════════ SAVED REVIEW REPORT ═════════════════════\n'));
    console.log((0, marked_1.marked)(content));
    console.log(chalk_1.default.bold.cyan('═══════════════════════════════════════════════════════════════\n'));
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
    let defaultModel = 'gpt-4o';
    let embeddingModel = 'text-embedding-3-small';
    if (provider === '9router') {
        baseUrl = await (0, prompts_1.input)({
            message: '9router Base URL:',
            default: currentConfig.baseUrl || 'https://api.9router.com/v1',
        });
        defaultModel = await (0, prompts_1.input)({
            message: 'Default Model (contoh: ag/gemini-3.8-flash, ag/gpt-4o):',
            default: currentConfig.defaultModel || 'ag/gemini-3.8-flash',
        });
        embeddingModel = await (0, prompts_1.input)({
            message: 'Embedding Model (untuk LanceDB RAG):',
            default: currentConfig.embeddingModel || 'text-embedding-3-small',
        });
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
        embeddingModel = await (0, prompts_1.input)({
            message: 'Embedding Model:',
            default: currentConfig.embeddingModel || 'text-embedding-3-small',
        });
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
        embeddingModel = await (0, prompts_1.input)({
            message: 'Ollama Embedding Model:',
            default: currentConfig.embeddingModel || 'nomic-embed-text',
        });
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
        embeddingModel = await (0, prompts_1.input)({
            message: 'Embedding Model:',
            default: currentConfig.embeddingModel || 'text-embedding-3-small',
        });
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
    const newConfig = {
        provider,
        apiKey,
        baseUrl,
        defaultModel,
        embeddingModel,
    };
    await (0, config_js_1.saveConfig)(newConfig);
    console.log(chalk_1.default.green(`\n✔ Konfigurasi AI Provider (${provider}) berhasil disimpan ke ~/.pr-rag/config.json!\n`));
}
