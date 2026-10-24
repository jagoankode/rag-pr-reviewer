import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createOpenAI } from '@ai-sdk/openai';

import { Language } from './i18n.js';

export type DatabaseType = 'local' | 'qdrant';

export interface ProviderProfile {
  id: string; // e.g. '9router', 'openai', 'groq', 'my-proxy'
  name: string; // display name e.g. '9router', 'Groq Cloud', 'Custom vLLM'
  providerType: '9router' | 'openai' | 'openrouter' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl: string;
  models: string[];
}

export interface AppConfig {
  language?: Language;
  provider?: string; // id provider yang sedang aktif (e.g. '9router', 'openai', atau nama custom)
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string; // bisa kosong jika user belum / sengaja mengosongkan model aktif
  savedModels?: string[];
  providers?: Record<string, ProviderProfile>;
  modelProviderMap?: Record<string, string>; // mapping: modelName -> providerId
  embeddingModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
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
  language: 'id',
  provider: '9router',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:20129/v1',
  defaultModel: 'ag/gemini-3.8-flash',
  savedModels: ['ag/gemini-3.8-flash', 'ag/claude-sonnet-4-6', 'cx/gpt-6-astra'],
  providers: {
    '9router': {
      id: '9router',
      name: '9router Gateway',
      providerType: '9router',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:20129/v1',
      models: ['ag/gemini-3.8-flash', 'ag/claude-sonnet-4-6', 'cx/gpt-6-astra'],
    },
    'openai': {
      id: 'openai',
      name: 'OpenAI Official',
      providerType: 'openai',
      apiKey: '',
      baseUrl: '',
      models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    },
  },
  modelProviderMap: {
    'ag/gemini-3.8-flash': '9router',
    'ag/claude-sonnet-4-6': '9router',
    'cx/gpt-6-astra': '9router',
    'gpt-4o': 'openai',
    'gpt-4o-mini': 'openai',
  },
  embeddingModel: 'local',
  defaultReportDir: '.lumio-reviews',
  dbType: 'local',
  qdrantUrl: '',
  qdrantApiKey: '',
  qdrantCollection: '',
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

    // Pastikan providers dan modelProviderMap terinisialisasi
    if (!merged.providers) {
      merged.providers = { ...DEFAULT_CONFIG.providers };
    }
    if (!merged.modelProviderMap) {
      merged.modelProviderMap = { ...DEFAULT_CONFIG.modelProviderMap };
    }

    if (!Array.isArray(merged.savedModels)) {
      merged.savedModels = merged.defaultModel ? [merged.defaultModel] : [];
    }

    // Pastikan models di provider profile tersinkron
    for (const [model, provId] of Object.entries(merged.modelProviderMap)) {
      if (merged.providers[provId] && !merged.providers[provId].models.includes(model)) {
        merged.providers[provId].models.push(model);
      }
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

/**
 * Mendapatkan konfigurasi provider untuk model tertentu (atau active model jika tidak dispesifikasikan)
 */
export function resolveProviderForModel(config: AppConfig, modelName?: string): {
  providerId: string;
  providerProfile?: ProviderProfile;
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  const targetModel = modelName || config.defaultModel || '';
  let provId = (targetModel ? config.modelProviderMap?.[targetModel] : undefined) || config.provider || '9router';

  // Heuristic jika belum terpetakan
  if (targetModel && !config.modelProviderMap?.[targetModel]) {
    if (targetModel.startsWith('ag/') || targetModel.startsWith('cx/')) {
      provId = '9router';
    } else if (targetModel.startsWith('gpt-') || targetModel.startsWith('o1') || targetModel.startsWith('o3')) {
      provId = 'openai';
    }
  }

  const profile = config.providers?.[provId];
  const apiKey = profile?.apiKey || config.apiKey || process.env.OPENAI_API_KEY || '';
  const baseUrl = profile?.baseUrl || config.baseUrl || (provId === '9router' ? 'http://127.0.0.1:20129/v1' : '');

  return {
    providerId: provId,
    providerProfile: profile,
    apiKey,
    baseUrl,
    model: targetModel,
  };
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

  const embeddingApiKey = config.embeddingApiKey || apiKey;
  const embeddingBaseUrl = config.embeddingBaseUrl || baseURL;

  const embeddingClient = createOpenAI({
    apiKey: embeddingApiKey || 'ollama',
    baseURL: embeddingBaseUrl,
  });

  return {
    client,
    embeddingClient,
    config,
    apiKey,
    baseURL,
  };
}
