import { AppConfig, loadConfig, resolveProviderForModel } from './config.js';
import { t } from './i18n.js';
import { connectionError } from './network.js';

/** Retries after the first attempt for a busy or overloaded provider (429/5xx). */
export const LLM_MAX_RETRIES = 3;
const LLM_RETRY_BASE_MS = 2_000;
const LLM_RETRY_MAX_MS = 30_000;

/** HTTP error from the AI provider. `accountBlocked`: the key or account is refused, so every later call fails the same way. */
export class LLMHttpError extends Error {
  readonly accountBlocked: boolean;
  readonly retryable: boolean;
  constructor(readonly status: number, readonly body: string) {
    super(t('llmHttpError', { status, body: summarizeProviderError(body) }));
    this.name = 'LLMHttpError';
    this.accountBlocked = status === 401 || status === 403 || ACCOUNT_BLOCKED.test(body);
    this.retryable = (status === 429 || (status >= 500 && status <= 599)) && !this.accountBlocked;
  }
}

// Proxies such as 9router wrap an upstream account block (401/403) in a 5xx; retrying those only
// sends more traffic to an account that is already flagged, so they fail at once.
const ACCOUNT_BLOCKED = /\b(401|403)\b|unauthori[sz]ed|unauthenticated|permission[_ ]denied|forbidden|verify your account|validation_required|invalid[_ ]api[_ ]key|billing/i;

/**
 * Wraps an LLM call so that once the provider refuses the account, later calls fail with that same error
 * without a request: parallel workers would otherwise keep sending traffic to a flagged account.
 */
export function stopAfterAccountBlock<A extends unknown[]>(call: (...args: A) => Promise<string>): (...args: A) => Promise<string> {
  let blocked: LLMHttpError | undefined;
  return async (...args) => {
    if (blocked) throw blocked;
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof LLMHttpError && error.accountBlocked) blocked = error;
      throw error;
    }
  };
}

/**
 * One readable line from a provider error body. Proxies nest the upstream JSON inside their own message, so the
 * innermost `message` wins, with its status/reason codes. URLs are dropped: sign-in links carry one-time tokens and the
 * message lands in saved reports.
 */
export function summarizeProviderError(body: string): string {
  let text = body;
  try {
    const json = JSON.parse(body);
    const message = json?.error?.message ?? json?.message;
    if (typeof message === 'string') text = message;
  } catch {}
  const inner = text.indexOf('{');
  if (inner >= 0) {
    const field = (name: string) => [...text.matchAll(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, 'g'))].map(m => m[1]);
    const message = field('message').pop();
    if (message) {
      const codes = [...new Set([...field('status'), ...field('reason')])];
      text = `${text.slice(0, inner).trim()} ${message}${codes.length ? ` (${codes.join(', ')})` : ''}`;
    }
  }
  text = text.replace(/https?:\/\/\S+/g, '<url>').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Retry-After (seconds) when the provider sends one, else exponential backoff with jitter; capped at 30s. */
export function llmRetryDelayMs(attempt: number, retryAfter?: string | null, random: () => number = Math.random): number {
  const seconds = retryAfter != null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, LLM_RETRY_MAX_MS);
  const base = LLM_RETRY_BASE_MS * 2 ** attempt;
  return Math.min(base / 2 + random() * base / 2, LLM_RETRY_MAX_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Universal LLM caller yang kebal terhadap semua jenis proxy (9router, LiteLLM, dsb.)
 * 9router mengembalikan SSE stream (data: {...}) bahkan saat dipanggil non-streaming.
 * Fungsi ini menangani SSE parsing dan standard JSON secara native tanpa ketergantungan
 * pada parser kaku bawaan library luar.
 */
export async function callLLM(prompt: string, modelOverride?: string, signal?: AbortSignal, frozenConfig?: AppConfig, settings?: { temperature?: number; onResponse?: (status: number) => void }): Promise<string> {
  const config = frozenConfig || await loadConfig();
  const resolved = resolveProviderForModel(config, modelOverride);
  
  const apiKey = resolved.apiKey;
  const rawBaseUrl = resolved.baseUrl || 'https://api.openai.com/v1';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = resolved.model;

  if (!model) {
    throw new Error(t('llmNoModel'));
  }

  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    model,
    ...(settings?.temperature !== undefined ? { temperature: settings.temperature } : {}),
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream: true, // stream: true menjamin 100% kompatibel dengan 9router SSE maupun OpenAI direct
  });

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method: 'POST', headers, signal, body });
    } catch (netErr: any) {
      if (signal?.aborted || netErr.name === 'AbortError') {
        throw netErr;
      }
      throw connectionError('AI provider', url, netErr);
    }
    settings?.onResponse?.(res.status);
    if (res.ok) break;

    const error = new LLMHttpError(res.status, await res.text());
    if (!error.retryable || attempt >= LLM_MAX_RETRIES) throw error;
    await sleep(llmRetryDelayMs(attempt, res.headers.get('retry-after')), signal);
  }

  const rawText = await res.text();

  // 1. Coba parse jika provider mengembalikan JSON object utuh
  try {
    const json = JSON.parse(rawText);
    if (json.choices && json.choices[0] && json.choices[0].message) {
      return json.choices[0].message.content || '';
    }
  } catch {}

  // 2. Parse SSE chunks (data: {...}) yang dikirim oleh 9router / Claude
  let accumulated = '';
  const lines = rawText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const payloadStr = trimmed.slice(5).trim();
      if (payloadStr === '[DONE]') continue;
      try {
        const payload = JSON.parse(payloadStr);
        if (payload.choices && payload.choices[0] && payload.choices[0].delta) {
          accumulated += payload.choices[0].delta.content || '';
        } else if (payload.delta && typeof payload.delta.content === 'string') {
          accumulated += payload.delta.content;
        } else if (payload.text) {
          accumulated += payload.text;
        }
      } catch {}
    }
  }

  if (accumulated.trim().length > 0) {
    return accumulated;
  }

  return rawText;
}
