import { AppConfig, loadConfig, resolveProviderForModel } from './config.js';

/**
 * Universal LLM caller yang kebal terhadap semua jenis proxy (9router, LiteLLM, dsb.)
 * 9router mengembalikan SSE stream (data: {...}) bahkan saat dipanggil non-streaming.
 * Fungsi ini menangani SSE parsing dan standard JSON secara native tanpa ketergantungan
 * pada parser kaku bawaan library luar.
 */
export async function callLLM(prompt: string, modelOverride?: string, signal?: AbortSignal, frozenConfig?: AppConfig, settings?: { temperature?: number }): Promise<string> {
  const config = frozenConfig || await loadConfig();
  const resolved = resolveProviderForModel(config, modelOverride);
  
  const apiKey = resolved.apiKey;
  const rawBaseUrl = resolved.baseUrl || 'https://api.openai.com/v1';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = resolved.model;

  if (!model) {
    throw new Error('Belum ada Model AI yang aktif atau dipilih. Silakan pilih model via TUI (`⚡ Ganti Model Cepat`).');
  }

  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model,
        ...settings,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        stream: true, // stream: true menjamin 100% kompatibel dengan 9router SSE maupun OpenAI direct
      }),
    });
  } catch (netErr: any) {
    if (signal?.aborted || netErr.name === 'AbortError') {
      throw netErr;
    }
    const causeMsg = netErr.cause?.message || netErr.cause?.code || netErr.message;
    throw new Error(
      `Gagal terhubung ke AI Endpoint (${url}): ${causeMsg}. Pastikan provider/daemon aktif atau ubah base URL di menu Setting.`
    );
  }

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status} dari AI Provider: ${errorText}`);
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
