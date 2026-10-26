import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewRule } from '../src/core/review-rules.js';
import { ReviewInput } from '../src/core/review-input.js';
import { buildCompilePrompt, compileRule, parseProposal, trialRun } from '../src/core/rule-compiler.js';

// A fictional team's rule: the compiler must work from the rule text alone.
const RULE = { id: 'doc:v1', title: 'V2 View Files', content: 'Never call `fetchJson()` inside `*.view.tsx` files.', source: 'manual', targetFiles: ['*.view.tsx'] } as ReviewRule;
const FORBID = { id: 'no-fetch-json', type: 'forbid-call', names: ['fetchJson'], severity: 'error', message: 'Jangan panggil `{name}` di view.' };
const input = (file: string, content: string): ReviewInput => ({ file, content, folderFiles: [], addedLines: [], diff: '', scope: 'full', hash: '' });

test('compile prompt carries the rule as delimited data, its targetFiles, the language and the primitive catalog', () => {
  const prompt = buildCompilePrompt(RULE, 'id');
  assert.match(prompt, /<<<RULE\n# V2 View Files\nNever call `fetchJson\(\)`/);
  assert.match(prompt, /targetFiles: \["\*\.view\.tsx"\]/);
  assert.match(prompt, /Bahasa Indonesia/);
  assert.match(prompt, /forbid-call \{ names, argument\? \}/);
  assert.match(buildCompilePrompt(RULE, 'en', { raw: '{}', errors: ['checks[0]: severity Required'] }), /rejected by the schema[\s\S]*- checks\[0\]: severity Required/);
});

test('proposal parsing: fenced JSON, invalid entries reported, duplicates rejected, complete only when clean', () => {
  const ok = parseProposal('```json\n' + JSON.stringify({ checks: [FORBID], complete: true, reason: 'Covers the call ban.' }) + '\n```');
  assert.equal(ok.checks.length, 1);
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.errors, []);

  const bad = parseProposal(JSON.stringify({ checks: [FORBID, { type: 'forbid-call', severity: 'error', message: 'x' }, FORBID], complete: true }));
  assert.equal(bad.complete, false);
  assert.equal(bad.checks.length, 2);
  assert.ok(bad.errors.some(e => e.startsWith('checks[1]')));
  assert.ok(bad.errors.some(e => e.includes('duplicate check id "no-fetch-json"')));

  assert.deepEqual(parseProposal('not json').errors, ['answer is not a JSON object']);
  assert.equal(parseProposal(JSON.stringify({ checks: [], complete: true })).complete, false);
});

test('compileRule retries once with the schema errors, then returns what is valid', async () => {
  const prompts: string[] = [];
  const answers = [JSON.stringify({ checks: [{ type: 'forbid-call', names: ['fetchJson'] }] }), JSON.stringify({ checks: [FORBID], complete: true, reason: 'ok' })];
  const proposal = await compileRule(RULE, 'en', async prompt => { prompts.push(prompt); return answers[prompts.length - 1]; });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /checks\[0\]: severity/);
  assert.deepEqual(proposal, { ruleId: 'doc:v1', title: 'V2 View Files', checks: [FORBID], complete: true, reason: 'ok', errors: [] });

  let calls = 0;
  await compileRule(RULE, 'en', async () => { calls++; return JSON.stringify({ checks: [FORBID], complete: false, reason: 'ok' }); });
  assert.equal(calls, 1);
});

test('trial run reports what a draft would find, scoped by the rule targetFiles', () => {
  const hits = trialRun(RULE, [FORBID as any], [
    input('src/a/Card.view.tsx', 'export const Card = (): null => {\n  fetchJson();\n  return null;\n};\n'),
    input('src/a/card.api.ts', 'fetchJson();\n'),
  ]);
  assert.deepEqual(hits.map(h => `${h.file}:${h.line}:${h.check}:${h.comment}`), ['src/a/Card.view.tsx:2:no-fetch-json:Jangan panggil `fetchJson` di view.']);
});
