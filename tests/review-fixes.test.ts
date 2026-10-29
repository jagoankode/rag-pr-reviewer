import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { coreAudit, parseAICoverage, summarizeAudit, Finding, FileAudit } from '../src/core/review-engine.js';
import { snapshotRules } from '../src/core/review-rules.js';
import { parseAnnotatedDiffFiles, unquotePath } from '../src/core/diff-parser.js';
import { captureReviewInputs, ReviewInput } from '../src/core/review-input.js';
import { getGitDiff } from '../src/core/git.js';
import { readRepoContext, repoAudit } from '../src/core/checkers/git.js';
import { trimFindings } from '../src/commands/review.js';
import { formatReportToMarkdown } from '../src/core/history.js';
import { setLanguage } from '../src/core/i18n.js';
setLanguage('en');

const rules = snapshotRules([{ id: 'zz-decl', source: 'team', title: 'Z1 Declarations', content: 'Prefer const.', checksComplete: true, checks: [{ type: 'forbid-syntax', syntax: 'var', severity: 'error', message: 'Use const.' }] }]);
const input: ReviewInput = { file: 'src/widget.ts', content: 'const a = 1;\n', folderFiles: ['widget.ts'], addedLines: [1], diff: 'diff', scope: 'full', hash: 'x' };
const hit = (file: string, line: number, severity: 'error' | 'warning'): Finding =>
  ({ id: `${file}:${line}`, ruleId: 'zz-decl', rule: 'Z1 Declarations', file, line, column: 1, check: 'x', engine: 'ast', severity, comment: 'c', suggestedFix: null });

function repo(): { cwd: string; git: (...a: string[]) => string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-fixes-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 'dev@example.test'); git('config', 'user.name', 'Dev'); git('config', 'commit.gpgsign', 'false');
  return { cwd, git };
}

test('max-violations trimming keeps errors before warnings and exactly N findings', () => {
  const audits: FileAudit[] = [
    { file: 'a.ts', violations: [hit('a.ts', 1, 'warning'), hit('a.ts', 2, 'warning')], coverage: [], complete: true },
    { file: 'b.ts', violations: [hit('b.ts', 1, 'error'), hit('b.ts', 2, 'warning')], coverage: [], complete: true },
  ];
  const trimmed = trimFindings(audits, 2);
  assert.deepEqual(trimmed.flatMap(a => a.violations).map(v => v.id), ['a.ts:1', 'b.ts:1']);
  assert.equal(summarizeAudit(trimmed, rules).status, 'REQUEST_CHANGES');
  assert.equal(trimFindings(audits, 4)[0], audits[0]);
});

test('unaudited inputs leave the review incomplete even when the limit falls on a file boundary', () => {
  const clean = coreAudit(input, rules);
  assert.equal(summarizeAudit([clean], rules).complete, true);
  const partial = summarizeAudit([clean], rules, [], true);
  assert.equal(partial.complete, false);
  assert.equal(partial.status, 'COMMENT');
});

test('only skipped files with rules loaded is a complete review', () => {
  const gone: FileAudit = { file: 'old.ts', violations: [], coverage: [], complete: true, skipped: 'File deleted' };
  const result = summarizeAudit([gone], rules);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'APPROVE');
  assert.equal(summarizeAudit([], rules).complete, false);
});

test('AI FAIL whose violations are all invalid is incomplete, not PASS', () => {
  const s = snapshotRules([{ id: 'zz-sem', source: 'team', title: 'Z2 Semantics', content: 'Keep it pure.' }]);
  const raw = JSON.stringify({ coverage: [{ ruleId: 'zz-sem', status: 'FAIL', reason: 'bad', violations: [{ file: 'src/other.ts', line: 1, severity: 'error', comment: 'x' }] }] });
  const a = parseAICoverage(raw, input, s);
  assert.equal(a.complete, false);
  assert.equal(a.violations.length, 0);
  assert.notEqual(a.coverage[0].status, 'PASS');
});

