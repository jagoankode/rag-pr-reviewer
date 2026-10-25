import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { AnnotatedFileDiff } from './diff-parser.js';

export interface ReviewInput {
  file: string; content: string; folderFiles: readonly string[]; addedLines: readonly number[];
  diff: string; scope: 'full' | 'diff'; hash: string; error?: string;
}
/** Freeze source/index/worktree content and sibling inventory before the first AI call. */
export function captureReviewInputs(diffs: AnnotatedFileDiff[], options: { staged?: boolean; source?: string; target?: string; scope?: 'full' | 'diff' }, cwd = process.cwd()): ReviewInput[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const revision = !options.staged && options.source && options.target ? git(['rev-parse', '--verify', `${options.source}^{commit}`]).trim() : undefined;
  const tree = options.staged ? ':' : revision;
  const inventory = tree ? git(options.staged ? ['ls-files', '-z'] : ['ls-tree', '-r', '--name-only', '-z', tree]).split('\0').filter(Boolean) : undefined;
  return diffs.map(d => {
    let content = '', folderFiles: string[] = [], error: string | undefined;
    try {
      if (d.unavailable) throw new Error(d.unavailable);
      const absolute = path.resolve(root, d.file);
      if (absolute === root || !absolute.startsWith(root + path.sep)) throw new Error('Unsafe file path');
      if (tree) {
        content = git(['show', `${options.staged ? '' : tree}:${d.file}`]);
        folderFiles = inventory!.filter(f => path.posix.dirname(f) === path.posix.dirname(d.file)).map(f => path.posix.basename(f));
      } else {
        if (!fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('File escapes repository');
        content = fs.readFileSync(absolute, 'utf8');
        folderFiles = fs.readdirSync(path.dirname(absolute), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
      }
      const lines = content.split('\n');
      for (const m of d.annotatedText.matchAll(/^\+ L(\d+): (.*)$/gm)) {
        if (lines[Number(m[1])-1]?.replace(/\r$/, '') !== m[2].replace(/\r$/, '')) throw new Error('Diff/content mismatch; inputs changed during capture');
      }
    } catch (e) { error = `Input unavailable: ${(e as Error).message}`; }
    const input = { file: d.file, content, folderFiles: Object.freeze(folderFiles.sort()), addedLines: Object.freeze([...d.annotatedText.matchAll(/^\+ L(\d+):/gm)].map(m => Number(m[1]))), diff: d.annotatedText, scope: options.scope || 'full' as const, error };
    return Object.freeze({ ...input, hash: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
  });
}
