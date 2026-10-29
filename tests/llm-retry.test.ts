import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import { callLLM, LLMHttpError, llmRetryDelayMs, stopAfterAccountBlock, LLM_MAX_RETRIES } from '../src/core/llm-client.js';
import { AppConfig } from '../src/core/config.js';
import { setLanguage } from '../src/core/i18n.js';
setLanguage('en');

type Reply = { status: number; body: string; headers?: Record<string, string> };

/** Local fake provider: answers each request with the next reply (the last one repeats) and counts requests. */
async function fakeProvider(replies: Reply[]) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const reply = replies[Math.min(calls++, replies.length - 1)];
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(reply.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { provider: 'fake', defaultModel: 'fake-model', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` } as AppConfig;
  return { config, calls: () => calls, close: () => new Promise(resolve => server.close(resolve)) };
}

const ok: Reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
const busy: Reply = { status: 503, body: 'upstream overloaded', headers: { 'Retry-After': '0' } };

test('a busy provider (429/503) is retried and the call succeeds', async () => {
  const provider = await fakeProvider([busy, { ...busy, status: 429 }, ok]);
  try {
    assert.equal(await callLLM('hi', undefined, undefined, provider.config), 'OK');
    assert.equal(provider.calls(), 3);
  } finally { await provider.close(); }
});

test('retries stop after LLM_MAX_RETRIES and the error says it was retryable', async () => {
  const provider = await fakeProvider([busy]);
  try {
    await assert.rejects(callLLM('hi', undefined, undefined, provider.config), (e: LLMHttpError) => e.status === 503 && e.retryable && !e.accountBlocked);
    assert.equal(provider.calls(), LLM_MAX_RETRIES + 1);
  } finally { await provider.close(); }
});

test('an account block, even wrapped in a 503 by a proxy, fails at once without retrying', async () => {
  const blocked = '[antigravity/model] [403] "Verify your account to continue." PERMISSION_DENIED VALIDATION_REQUIRED';
  for (const reply of [{ status: 503, body: blocked }, { status: 401, body: 'bad key' }, { status: 400, body: 'prompt too long' }]) {
    const provider = await fakeProvider([{ ...reply, headers: { 'Retry-After': '0' } }]);
    try {
      await assert.rejects(callLLM('hi', undefined, undefined, provider.config), (e: LLMHttpError) => !e.retryable && e.accountBlocked === (reply.status !== 400));
      assert.equal(provider.calls(), 1);
    } finally { await provider.close(); }
  }
});

test('after an account block, later calls fail without contacting the provider', async () => {
  const provider = await fakeProvider([{ status: 403, body: 'forbidden' }, ok]);
  try {
    const llm = stopAfterAccountBlock(callLLM);
    await assert.rejects(llm('a', undefined, undefined, provider.config), LLMHttpError);
    await assert.rejects(llm('b', undefined, undefined, provider.config), LLMHttpError);
    assert.equal(provider.calls(), 1);
  } finally { await provider.close(); }
});

test('other errors do not stop later calls', async () => {
  const provider = await fakeProvider([{ status: 400, body: 'prompt too long' }, ok]);
  try {
    const llm = stopAfterAccountBlock(callLLM);
    await assert.rejects(llm('a', undefined, undefined, provider.config), LLMHttpError);
    assert.equal(await llm('b', undefined, undefined, provider.config), 'OK');
  } finally { await provider.close(); }
});

test('retry delay honours Retry-After, otherwise backs off exponentially with a 30s cap', () => {
  assert.equal(llmRetryDelayMs(0, '5'), 5_000);
  assert.equal(llmRetryDelayMs(0, '600'), 30_000);
  assert.equal(llmRetryDelayMs(0, null, () => 1), 2_000);
  assert.equal(llmRetryDelayMs(0, null, () => 0), 1_000);
  assert.equal(llmRetryDelayMs(2, 'Wed, 21 Oct 2015 07:28:00 GMT', () => 1), 8_000);
  assert.equal(llmRetryDelayMs(10, null, () => 1), 30_000);
});

test('aborting during a backoff wait stops the call', async () => {
  const provider = await fakeProvider([{ status: 503, body: 'busy', headers: { 'Retry-After': '20' } }]);
  try {
    const started = Date.now();
    await assert.rejects(callLLM('hi', undefined, AbortSignal.timeout(200), provider.config));
    assert.ok(Date.now() - started < 5_000);
    assert.equal(provider.calls(), 1);
  } finally { await provider.close(); }
});

test('provider errors are summarized to one line without URLs', async () => {
  const { summarizeProviderError } = await import('../src/core/llm-client.js');
  const upstream = JSON.stringify({ error: { code: 403, message: 'Verify your account to continue.', status: 'PERMISSION_DENIED',
    details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.example.test/continue?token=secret' } }] } }, null, 2);
  const body = JSON.stringify({ error: { message: `[proxy/model] [403]: ${upstream}\n (reset after 2m)` } });
  const line = summarizeProviderError(body);
  assert.equal(line, '[proxy/model] [403]: Verify your account to continue. (PERMISSION_DENIED, VALIDATION_REQUIRED)');
  assert.equal(summarizeProviderError('Bad gateway, see https://status.example.test/x?id=1'), 'Bad gateway, see <url>');
  assert.equal(summarizeProviderError('x'.repeat(400)).length, 300);
  assert.match(new LLMHttpError(503, body).message, /^HTTP 503 .*Verify your account to continue\. \(PERMISSION_DENIED, VALIDATION_REQUIRED\)$/);
});
