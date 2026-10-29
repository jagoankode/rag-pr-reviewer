import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditFile, coreAudit, parseAICoverage, rulesForAI, summarizeAudit } from '../src/core/review-engine.js';
import { excludeGeneratedSnapshots } from '../src/core/diff-parser.js';
import { snapshotRules, ReviewRule } from '../src/core/review-rules.js';
import { ReviewInput } from '../src/core/review-input.js';
import { formatReportToMarkdown } from '../src/core/history.js';
import { buildHybridPrompt } from '../src/core/review-prompt.js';
import { auditInputs } from '../src/commands/review.js';
import { LLMHttpError, stopAfterAccountBlock } from '../src/core/llm-client.js';

const input: ReviewInput = { file: 'src/a.ts', content: 'const a = 1;\n', folderFiles: ['a.ts'], addedLines: [1], diff: '+ L1: const a = 1;', scope: 'full', hash: '' };
const semantic: ReviewRule = { id: 'semantic', title: 'Keep functions focused', content: 'Keep functions focused.', source: 'team' };
const deterministic: ReviewRule = { id: 'syntax', title: 'Avoid var', content: 'Do not use var.', source: 'team', checksComplete: true,
  checks: [{ type: 'forbid-syntax', syntax: 'var', severity: 'error', message: 'Use const.' }] };
const response = (id: string, status = 'PASS', violations: unknown[] = []) => ({ ruleId: id, status, reason: 'Checked.', violations });

test('missing AI coverage remains UNVERIFIED and is not counted as a pass', async () => {
  const snapshot = snapshotRules([semantic, deterministic]);
  const audit = await auditFile(input, snapshot, async () => '{"coverage":[]}');
  assert.equal(audit.coverage.find(c => c.ruleId === semantic.id)?.status, 'UNVERIFIED');
  const result = summarizeAudit([audit], snapshot);
  assert.deepEqual(result.coverageSummary, { total: 2, verified: 1, notApplicable: 0, unverified: 1 });
  assert.equal(result.status, 'COMMENT');
  assert.equal(result.complete, false);
  const report = formatReportToMarkdown(result);
  assert.ok(report.includes('Keep functions focused'));
  assert.ok(report.includes('UNVERIFIED'));
});

test('generated snapshots are excluded from review and never call the AI', async () => {
  let calls = 0;
  const snapshot = snapshotRules([semantic, deterministic]);
  for (const file of ['__snapshots__/a.snap', 'src/__snapshots__/a.snap']) {
    const audit = await auditFile({ ...input, file }, snapshot, async () => { calls++; return '{}'; });
    assert.ok(audit.skipped);
    assert.deepEqual(audit.coverage, []);
  }
  assert.equal(calls, 0);
  const { reviewable, excluded } = excludeGeneratedSnapshots([{ file: 'src/__snapshots__/a.snap' }, { file: 'src/a.ts' }] as any);
  assert.deepEqual(reviewable.map(f => f.file), ['src/a.ts']);
  assert.deepEqual(excluded.map(f => f.file), ['src/__snapshots__/a.snap']);
});

test('changed scope drops findings on unchanged lines instead of leaving the rule unverified', async () => {
  const file = { ...input, content: 'const a = 1;\nconst b = 2;\n', addedLines: [2] };
  const snapshot = snapshotRules([semantic]);
  const v = (line: number) => ({ file: file.file, line, comment: 'Breaks the rule.', severity: 'error' });
  let calls = 0;
  const old = await auditFile(file, snapshot, async () => { calls++; return JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [v(1)])] }); });
  assert.equal(old.coverage[0].status, 'PASS');
  assert.equal(old.complete, true);
  assert.equal(old.violations.length, 0);
  assert.equal(calls, 1);
  const mixed = await auditFile(file, snapshot, async () => JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [v(1), v(2)])] }));
  assert.equal(mixed.coverage[0].status, 'FAIL');
  assert.deepEqual(mixed.violations.map(x => x.line), [2]);
  // In full scope the unchanged line is evidence, reported apart as existing code.
  const full = await auditFile(file, snapshot, async () => JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [v(1)])] }), 'full');
  assert.equal(full.coverage[0].status, 'FAIL');
  assert.equal(full.violations[0].existing, true);
});

test('a validated violation decides FAIL even if the AI wrote PASS', () => {
  const v = { file: input.file, line: 1, comment: 'Breaks the rule.', severity: 'warning' };
  const audit = parseAICoverage(JSON.stringify({ coverage: [response(semantic.id, 'PASS', [v])] }), input, snapshotRules([semantic]));
  assert.equal(audit.coverage[0].status, 'FAIL');
  assert.equal(audit.complete, true);
});