test('no-newline marker, quoted paths, symlinks and submodules are captured correctly', async () => {
  const { cwd, git } = repo();
  const names = ['plain.ts', 'q"uote.ts', 'back\\slash.ts', 'tab\tname.ts', 'ünï.ts'];
  for (const n of names) fs.writeFileSync(path.join(cwd, n), 'a');
  git('add', '-A'); git('commit', '-qm', 'base');
  const sub = repo();
  sub.git('commit', '-q', '--allow-empty', '-m', 's1');
  git('update-index', '--add', '--cacheinfo', `160000,${sub.git('rev-parse', 'HEAD').trim()},vendored`);
  git('commit', '-qm', 'sub');
  git('checkout', '-qb', 'feature');
  for (const n of names) fs.writeFileSync(path.join(cwd, n), 'a\nb');
  fs.symlinkSync('plain.ts', path.join(cwd, 'alias.ts'));
  sub.git('commit', '-q', '--allow-empty', '-m', 's2');
  git('update-index', '--cacheinfo', `160000,${sub.git('rev-parse', 'HEAD').trim()},vendored`);
  git('add', '-A'); git('commit', '-qm', 'change');
  for (const opts of [{ source: 'feature', target: 'trunk' }, { target: 'trunk' }]) {
    const raw = await getGitDiff({ targetBranch: 'trunk', sourceBranch: opts.source, cwd });
    const diffs = parseAnnotatedDiffFiles(raw);
    assert.deepEqual(diffs.map(d => d.file).sort(), ['alias.ts', ...names, 'vendored'].sort());
    for (const i of captureReviewInputs(diffs, opts, cwd)) {
      if (i.file === 'alias.ts' || i.file === 'vendored') assert.ok(i.skipped, i.file);
      else { assert.equal(i.error, undefined, i.file); assert.deepEqual(i.addedLines, [1, 2], i.file); }
    }
  }
});

test('unquotePath decodes C-style escapes and octal UTF-8 bytes', () => {
  assert.equal(unquotePath('q\\"a\\\\b\\tc\\n.ts'), 'q"a\\b\tc\n.ts');
  assert.equal(unquotePath('\\303\\274.ts'), 'ü.ts');
  assert.equal(unquotePath('ünï.ts'), 'ünï.ts');
});

test('branch-name checks the reviewed source, not the checked-out branch', () => {
  const { cwd, git } = repo();
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const sha = git('rev-parse', 'HEAD').trim();
  git('branch', 'cafebabe');
  const refs = { head: sha, mergeBase: sha, mode: 'committed-pr' };
  assert.equal(readRepoContext(refs, 'cafebabe', cwd).branch, 'cafebabe');
  assert.equal(readRepoContext(refs, sha, cwd).branch, undefined);
  assert.equal(readRepoContext(refs, sha.slice(0, 8), cwd).branch, undefined);
  assert.equal(readRepoContext(refs, undefined, cwd).branch, 'trunk');
  const s = snapshotRules([{ id: 'zz-branch', source: 'team', title: 'Z3 Branches', content: 'Branch names.', checks: [{ type: 'branch-name', pattern: '^feature/', severity: 'error', message: 'Bad branch {name}.' }] }]);
  assert.deepEqual(repoAudit(s, readRepoContext(refs, 'cafebabe', cwd)).map(r => r.subject), ['cafebabe']);
  assert.deepEqual(repoAudit(s, readRepoContext(refs, sha, cwd)), []);
});

test('findings on lines the change did not add are listed apart and never affect the verdict', () => {
  const code = 'var a = 1;\nvar b = 2;\n';
  const audit = coreAudit({ ...input, content: code, addedLines: [2] }, rules);
  assert.deepEqual(audit.violations.map(v => [v.line, !!v.existing]), [[1, true], [2, false]]);
  const result = summarizeAudit([audit], rules);
  assert.deepEqual([result.violations.map(v => v.line), result.existingViolations!.map(v => v.line)], [[2], [1]]);
  assert.equal(result.status, 'REQUEST_CHANGES');
  assert.match(result.summary, /1 errors .* 1 more findings are in existing code/);

  const onlyOld = summarizeAudit([coreAudit({ ...input, content: code, addedLines: [] }, rules)], rules);
  assert.equal(onlyOld.status, 'APPROVE');
  assert.equal(onlyOld.violations.length, 0);
  assert.equal(onlyOld.existingViolations!.length, 2);
  const md = formatReportToMarkdown(onlyOld);
  for (const text of ['Findings in Existing Code (do not affect the status) (2)', '| `src/widget.ts` | 1 | error |']) assert.ok(md.includes(text), text);

  // Diff scope never reports existing code at all.
  assert.deepEqual(coreAudit({ ...input, content: code, addedLines: [2], scope: 'diff' }, rules).violations.map(v => [v.line, !!v.existing]), [[2, false]]);
});

test('max-violations trimming keeps changed-line findings before existing code', () => {
  const old = (file: string, line: number, severity: 'error' | 'warning'): Finding => ({ ...hit(file, line, severity), existing: true });
  const audits: FileAudit[] = [{ file: 'a.ts', violations: [old('a.ts', 1, 'error'), hit('a.ts', 2, 'warning'), old('a.ts', 3, 'warning'), hit('a.ts', 4, 'error')], coverage: [], complete: true }];
  assert.deepEqual(trimFindings(audits, 3)[0].violations.map(v => v.line), [1, 2, 4]);
  assert.deepEqual(trimFindings(audits, 2)[0].violations.map(v => v.line), [2, 4]);
});
