import fs from 'fs';
import path from 'path';
import { AnnotatedFileDiff } from './diff-parser.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.lumio',
  '.lumio-reviews',
  'coverage',
  '.next',
  '.turbo',
]);

/**
 * Scan target paths and return list of relative file paths.
 */
export function scanTargetFiles(targets: string[], rootDir = process.cwd()): string[] {
  const filePaths = new Set<string>();

  for (const raw of targets) {
    const resolved = path.resolve(rootDir, raw);
    if (!fs.existsSync(resolved)) continue;

    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      filePaths.add(path.relative(rootDir, resolved).split(path.sep).join('/'));
    } else if (stat.isDirectory()) {
      walkDir(resolved, rootDir, filePaths);
    }
  }

  return Array.from(filePaths).sort();
}

function walkDir(dir: string, rootDir: string, collector: Set<string>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, rootDir, collector);
    } else if (entry.isFile()) {
      collector.add(path.relative(rootDir, fullPath).split(path.sep).join('/'));
    }
  }
}

/**
 * Synthesize AnnotatedFileDiff for a list of whole files so full file audit
 * works without requiring any git diff changes.
 */
export function createSyntheticFullFileDiffs(files: string[], rootDir = process.cwd()): AnnotatedFileDiff[] {
  const diffs: AnnotatedFileDiff[] = [];

  for (const file of files) {
    const absPath = path.resolve(rootDir, file);
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      const annotatedLines: string[] = [`### File: ${file}`];
      annotatedLines.push(`@@ -0,0 +1,${lines.length} @@`);

      for (let i = 0; i < lines.length; i++) {
        annotatedLines.push(`+ L${i + 1}: ${lines[i].replace(/\r$/, '')}`);
      }

      diffs.push({
        file,
        annotatedText: annotatedLines.join('\n'),
        addedLinesCount: lines.length,
      });
    } catch (e: any) {
      diffs.push({
        file,
        annotatedText: `### File: ${file}`,
        addedLinesCount: 0,
        unavailable: `Cannot read file: ${e.message}`,
      });
    }
  }

  return diffs;
}
