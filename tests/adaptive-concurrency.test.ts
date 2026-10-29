import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveConcurrency } from '../src/core/adaptive-concurrency.js';

test('repeated rate limits halve concurrency and successful responses restore it gradually', () => {
  const limiter = new AdaptiveConcurrency(8);
  limiter.response(429); assert.equal(limiter.limit, 8);
  limiter.response(429); assert.equal(limiter.limit, 4);
  for (let n = 0; n < 8; n++) limiter.response(429);
  assert.equal(limiter.limit, 1);
  for (let n = 0; n < 5; n++) limiter.response(200);
  assert.equal(limiter.limit, 2);
  for (let n = 0; n < 100; n++) limiter.response(200);
  assert.equal(limiter.limit, 8);
});

test('limiter bounds actual in-flight calls after reduction and aborts queued calls', async () => {
  const limiter = new AdaptiveConcurrency(4);
  limiter.response(429); limiter.response(429);
  let active = 0, peak = 0;
  const release: (() => void)[] = [];
  const run = () => limiter.run(new AbortController().signal, async () => {
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
  });
  const first = run(), second = run();
  await Promise.resolve(); await Promise.resolve();
  const controller = new AbortController();
  let started = false;
  const queued = limiter.run(controller.signal, async () => { started = true; });
  controller.abort(new Error('Cancelled'));
  await assert.rejects(queued, /Cancelled/);
  assert.equal(started, false);
  assert.equal(peak, 2);
  release.forEach(resolve => resolve());
  await Promise.all([first, second]);
  assert.equal(active, 0);
  assert.equal(await limiter.run(new AbortController().signal, async () => 42), 42);
});
