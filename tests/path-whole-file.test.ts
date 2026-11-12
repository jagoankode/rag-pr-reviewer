import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanTargetFiles, createSyntheticFullFileDiffs } from '../src/core/path-scanner.js';

test('scanTargetFiles collects files recursively ignoring node_modules and dotfiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-scan-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'nested', 'util.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '[core]');

    const scanned = scanTargetFiles(['src'], tmpDir);
    assert.deepEqual(scanned, ['src/index.ts', 'src/nested/util.ts']);

    const single = scanTargetFiles(['src/index.ts'], tmpDir);
    assert.deepEqual(single, ['src/index.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createSyntheticFullFileDiffs creates annotated diff with all lines marked added', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-diff-test-'));
  try {
    const file = 'test.ts';
    const content = 'const x = 10;\nconsole.log(x);';
    fs.writeFileSync(path.join(tmpDir, file), content);

    const diffs = createSyntheticFullFileDiffs([file], tmpDir);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].file, file);
    assert.equal(diffs[0].addedLinesCount, 2);
    assert.match(diffs[0].annotatedText, /\+ L1: const x = 10;/);
    assert.match(diffs[0].annotatedText, /\+ L2: console\.log\(x\);/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
