import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createOpenAI } from '@ai-sdk/openai';

export interface AppConfig {
  provider: 'openai' | '9router' | 'openrouter' | 'ollama' | 'custom';
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  embeddingModel?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.pr-rag');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  defaultModel: 'gpt-4o',
  embeddingModel: 'text-embedding-3-small',
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Fallback ke environment variables jika ada
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
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Membuat provider client Vercel AI SDK berdasarkan konfigurasi aktif
 */
export async function getActiveAIProvider() {
  const config = await loadConfig();

  // Environment variable tetap punya prioritas tertinggi jika dipasang runtime
  const apiKey = process.env.OPENAI_API_KEY || config.apiKey;
  const baseURL = process.env.OPENAI_BASE_URL || config.baseUrl || undefined;

  if (!apiKey && config.provider !== 'ollama') {
    throw new Error(
      'API Key belum diset! Silakan konfigurasi via TUI (`pr-rag` -> "Configure AI Provider") atau set OPENAI_API_KEY di terminal.'
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