test('a deterministic violation stays FAIL when the rule is partial or the AI answer is unusable', async () => {
  const snapshot = snapshotRules([{ ...deterministic, checksComplete: false }]);
  const bad = { ...input, content: 'var a = 1;\n' };
  assert.equal(coreAudit(bad, snapshot).coverage[0].status, 'FAIL');
  const audit = await auditFile(bad, snapshot, async () => '{"coverage":[]}');
  assert.equal(audit.coverage[0].status, 'FAIL');
  assert.equal(audit.complete, false);
});

test('no AI call when the change adds no lines in changed scope', async () => {
  let calls = 0;
  const audit = await auditFile({ ...input, addedLines: [] }, snapshotRules([semantic]), async () => { calls++; return '{}'; });
  assert.equal(calls, 0);
  assert.equal(audit.coverage[0].status, 'NOT_APPLICABLE');
  assert.equal(audit.complete, true);
});

test('fully covered rules never reach the AI and are N/A where their checks cannot run', () => {
  const snapshot = snapshotRules([deterministic]);
  const json = { ...input, file: 'src/a.json', content: '{}' };
  assert.deepEqual(rulesForAI(json, snapshot), []);
  assert.equal(coreAudit(json, snapshot).coverage[0].status, 'NOT_APPLICABLE');
});

test('added lines are marked in the prompt content for changed scope only', () => {
  const file = { ...input, content: 'const a = 1;\nconst b = 2;', addedLines: [2] };
  const snapshot = snapshotRules([semantic]);
  assert.ok(buildHybridPrompt(file, snapshot, []).includes('L1: const a = 1;\nL2+: const b = 2;'));
  assert.ok(buildHybridPrompt(file, snapshot, [], 'full').includes('L2: const b = 2;'));
});

test('untargeted rules are N/A; a check with its own file scope still runs', () => {
  const snapshot = snapshotRules([{ ...semantic, targetFiles: ['*.tsx'] }, { ...deterministic, targetFiles: ['*.tsx'] }]);
  assert.ok(coreAudit(input, snapshot).coverage.every(c => c.status === 'NOT_APPLICABLE'));
  const explicit = snapshotRules([{ ...deterministic, targetFiles: ['*.tsx'], checks: [{ ...deterministic.checks![0], files: ['*.ts'] }] }]);
  assert.equal(coreAudit({ ...input, content: 'var a = 1;' }, explicit).coverage[0].status, 'FAIL');
});

test('explicit checks outside a partial rule semantic target are verified without unnecessary AI', async () => {
  const snapshot = snapshotRules([{ ...deterministic, checksComplete: false, targetFiles: ['*.tsx'],
    checks: [{ ...deterministic.checks![0], files: ['*.ts'] }] }]);
  let calls = 0;
  const ai = async () => { calls++; return '{}'; };
  const pass = await auditFile(input, snapshot, ai);
  assert.equal(pass.coverage[0].status, 'PASS');
  assert.equal(summarizeAudit([pass], snapshot).complete, true);
  const fail = await auditFile({ ...input, content: 'var a = 1;' }, snapshot, ai);
  assert.equal(fail.coverage[0].status, 'FAIL');
  assert.equal(calls, 0);
  const inside = await auditFile({ ...input, file: 'a.tsx' }, snapshot, ai);
  assert.equal(inside.coverage[0].status, 'UNVERIFIED');
  assert.equal(calls, 2);
});

test('invalid AI findings retain valid evidence but leave coverage unverified', () => {
  const violation = { file: input.file, line: 1, comment: 'Breaks the rule.', severity: 'error' };
  const audit = parseAICoverage(JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [violation, { ...violation, line: 99 }])] }), input, snapshotRules([semantic]));
  assert.equal(audit.violations.length, 1);
  assert.equal(audit.coverage[0].status, 'UNVERIFIED');
  assert.equal(audit.complete, false);
});

test('partial checks and unsupported syntax cannot claim full verification', () => {
  assert.equal(coreAudit(input, snapshotRules([{ ...deterministic, checksComplete: false }])).coverage[0].status, 'UNVERIFIED');
  // Checks only run on script files, so a fully covered rule has nothing to verify elsewhere.
  assert.equal(coreAudit({ ...input, file: 'a.py' }, snapshotRules([deterministic])).coverage[0].status, 'NOT_APPLICABLE');
});

test('a single follow-up requests only missing rules and merges their coverage', async () => {
  const second = { ...semantic, id: 'second', title: 'Second rule' };
  const snapshot = snapshotRules([semantic, second]);
  const requested: string[][] = [];
  const audit = await auditFile(input, snapshot, async (_, pending) => {
    requested.push(pending.rules.map(r => r.id));
    return JSON.stringify({ coverage: [response(requested.length === 1 ? semantic.id : second.id)] });
  });
  assert.deepEqual(requested, [['second', 'semantic'], ['second']]);
  assert.equal(audit.complete, true);
  assert.ok(audit.coverage.every(c => c.status === 'PASS'));
});

