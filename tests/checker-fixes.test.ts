import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRules, ReviewRule } from '../src/core/review-rules.js';
import { ReviewInput } from '../src/core/review-input.js';
import { runChecks } from '../src/core/checkers/index.js';
import { matchGlob } from '../src/core/checkers/glob.js';

// Fictional checks only: every case below is a regression of a checker bug, not anyone's convention.
const run = (file: string, content: string, spec: Record<string, unknown>, folderFiles: string[] = []): string[] => {
  const snapshot = snapshotRules([{ id: 'X1', title: 'X1 Fixture', content: '.', source: 'code-convention', status: 'ACTIVE',
    checks: [{ id: 'c', severity: 'error', message: '{value}', ...spec }] } as ReviewRule]);
  assert.ok(snapshot.rules[0].checks, 'check spec is valid');
  const input: ReviewInput = { file, content, folderFiles, addedLines: [], diff: '', scope: 'full', hash: '' };
  return runChecks(input, snapshot).map(h => `${h.line}:${h.column} ${h.comment}`);
};
const lines = (hits: string[]) => hits.map(h => Number(h.split(':')[0]));
const syntax = (s: string, extra: Record<string, unknown> = {}) => ({ type: 'forbid-syntax', syntax: s, ...extra });

test('naming: an empty test title is checked instead of dropping the file', () => {
  assert.deepEqual(lines(run('a.test.ts', "it('', () => {});\nit('bad', () => {});\nit('should pass', () => {});\n",
    { type: 'naming', target: 'test-title', callees: ['it'], pattern: '^should' })), [1, 2]);
});

test('todo-without-ticket: alternatives in ticketPattern are grouped', () => {
  const hits = run('a.ts', '// TODO(QRS-1) a\n// TODO(TUV-2) b\n// TODO(other) c\n', syntax('todo-without-ticket', { ticketPattern: 'QRS-\\d+|TUV-\\d+' }));
  assert.deepEqual(lines(hits), [3]);
});

test('forbid-import: module specifiers are matched whole', () => {
  const code = "import a from './lib/fetcher';\nimport b from 'kit/fp';\nimport c from 'fetcher';\nimport d from 'kit/fp/x';\n";
  assert.deepEqual(lines(run('src/a.ts', code, { type: 'forbid-import', from: ['fetcher', 'fp'] })), [3]);
  assert.deepEqual(lines(run('src/a.ts', code, { type: 'forbid-import', from: ['**/fetcher', 'kit/**'] })), [1, 2, 3, 4]);
});

test('non-export-statement: declarations with an export modifier are exports', () => {
  const code = "export const a = 1;\nexport function f() {}\nexport type T = string;\nexport interface I {}\nexport class C {}\nexport enum E { A }\nexport default function g() {}\nexport { b } from './b';\nconst hidden = 1;\n";
  assert.deepEqual(lines(run('index.ts', code, syntax('non-export-statement'))), [9]);
});

test('commented-out-code: prose starting with a keyword is not code', () => {
  const code = [
    '// if the user is not logged in, redirect', '// return early when empty', '// for each item we log once', '// import the data first',
    '// const a = 1;', '// foo();', '// <Panel />', '// if (!ready) return;', "// import x from 'y'", '// return value;', '// let total = 0',
  ].join('\n') + '\n';
  assert.deepEqual(lines(run('a.tsx', code, syntax('commented-out-code'))), [5, 6, 7, 8, 9, 10, 11]);
});

test('jsx: only the outermost element; DOM createElement is not JSX', () => {
  assert.equal(run('a.tsx', 'export const A = () => <div>{x && <span/>}<B icon={<C/>}/></div>;\n', syntax('jsx')).length, 1);
  assert.deepEqual(lines(run('a.ts', "const el = document.createElement('div');\nconst r = React.createElement('p', null, createElement('i'));\nconst s = createElement('b');\n", syntax('jsx'))), [2, 3]);
});

test('runtime-logic: prologue directives are not runtime logic', () => {
  assert.deepEqual(run('a.tsx', "'use client';\nexport type T = string;\n", syntax('runtime-logic')), []);
  assert.deepEqual(lines(run('a.tsx', "export type T = string;\n'use client';\n", syntax('runtime-logic'))), [2]);
});

