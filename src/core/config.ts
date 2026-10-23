import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createOpenAI } from '@ai-sdk/openai';

export type DatabaseType = 'local' | 'qdrant';

export interface AppConfig {
  provider: 'openai' | '9router' | 'openrouter' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  savedModels?: string[];
  embeddingModel?: string;
  defaultReportDir?: string;
  // Konfigurasi Database (Local LanceDB vs Remote Qdrant VPS)
  dbType: DatabaseType;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
}

const PRIMARY_CONFIG_DIR = path.join(os.homedir(), '.lumio');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.pr-rag');

export function getConfigDir(): string {
  return PRIMARY_CONFIG_DIR;
}

const DEFAULT_CONFIG: AppConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'gpt-4o',
  savedModels: ['ag/gemini-3.8-flash', 'ag/claude-sonnet-4-6', 'cx/gpt-6-astra'],
  embeddingModel: 'text-embedding-3-small',
  defaultReportDir: '.lumio-reviews',
  dbType: 'local',
  qdrantUrl: 'https://knowlage.jagoankode.site',
  qdrantApiKey: '',
  qdrantCollection: 'guidelines',
};

export async function loadConfig(): Promise<AppConfig> {
  const primaryFile = path.join(PRIMARY_CONFIG_DIR, 'config.json');
  const legacyFile = path.join(LEGACY_CONFIG_DIR, 'config.json');

  let configFile = primaryFile;
  try {
    await fs.access(primaryFile);
  } catch {
    try {
      await fs.access(legacyFile);
      configFile = legacyFile;
    } catch {
      // Tidak ada file config
    }
  }

  try {
    const data = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(data);
    const merged: AppConfig = { ...DEFAULT_CONFIG, ...parsed };
    if (!merged.savedModels || !Array.isArray(merged.savedModels) || merged.savedModels.length === 0) {
      merged.savedModels = Array.from(new Set([merged.defaultModel, ...(DEFAULT_CONFIG.savedModels || [])]));
    } else if (!merged.savedModels.includes(merged.defaultModel)) {
      merged.savedModels.unshift(merged.defaultModel);
    }
    return merged;
  } catch {
    const envApiKey = process.env.OPENAI_API_KEY || '';
    const envBaseUrl = process.env.OPENAI_BASE_URL || '';
    return {
      ...DEFAULT_CONFIG,
      apiKey: envApiKey,
      baseUrl: envBaseUrl,
    };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(PRIMARY_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(PRIMARY_CONFIG_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Membuat provider client Vercel AI SDK berdasarkan konfigurasi aktif
 */
export async function getActiveAIProvider() {
  const config = await loadConfig();

  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  const baseURL = process.env.OPENAI_BASE_URL || config.baseUrl || undefined;

  if (!apiKey && config.provider !== 'ollama') {
    throw new Error(
      'API Key belum diset! Silakan konfigurasi via TUI (`lumio` -> "Configure AI Provider") atau set OPENAI_API_KEY di terminal.'
    );
  }

  const client = createOpenAI({
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
