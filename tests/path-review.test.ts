import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getGitDiff } from '../src/core/git.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Git diff with specific paths', () => {
  it('scopes diff output to the specified file or folder', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-path-test-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });

      fs.mkdirSync(path.join(tmpDir, 'src', 'auth'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src', 'billing'), { recursive: true });

      fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'login.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(tmpDir, 'src', 'billing', 'invoice.ts'), 'export const b = 2;\n');

      execFileSync('git', ['add', '.'], { cwd: tmpDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      fs.appendFileSync(path.join(tmpDir, 'src', 'auth', 'login.ts'), 'export const a2 = 2;\n');
      fs.appendFileSync(path.join(tmpDir, 'src', 'billing', 'invoice.ts'), 'export const b2 = 3;\n');

      const authDiff = await getGitDiff({ cwd: tmpDir, paths: ['src/auth'] });
      assert.strictEqual(authDiff.includes('src/auth/login.ts'), true);
      assert.strictEqual(authDiff.includes('src/billing/invoice.ts'), false);

      const allDiff = await getGitDiff({ cwd: tmpDir });
      assert.strictEqual(allDiff.includes('src/auth/login.ts'), true);
      assert.strictEqual(allDiff.includes('src/billing/invoice.ts'), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
