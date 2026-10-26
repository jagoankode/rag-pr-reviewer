import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { snapshotRules, ReviewRule } from '../src/core/review-rules.js';
import { auditFile, coreAudit, deterministicAudit, parseAICoverage, rulesForAI, summarizeAudit } from '../src/core/review-engine.js';
import { ReviewInput, captureReviewInputs } from '../src/core/review-input.js';
import { parseAnnotatedDiffFiles } from '../src/core/diff-parser.js';
import { buildHybridPrompt } from '../src/core/review-prompt.js';
import { repoAudit } from '../src/core/checkers/git.js';
import { matchGlob } from '../src/core/checkers/glob.js';
import { parseChecks } from '../src/core/checkers/spec.js';

// Fixtures describe a fictional team on purpose: the engine must not know any real team's conventions.
const rule = (title: string, content: string, extra: Record<string, unknown> = {}): ReviewRule => ({ id: title.split(' ')[0], title, content, source: 'code-convention', status: 'ACTIVE', ...extra } as ReviewRule);
const check = (spec: Record<string, unknown>) => ({ severity: 'error', message: '{text}', ...spec });
const TYPING = rule('T1 Typing', 'No loose types.', { checks: [
  check({ type: 'forbid-type', id: 'forbidden-type', types: ['any', 'unknown', '{}', 'Record<string, unknown>'] }),
  check({ type: 'forbid-syntax', id: 'assertion', syntax: 'type-assertion' }),
  check({ type: 'forbid-syntax', id: 'non-null', syntax: 'non-null-assertion' }),
] });
const FORMAT = rule('T2 Formatting', 'Formatting.', { checksComplete: true, checks: [
  check({ type: 'format', rule: 'semicolon', id: 'semicolon' }),
  check({ type: 'format', rule: 'curly', id: 'curly' }),
  check({ type: 'format', rule: 'blank-line-before', id: 'blank', keywords: ['return', 'if'] }),
  check({ type: 'format', rule: 'eof-newline', id: 'eof' }),
] });
const SEMANTIC = rule('T9 Pure Functions', 'Extract pure functions out of the component body.');

const input = (content: string, extra: Partial<ReviewInput> = {}): ReviewInput => ({ file: 'src/a.ts', content, folderFiles: [], addedLines: [], diff: '', scope: 'full', hash: '', ...extra });
const checks = (content: string, rules: ReviewRule[], extra: Partial<ReviewInput> = {}) => deterministicAudit(input(content, extra), snapshotRules(rules)).map(v => `${v.line}:${v.check}`);
const aiResponse = (ruleId: string, status = 'PASS', violations: unknown[] = []) => JSON.stringify({ coverage: [{ ruleId, status, reason: 'checked', violations }] });

test('a rule without checks is never enforced deterministically, whatever its prose says', () => {
  assert.deepEqual(checks('var a: any = 1;\n', [rule('X1 Basics', 'Never use `var`. Forbidden types and patterns:\n - `any`')]), []);
});