test('magic-number: negative literals are compared and reported signed', () => {
  const code = 'if (x === -1) {}\nif (y > 1) {}\n';
  assert.deepEqual(run('a.ts', code, syntax('magic-number', { allow: ['-1'] })), ['2:9 1']);
  assert.deepEqual(run('a.ts', code, syntax('magic-number', { allow: ['1'] })), ['1:11 -1']);
});

test('comments: JSX text is not a comment', () => {
  assert.deepEqual(run('a.tsx', 'export const A = () => <p>// TODO later</p>;\n', syntax('todo-without-ticket')), []);
  assert.deepEqual(run('a.tsx', 'export const B = () => <code>// foo();</code>;\n', syntax('commented-out-code')), []);
  assert.deepEqual(lines(run('a.tsx', 'export const C = () => <p>{/* TODO later */}</p>;\n', syntax('todo-without-ticket'))), [1]);
});

test('semicolon: a class property typed with an object literal still needs one', () => {
  const code = 'class A {\n  x: { a: number }\n  y: { a: number };\n  z = 1\n  m() {}\n  get g() { return 1; }\n  static {}\n}\nconst o = { a() {}, b: { c: 1 } };\n';
  assert.deepEqual(lines(run('a.ts', code, { type: 'format', rule: 'semicolon' })), [2, 4]);
});

test('eof-newline: CRLF endings', () => {
  const eof = { type: 'format', rule: 'eof-newline' };
  assert.deepEqual(lines(run('a.ts', 'const a = 1;\r\n\r\n', eof)), [2]);
  assert.deepEqual(run('a.ts', 'const a = 1;\r\n', eof), []);
  assert.deepEqual(run('a.ts', 'const a = 1;\r\nconst b = 2;', eof).map(h => h.split(' ')[0]), ['2:13']);
});

test('blank-line-before: a code line ending in a block comment is code', () => {
  const spec = { type: 'format', rule: 'blank-line-before', keywords: ['return'] };
  assert.deepEqual(lines(run('a.ts', 'function f() {\n  const a = 1;\n\n  const b = 2; /* x */\n  return a;\n}\n', spec)), [5]);
  assert.deepEqual(run('a.ts', 'function f() {\n  const a = 1;\n\n  /* note\n     more */\n  return a;\n}\n', spec), []);
  assert.deepEqual(lines(run('a.ts', 'function f() {\n  const a = 1;\n  /* note\n     more */\n  return a;\n}\n', spec)), [5]);
});

test('require-jsdoc tagFormat: indented tags are checked', () => {
  const spec = { type: 'require-jsdoc', tagFormat: true };
  assert.equal(run('a.ts', '/**\n *   @param a desc\n */\nexport function f(a: string) {}\n', spec).length, 1);
  assert.deepEqual(run('a.ts', '/**\n *   @param {string} a - Desc\n */\nexport function f(a: string) {}\n', spec), []);
});

test('glob: basename or path is decided per brace alternative', () => {
  assert.equal(matchGlob('src/x/a.ts', '{*.ts,lib/**}'), true);
  assert.equal(matchGlob('lib/y/b.md', '{*.ts,lib/**}'), true);
  assert.equal(matchGlob('src/y/b.md', '{*.ts,lib/**}'), false);
});

test('forbid-type: spacing inside braces and generics does not matter', () => {
  const hits = run('a.ts', 'let a: { } = x;\nlet b: {} = x;\nlet c: {a:number} = x;\nlet d: Map<string,number> = x;\n',
    { type: 'forbid-type', types: ['{}', '{ a: number }', 'Map<string, number>'] });
  assert.deepEqual(lines(hits), [1, 2, 3, 4]);
});

test('hook-name-without-hook-call: a function named exactly `use` is skipped', () => {
  const spec = syntax('hook-name-without-hook-call', { message: '{plain}' });
  assert.deepEqual(run('a.ts', 'function use() { return 1; }\n', spec), []);
  assert.deepEqual(run('a.ts', 'function useTotal() { return 1; }\n', spec), ['1:1 total']);
});

test('require-files: `?` in an anchor is a one-character wildcard', () => {
  const spec = { type: 'require-files', anchors: ['{name}.v?ew.tsx'], required: [{ file: '{name}.test.tsx' }] };
  assert.equal(run('src/a.view.tsx', 'export {};\n', spec, ['a.view.tsx']).length, 1);
  assert.deepEqual(run('src/a.view.tsx', 'export {};\n', spec, ['a.view.tsx', 'a.test.tsx']), []);
});
