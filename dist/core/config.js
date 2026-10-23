"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.getActiveAIProvider = getActiveAIProvider;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const openai_1 = require("@ai-sdk/openai");
const CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.pr-rag');
const CONFIG_FILE = path_1.default.join(CONFIG_DIR, 'config.json');
const DEFAULT_CONFIG = {
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    defaultModel: 'gpt-4o',
    embeddingModel: 'text-embedding-3-small',
    defaultReportDir: '.rag-reviews',
    dbType: 'local',
    qdrantUrl: 'https://knowlage.jagoankode.site',
    qdrantApiKey: '',
    qdrantCollection: 'guidelines',
};
async function loadConfig() {
    try {
        const data = await fs_1.promises.readFile(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(data);
        return { ...DEFAULT_CONFIG, ...parsed };
    }
    catch {
        const envApiKey = process.env.OPENAI_API_KEY || '';
        const envBaseUrl = process.env.OPENAI_BASE_URL || '';
        return {
            ...DEFAULT_CONFIG,
            apiKey: envApiKey,
            baseUrl: envBaseUrl,
        };
    }
}
async function saveConfig(config) {
    await fs_1.promises.mkdir(CONFIG_DIR, { recursive: true });
    await fs_1.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
/**
 * Membuat provider client Vercel AI SDK berdasarkan konfigurasi aktif
 */
async function getActiveAIProvider() {
    const config = await loadConfig();
    const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
    const baseURL = process.env.OPENAI_BASE_URL || config.baseUrl || undefined;
    if (!apiKey && config.provider !== 'ollama') {
        throw new Error('API Key belum diset! Silakan konfigurasi via TUI (`pr-rag` -> "Configure AI Provider") atau set OPENAI_API_KEY di terminal.');
    }
    const client = (0, openai_1.createOpenAI)({
        apiKey: apiKey || 'ollama',
        baseURL: baseURL,
    });
    return {
        client,
        config,
        apiKey,
        baseURL,
    };
}