test('checks payload is validated; invalid entries are skipped and reported, JSON strings accepted', () => {
  const { checks: ok, errors } = parseChecks([check({ type: 'forbid-syntax', syntax: 'var' }), { type: 'forbid-syntax', syntax: 'nope', severity: 'error', message: 'x' }, { type: 'unknown-primitive' }]);
  assert.equal(ok.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(parseChecks(JSON.stringify([check({ type: 'forbid-syntax', syntax: 'var' })])).checks.length, 1);
  assert.deepEqual(parseChecks('{oops').errors, ['checks: not valid JSON']);
  const s = snapshotRules([rule('X2 Bad', 'x', { checks: [{ type: 'forbid-call' }] })]);
  assert.equal(s.rules[0].checks, undefined);
  assert.ok(summarizeAudit([], s).notes!.some(n => n.includes('X2 Bad')));
  assert.notEqual(snapshotRules([TYPING]).hash, snapshotRules([{ ...TYPING, checks: [] }]).hash);
});

test('snapshot is exhaustive, sorted, frozen and filters inactive/system rules', () => {
  const s = snapshotRules([rule('z', 'x'), rule('off', 'x', { status: 'DISABLED' }), rule('sys', 'x', { source: 'system-prompt' }), rule('a', 'x')]);
  assert.deepEqual(s.rules.map(r => r.id), ['a', 'z']);
  assert.ok(Object.isFrozen(s.rules[0]));
  assert.equal(s.hash, snapshotRules([...s.rules].reverse()).hash);
  assert.throws(() => snapshotRules([TYPING, TYPING]));
});

test('glob: basename patterns, ** directories, braces; plain names match whole', () => {
  assert.ok(matchGlob('src/a/b/x.view.tsx', '*.view.tsx'));
  assert.ok(matchGlob('src/a/b/x.view.tsx', 'src/**/*.view.{ts,tsx}'));
  assert.ok(matchGlob('src/x.ts', 'src/**/*.ts'));
  assert.ok(!matchGlob('lib/x.ts', 'src/**'));
  assert.ok(matchGlob('release/1.2', 'release/*', false));
  assert.ok(!matchGlob('feat/develop', 'develop', false));
});

test('forbid-type and assertions: outermost type once, `as const` allowed, double assertion once, comments ignored', () => {
  const code = '// any unknown as X !\nconst s: string = "any unknown";\nlet a: any;\nconst k = ["x"] as const;\nconst v = a as string;\nconst w = a as unknown as number;\nconst n = a!.b;\ntype R = Record<string,unknown>;\ntype E = {};\n';
  assert.deepEqual(checks(code, [TYPING]), ['3:forbidden-type', '5:assertion', '6:assertion', '7:non-null', '8:forbidden-type', '9:forbidden-type']);
});

test('explicit-types and require-jsdoc: per-case messages and severities, callback summary, ignored calls', () => {
  const r = rule('T3 Signatures', 'Typed and documented.', { checks: [
    check({ type: 'explicit-types', id: 'types', callbacks: 'summary', ignoreInsideCalls: ['lazy'], message: 'untyped {name}', messages: { callbacks: '{count} callbacks on {lines}' }, severities: { callbacks: 'warning' } }),
    check({ type: 'require-jsdoc', id: 'doc', tagFormat: true, ignoreInsideCalls: ['lazy'] }),
    check({ type: 'forbid-syntax', id: 'order', syntax: 'optional-parameter-before-required' }),
  ] });
  const code = [
    'const add = (a, b) => a + b;',
    '/**',
    ' * Doubles items',
    ' * @param {number[]} items - Items',
    ' * @return {number[]} doubled',
    ' */',
    'export const double = (items: number[]): number[] => items.map((x) => x * 2).filter((x) => x > 0);',
    "const Page = lazy(() => import('./Page'));",
    '/**',
    ' * Pads a value',
    ' * @param {string} value - Value',
    ' * @param {number} size - Size',
    ' * @returns {string} - Padded value',
    ' */',
    'const pad = (value: string, size: number = 2, mode: string): string => value;',
    '',
  ].join('\n');
  const found = checks(code, [r]);
  for (const expected of ['1:types:return', '1:types:parameter', '1:doc:missing', '5:doc:return-tag', '7:types:callbacks', '12:doc:optional', '15:order']) assert.ok(found.includes(expected), `${expected} in ${found}`);
  assert.equal(found.filter(c => c.endsWith('callbacks')).length, 1);
  assert.ok(!found.some(c => c.startsWith('8:')));
  const audit = deterministicAudit(input(code), snapshotRules([r]));
  assert.equal(audit.find(v => v.check === 'types:callbacks')!.comment, '2 callbacks on 7');
  assert.equal(audit.find(v => v.check === 'types:return')!.comment, 'untyped add');
  assert.equal(audit.find(v => v.check === 'types:callbacks')!.severity, 'warning');
  assert.equal(audit.find(v => v.check === 'types:return')!.severity, 'error');
});

test('format: semicolons, curly braces, blank line before listed keywords, end-of-file newline', () => {
  const code = 'const a = 1\nconst f = (): number => {\n  const b = 2;\n  if (b) return b;\n  // explain\n  return a;\n};\nconst g = (): number => {\n  return 1;\n};';
  assert.deepEqual(checks(code, [FORMAT]).sort(), ['1:semicolon', '10:eof:missing', '4:blank', '4:curly', '6:blank'].sort());
});

test('calls and directives are scoped by the file globs the team declares', () => {
  const r = rule('T4 Views', 'Views are pure.', { checks: [
    check({ type: 'forbid-call', id: 'view-hook', names: ['use*', 'React.use*'], files: ['*.view.tsx'], message: 'hook {name} in view' }),
    check({ type: 'forbid-call', id: 'mock', names: ['jest.mock'], argument: '^\\./.*\\.util$', files: ['*.test.ts'] }),
    check({ type: 'require-directive', id: 'client', directive: 'use client', ifCalls: ['use*'], files: ['*.store.tsx'] }),
    check({ type: 'forbid-directive', id: 'no-client', directives: ['use client'], files: ['*.view.tsx'] }),
    check({ type: 'forbid-syntax', id: 'prologue', syntax: 'misplaced-directive' }),
    check({ type: 'forbid-syntax', id: 'hook-name', syntax: 'hook-name-without-hook-call' }),
  ] });
  const view = "'use client';\nexport const V = (): null => { const [v] = React.useState(0); return null; };\n";
  assert.deepEqual(checks(view, [r], { file: 'src/x/A.view.tsx' }), ['1:no-client', '2:view-hook']);
  assert.equal(deterministicAudit(input(view, { file: 'src/x/A.view.tsx' }), snapshotRules([r])).find(v => v.check === 'view-hook')!.comment, 'hook React.useState in view');
  assert.deepEqual(checks(view, [r], { file: 'src/x/A.other.tsx' }), []);
  assert.deepEqual(checks("jest.mock('./a.util');\njest.mock('axios');\n", [r], { file: 'src/a.test.ts' }), ['1:mock']);
  assert.deepEqual(checks('export const S = (): null => { useX(); return null; };\n', [r], { file: 'src/A.store.tsx' }), ['1:client']);
  assert.deepEqual(checks("import a from 'a';\n'use client';\n", [r], { file: 'src/A.tsx' }), ['2:prologue']);
  assert.deepEqual(checks('export const useFormat = (d: string): string => d.trim();\n', [r]), ['1:hook-name']);
});

test('jsx and fallback syntax', () => {
  const r = rule('T5 Rendering', 'Rendering.', { checks: [
    check({ type: 'forbid-syntax', id: 'wrapper', syntax: 'jsx-inline-handler-wrapper' }),
    check({ type: 'forbid-syntax', id: 'and', syntax: 'jsx-and-number' }),
    check({ type: 'forbid-syntax', id: 'fallback', syntax: 'fallback', getters: ['get'], files: ['*.view.tsx'] }),
    check({ type: 'forbid-syntax', id: 'or', syntax: 'or-fallback', exclude: ['*.view.tsx'] }),
    check({ type: 'forbid-call', id: 'fetch', names: ['fetch', 'window.fetch'] }),
  ] });
  const code = "export const C = (p: P): JSX.Element => <div onClick={() => p.go()}>{p.items.length && <b />}{p.title ?? '-'}{get(p, 'a', 1)}{fetch('/x')}</div>;\n";
  assert.deepEqual(checks(code, [r], { file: 'src/A.view.tsx' }).sort(), ['1:and', '1:fallback', '1:fallback', '1:fetch', '1:wrapper'].sort());
  assert.deepEqual(checks("const t = p.title || '-';\n", [r], { file: 'src/a.ts' }), ['1:or']);
});

test('forbid-import: module globs, exclusions, private names, type-only imports', () => {
  const r = rule('T6 Imports', 'Imports.', { checks: [
    check({ type: 'forbid-import', id: 'lib', from: ['@testing-library/*'], exclude: ['src/test-kit/**'] }),
    check({ type: 'forbid-import', id: 'private', names: ['_*'], allowOwnTest: true }),
  ] });
  const code = "import { render } from '@testing-library/react';\nimport type { Q } from '@testing-library/dom';\nimport { _calc, ok } from './x.util';\n";
  assert.deepEqual(checks(code, [r], { file: 'src/a.test.ts' }), ['1:lib', '3:private']);
  assert.deepEqual(checks(code, [r], { file: 'src/x.util.test.ts' }), ['1:lib']);
  assert.deepEqual(checks(code, [r], { file: 'src/test-kit/index.ts' }), ['3:private']);
});

test('naming targets with team patterns', () => {
  const r = rule('T7 Naming', 'Naming.', { checks: [
    check({ type: 'naming', id: 'bool', target: 'boolean', pattern: '^(is|has)[A-Z]', stateHooks: ['useState'], message: 'rename {name}', fix: 'is{Name}' }),
    check({ type: 'naming', id: 'type', target: 'type', pattern: '^[A-Z]' }),
    check({ type: 'naming', id: 'schema', target: 'schema', pattern: 'Schema$', factories: ['z'] }),
    check({ type: 'naming', id: 'title', target: 'test-title', pattern: '^should ', callees: ['it'] }),
    check({ type: 'naming', id: 'abbr', target: 'identifier', forbidden: ['usr'] }),
    check({ type: 'naming', id: 'short', target: 'variable', forbiddenPattern: '^[a-z]$', ignoreLoopVariables: true }),
  ] });
  const code = "const open = true;\nconst [busy, setBusy] = useState(false);\ntype row = {};\nconst user = z.object({});\nit('works', () => {});\nconst usr = 1;\nconst x = 2;\nfor (const i of []) {}\n";
  assert.deepEqual(checks(code, [r]), ['1:bool', '2:bool', '3:type', '4:schema', '5:title', '6:abbr', '7:short']);
  assert.equal(deterministicAudit(input(code), snapshotRules([r]))[0].suggestedFix, 'isOpen');
});

test('require-files: units from anchors, conditional siblings, brace extensions, scoped folders, diff scope', () => {
  const r = rule('T8 Feature Layout', 'Features.', { checks: [check({ type: 'require-files', files: ['src/features/**'], anchors: ['{name}.view.tsx', '{name}.store.ts'],
    required: [{ file: '{name}.store.ts' }, { file: '{name}.view.test.{ts,tsx}' }, { file: '{name}.api.test.ts', if: '{name}.api.ts' }], message: '{name} needs {file}' })] });
  const run = (file: string, folderFiles: string[], extra: Partial<ReviewInput> = {}) => checks('', [r], { file, folderFiles, ...extra });
  const files = ['Card.view.tsx', 'Card.view.test.tsx'];
  assert.deepEqual(run('src/features/a/Card.view.tsx', files), ['1:require-files:missing:Card.store.ts']);
  assert.equal(run('src/features/a/Card.view.tsx', [...files, 'Card.api.ts']).length, 2);
  assert.deepEqual(run('src/features/a/Card.store.ts', [...files, 'Card.store.ts']), []);
  assert.deepEqual(run('src/other/Card.view.tsx', files), []);
  assert.deepEqual(run('src/features/a/Card.view.tsx', files, { scope: 'diff', addedLines: [2] }), []);
  assert.equal(deterministicAudit(input('', { file: 'src/features/a/Card.view.tsx', folderFiles: files }), snapshotRules([r]))[0].engine, 'filesystem');
});

test('comments and magic values', () => {
  const r = rule('T10 Comments', 'Comments.', { checks: [
    check({ type: 'forbid-syntax', id: 'block', syntax: 'block-comment' }),
    check({ type: 'forbid-syntax', id: 'dead', syntax: 'commented-out-code' }),
    check({ type: 'forbid-syntax', id: 'todo', syntax: 'todo-without-ticket', ticketPattern: 'ABC-\\d+' }),
    check({ type: 'forbid-syntax', id: 'num', syntax: 'magic-number', allow: ['0', '1'] }),
    check({ type: 'forbid-syntax', id: 'str', syntax: 'magic-string' }),
  ] });
  const code = "/* note */\n// const old = 1;\n// TODO: later\n// TODO(ABC-1): fine\nconst t = d * 86400;\nconst LIMIT = 5 * 2;\nif (role === 'admin') {}\n/** doc */\nconst e = <a>{/* jsx */}</a>;\n";
  assert.deepEqual(checks(code, [r], { file: 'src/a.tsx' }), ['1:block', '2:dead', '3:todo', '5:num', '7:str']);
});

test('diff scope only reports added lines; parse errors produce no findings and an incomplete audit', () => {
  assert.deepEqual(checks('let x: any;\nlet y: any;\n', [TYPING], { scope: 'diff', addedLines: [2] }), ['2:forbidden-type']);
  assert.deepEqual(checks('let x: any = (', [TYPING]), []);
  assert.equal(coreAudit(input('let x: any = ('), snapshotRules([TYPING])).complete, false);
});

test('AI findings count toward the verdict; invalid ones are dropped individually', async () => {
  const s = snapshotRules([SEMANTIC]);
  const v = { file: 'src/a.ts', line: 1, column: 1, severity: 'error', comment: 'Pure function inside component.' };
  const failed = await auditFile(input('const a = 1;\n'), s, async () => aiResponse(SEMANTIC.id, 'FAIL', [v, { ...v, line: 99 }, { ...v, file: '../x' }]));
  assert.equal(failed.violations.length, 1);
  assert.equal(failed.violations[0].engine, 'ai');
  assert.equal(summarizeAudit([failed], s).status, 'REQUEST_CHANGES');
  const clean = await auditFile(input('const a = 1;\n'), s, async () => aiResponse(SEMANTIC.id));
  assert.equal(summarizeAudit([clean], s).status, 'APPROVE');
});

test('AI outage or malformed response keeps deterministic findings and never approves', async () => {
  const s = snapshotRules([SEMANTIC]);
  for (const ai of [async () => { throw new Error('offline'); }, async () => '{"coverage": [', async () => '{}']) {
    const a = await auditFile(input('const a = 1;\n'), s, ai);
    assert.equal(a.complete, false);
    assert.equal(summarizeAudit([a], s).status, 'COMMENT');
  }
  const typing = snapshotRules([TYPING, SEMANTIC]);
  const a = await auditFile(input('let x: any;\n'), typing, async () => { throw new Error('offline'); });
  assert.ok(a.violations.some(v => v.check === 'forbidden-type'));
  assert.equal(summarizeAudit([a], typing).status, 'REQUEST_CHANGES');
});

test('AI repeat of a deterministic finding is dropped; fully covered rules are not sent to AI', async () => {
  const s = snapshotRules([TYPING, FORMAT]);
  assert.deepEqual(rulesForAI(input(''), s).map(r => r.id), [TYPING.id]);
  const i = input('let a: any;\n');
  const det = deterministicAudit(i, s).find(v => v.check === 'forbidden-type')!;
  const a = await auditFile(i, s, async () => aiResponse(TYPING.id, 'FAIL', [{ file: 'src/a.ts', line: det.line, column: 1, severity: 'error', comment: 'any again' }]));
  assert.equal(a.violations.filter(v => v.line === det.line && v.ruleId === TYPING.id).length, a.violations.filter(v => v.line === det.line && v.ruleId === TYPING.id && v.engine === 'ast').length);
});

test('verdict: errors request changes, warnings comment, skipped files never block', () => {
  const s = snapshotRules([SEMANTIC]);
  const skipped = { file: 'gone.ts', violations: [], coverage: [], complete: false, skipped: 'File deleted' };
  const clean = { file: 'a.ts', violations: [], coverage: [], complete: true };
  assert.equal(summarizeAudit([clean, skipped], s).status, 'APPROVE');
  assert.equal(summarizeAudit([skipped], s).status, 'COMMENT');
  assert.equal(summarizeAudit([], snapshotRules([])).status, 'COMMENT');
  const repo = [{ ruleId: 'x', rule: 'x', check: 'branch-name' as const, severity: 'error' as const, subject: 'b', comment: 'c', suggestedFix: null }];
  assert.equal(summarizeAudit([clean], s, repo).status, 'REQUEST_CHANGES');
});

test('branch and commit names follow the patterns the rules declare', () => {
  const s = snapshotRules([rule('G1 Branches', 'Branch naming.', { checks: [
    check({ type: 'branch-name', pattern: '^(feat|fix)/ABC-\\d+-[a-z0-9-]+$', allow: ['develop', 'release/*'], message: 'bad branch {name}', fix: 'git branch -m feat/ABC-1-{slug}' }),
    check({ type: 'commit-message', pattern: '^(feat|fix)\\([a-z-]+\\): \\[ABC-\\d+\\] \\S' }),
  ] })]);
  const commits = [{ sha: 'a1', subject: 'feat(rates): [ABC-1] add rate' }, { sha: 'b2', subject: 'fix stuff' }];
  assert.deepEqual(repoAudit(s, { branch: 'origin/feat/ABC-1-add-rate', commits }).map(f => `${f.check}:${f.subject}`), ['commit-message:b2 fix stuff']);
  const bad = repoAudit(s, { branch: 'chore/ABC-1-X', commits: [] });
  assert.deepEqual([bad[0].check, bad[0].comment, bad[0].suggestedFix], ['branch-name', 'bad branch chore/ABC-1-X', 'git branch -m feat/ABC-1-abc-1-x']);
  assert.deepEqual(repoAudit(s, { branch: 'release/1.2', commits: [] }), []);
  assert.equal(repoAudit(s, { branch: 'main', commits: [] }).length, 1);
  assert.deepEqual(repoAudit(snapshotRules([SEMANTIC]), { branch: 'whatever', commits }), []);
});

test('review prompt asks for English comments and has no team-specific focus list', () => {
  const prompt = buildHybridPrompt(input('const a = 1;\n'), snapshotRules([SEMANTIC]), []);
  assert.match(prompt, /Write "comment" in English:/);
  assert.match(prompt, /Focus on the clauses of each rule that a parser cannot decide\./);
});

test('single-pass prompt interpolation cannot substitute placeholders inside code', () => {
  assert.ok(buildHybridPrompt(input('const x="{{RULES}}"'), snapshotRules([SEMANTIC]), []).includes('const x="{{RULES}}"'));
});

test('AI coverage parser rejects unknown statuses and duplicate entries as incomplete', () => {
  const s = snapshotRules([SEMANTIC]);
  for (const raw of ['{}', aiResponse(SEMANTIC.id, 'MAYBE'), JSON.stringify({ coverage: [...JSON.parse(aiResponse(SEMANTIC.id)).coverage, ...JSON.parse(aiResponse(SEMANTIC.id)).coverage] })]) {
    assert.equal(parseAICoverage(raw, input('x'), s).complete, false);
  }
  assert.equal(parseAICoverage('Here you go:\n' + aiResponse(SEMANTIC.id), input('x'), s).complete, true);
});

test('capture staged and source branch content rather than unrelated worktree; deleted files are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-review-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\n'); fs.writeFileSync(path.join(dir, 'old.ts'), 'x\n'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'let a: any;\n'); git('rm', '-q', 'old.ts'); git('add', '.');
    const diffs = parseAnnotatedDiffFiles(git('diff', '--staged'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'worktree');
    const staged = captureReviewInputs(diffs, { staged: true }, dir);
    assert.equal(staged.find(i => i.file === 'a.ts')!.content, 'let a: any;\n');
    assert.equal(staged.find(i => i.file === 'old.ts')!.skipped, 'File deleted');
    git('commit', '-qm', 'source'); const source = git('rev-parse', 'HEAD').trim();
    const branch = captureReviewInputs(diffs, { source, target: base }, dir);
    assert.deepEqual(branch.find(i => i.file === 'a.ts')!.folderFiles, ['a.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