test('incomplete follow-up stops after two calls and never approves', async () => {
  let calls = 0;
  const snapshot = snapshotRules([semantic]);
  const audit = await auditFile(input, snapshot, async () => { calls++; return '{}'; });
  assert.equal(calls, 2);
  assert.equal(audit.coverage[0].status, 'UNVERIFIED');
  assert.equal(summarizeAudit([audit], snapshot).status, 'COMMENT');
});

test('failed follow-up preserves first-response findings and verified rules', async () => {
  const snapshot = snapshotRules([semantic, { ...semantic, id: 'missing' }]);
  let calls = 0;
  const audit = await auditFile(input, snapshot, async () => {
    if (++calls === 2) throw new Error('Provider unavailable');
    return JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [{ file: input.file, line: 1, severity: 'error', comment: 'Confirmed finding.' }])] });
  });
  assert.equal(calls, 2);
  assert.equal(audit.violations[0].comment, 'Confirmed finding.');
  assert.equal(audit.coverage.find(c => c.ruleId === semantic.id)?.status, 'FAIL');
  assert.equal(audit.coverage.find(c => c.ruleId === 'missing')?.status, 'UNVERIFIED');
  assert.equal(audit.complete, false);
});

test('transport errors do not trigger coverage follow-ups', async () => {
  let calls = 0;
  const audit = await auditFile(input, snapshotRules([semantic]), async () => { calls++; throw new Error('Blocked'); });
  assert.equal(calls, 1);
  assert.equal(audit.complete, false);
});

test('AI uses changed lines by default while core still audits existing code', async () => {
  const i = { ...input, content: 'var oldValue = 1;\nconst newValue = 2;\n', addedLines: [2], diff: '+ L2: const newValue = 2;' };
  const snapshot = snapshotRules([semantic, deterministic]);
  const oldFinding = { file: i.file, line: 1, severity: 'warning', comment: 'Old semantic finding.' };
  const ai = async () => JSON.stringify({ coverage: [response(semantic.id, 'FAIL', [oldFinding])] });
  const changed = await auditFile(i, snapshot, ai);
  assert.equal(changed.violations.filter(v => v.engine === 'ai').length, 0);
  assert.ok(changed.violations.some(v => v.engine === 'ast' && v.line === 1 && v.existing));
  const full = await auditFile(i, snapshot, ai, 'full');
  assert.ok(full.violations.some(v => v.engine === 'ai' && v.line === 1 && v.existing));
  const prompt = buildHybridPrompt(i, snapshot, []);
  assert.ok(prompt.includes('Scope: diff'));
  assert.ok(prompt.includes('L1: var oldValue = 1;'));
  assert.ok(buildHybridPrompt(i, snapshot, [], 'full').includes('Scope: full'));
});

test('finding limit retains unverified coverage for unscheduled files', async () => {
  const rules = snapshotRules([deterministic]);
  const inputs = ['a.ts', 'b.ts', 'c.ts'].map(file => ({ ...input, file, content: 'var a = 1;' }));
  let calls = 0;
  const result = await auditInputs(inputs, { rules, concurrency: 1, maxViolations: 1,
    signal: new AbortController().signal, quiet: true,
    audit: async file => { calls++; return coreAudit(file, rules); } });
  assert.equal(calls, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(result.audits.map(a => !!a.unaudited), [false, true, true]);
  const report = summarizeAudit(result.audits, rules, [], result.partial);
  assert.deepEqual(report.coverageSummary, { total: 3, verified: 1, notApplicable: 0, unverified: 2 });
  assert.equal(report.complete, false);
  assert.equal(summarizeAudit(result.audits, rules).complete, false);
});

test('coverage follow-ups share the file pool and account-block short circuit', async () => {
  const rules = snapshotRules([semantic]);
  const inputs = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(file => ({ ...input, file }));
  const attempts = new Map<string, number>();
  let active = 0, peak = 0;
  const result = await auditInputs(inputs, { rules, concurrency: 2,
    signal: new AbortController().signal, quiet: true,
    audit: file => auditFile(file, rules, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      const count = (attempts.get(file.file) || 0) + 1;
      attempts.set(file.file, count);
      return count === 1 ? '{}' : JSON.stringify({ coverage: [response(semantic.id)] });
    }),
  });
  assert.equal(peak, 2);
  assert.ok(result.audits.every(a => a.complete));
  assert.deepEqual([...attempts.values()], [2, 2, 2, 2]);

  let requests = 0;
  const blocked = stopAfterAccountBlock(async () => {
    if (++requests === 1) return '{}';
    throw new LLMHttpError(403, 'Forbidden');
  });
  const stopped = await auditInputs(inputs, { rules, concurrency: 1,
    signal: new AbortController().signal, quiet: true,
    audit: file => auditFile(file, rules, blocked) });
  assert.equal(requests, 2);
  assert.ok(stopped.audits.every(a => !a.complete));
});
