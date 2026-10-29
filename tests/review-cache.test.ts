import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ReviewCache, reviewCacheKey, CacheContext } from '../src/core/review-cache.js';
import { ReviewInput } from '../src/core/review-input.js';
import { snapshotRules } from '../src/core/review-rules.js';
import { coreAudit } from '../src/core/review-engine.js';

const input: ReviewInput = { file: 'a.ts', content: 'const a = 1;\n', folderFiles: ['a.ts'], addedLines: [1], diff: 'diff', scope: 'full', hash: '' };
const rules = snapshotRules([{ id: 'no-var', title: 'Avoid var', source: 'team', content: 'Never use var.', checksComplete: true,
  checks: [{ type: 'forbid-syntax', syntax: 'var', severity: 'error', message: 'Use const.' }] }]);
const context: CacheContext = { model: 'test-model', provider: 'test', baseUrl: 'https://example.invalid', language: 'en', aiScope: 'changed' };

test('cache hits preserve complete audits and invalidate on every relevant input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumio-cache-'));
  try {
    const cache = new ReviewCache(dir);
    const key = reviewCacheKey(input, rules, context);
    const audit = coreAudit(input, rules);
    assert.equal(await cache.get(key), undefined);
    await cache.put(key, audit);
    assert.deepEqual(await cache.get(key), audit);
    assert.deepEqual([cache.hits, cache.misses], [1, 1]);
    for (const change of [{ content: 'different' }, { file: 'b.ts' }, { folderFiles: ['b.ts'] }, { addedLines: [2] }, { diff: 'other' }, { scope: 'diff' as const }]) {
      assert.notEqual(key, reviewCacheKey({ ...input, ...change }, rules, context));
    }
    for (const change of [{ model: 'other' }, { provider: 'other' }, { baseUrl: 'https://other.invalid' }, { language: 'id' }, { aiScope: 'full' as const }]) {
      assert.notEqual(key, reviewCacheKey(input, rules, { ...context, ...change }));
    }
    assert.notEqual(key, reviewCacheKey(input, snapshotRules([{ ...rules.rules[0], content: 'New text' }]), context));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('incomplete, unverified, skipped, expired and corrupt entries are not reused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumio-cache-'));
  let now = Date.now();
  try {
    const cache = new ReviewCache(dir, 1000, 100000, () => now);
    const key = reviewCacheKey(input, rules, context);
    const audit = coreAudit(input, rules);
    for (const invalid of [{ ...audit, complete: false }, { ...audit, skipped: 'File deleted' },
      { ...audit, coverage: audit.coverage.map(c => ({ ...c, status: 'UNVERIFIED' as const })) }]) {
      await cache.put(key, invalid);
      assert.equal(await cache.get(key), undefined);
    }
    await cache.put(key, audit);
    now += 1001;
    assert.equal(await cache.get(key), undefined);
    await fs.writeFile(path.join(dir, `${key}.json`), '{broken');
    assert.equal(await cache.get(key), undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('cache disk usage stays within its configured bound', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumio-cache-'));
  try {
    const cache = new ReviewCache(dir, 100000, 1600);
    for (let i = 0; i < 8; i++) await cache.put(reviewCacheKey({ ...input, diff: String(i) }, rules, context), coreAudit(input, rules));
    const files = await fs.readdir(dir);
    assert.ok(files.length > 0 && files.length < 8);
    const bytes = await Promise.all(files.map(async file => (await fs.stat(path.join(dir, file))).size));
    assert.ok(bytes.reduce((sum, n) => sum + n, 0) <= 1600);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
