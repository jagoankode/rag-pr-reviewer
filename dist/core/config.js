"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigDir = getConfigDir;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.getActiveAIProvider = getActiveAIProvider;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const openai_1 = require("@ai-sdk/openai");
const PRIMARY_CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.lumio');
const LEGACY_CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.pr-rag');
function getConfigDir() {
    return PRIMARY_CONFIG_DIR;
}
const DEFAULT_CONFIG = {
    provider: 'openai',
    apiKey: '',
    baseUrl: '',
    defaultModel: 'gpt-4o',
    embeddingModel: 'text-embedding-3-small',
    defaultReportDir: '.lumio-reviews',
    dbType: 'local',
    qdrantUrl: 'https://knowlage.jagoankode.site',
    qdrantApiKey: '',
    qdrantCollection: 'guidelines',
};
async function loadConfig() {
    const primaryFile = path_1.default.join(PRIMARY_CONFIG_DIR, 'config.json');
    const legacyFile = path_1.default.join(LEGACY_CONFIG_DIR, 'config.json');
    let configFile = primaryFile;
    try {
        await fs_1.promises.access(primaryFile);
    }
    catch {
        try {
            await fs_1.promises.access(legacyFile);
            configFile = legacyFile;
        }
        catch {
            // Tidak ada file config
        }
    }
    try {
        const data = await fs_1.promises.readFile(configFile, 'utf-8');
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
    await fs_1.promises.mkdir(PRIMARY_CONFIG_DIR, { recursive: true });
    await fs_1.promises.writeFile(path_1.default.join(PRIMARY_CONFIG_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}
/**
 * Membuat provider client Vercel AI SDK berdasarkan konfigurasi aktif
 */
async function getActiveAIProvider() {
    const config = await loadConfig();
    const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
    const baseURL = process.env.OPENAI_BASE_URL || config.baseUrl || undefined;
    if (!apiKey && config.provider !== 'ollama') {
        throw new Error('API Key belum diset! Silakan konfigurasi via TUI (`lumio` -> "Configure AI Provider") atau set OPENAI_API_KEY di terminal.');
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
