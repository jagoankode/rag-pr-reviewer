import parseDiff from 'parse-diff';

export interface DiffLine {
  file: string;
  lineNumber: number;
  content: string;
  type: 'add' | 'del' | 'normal';
}

export interface AnnotatedFileDiff {
  file: string;
  annotatedText: string;
  addedLinesCount: number;
  unavailable?: string;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undoes git's C-style path quoting (`"`, `\\`, control and, without core.quotePath=false, non-ASCII bytes). Git never emits a raw backslash in a path. */
export function unquotePath(name: string): string {
  if (!name.includes('\\')) return name;
  const bytes: number[] = [], chars = Array.from(name);
  for (let i = 0; i < chars.length; i++) {
    const octal = chars[i] === '\\' ? /^[0-3][0-7]{2}/.exec(chars.slice(i + 1, i + 4).join('')) : null;
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; }
    else if (chars[i] === '\\' && chars[i + 1] in ESCAPES) bytes.push(ESCAPES[chars[++i]]);
    else bytes.push(...Buffer.from(chars[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parses raw git diff and annotates each file individually with exact line numbers.
 * Returning per-file blocks enables granular real-time progress indicators (e.g. [1/50] src/payment.ts).
 */
export function parseAnnotatedDiffFiles(rawDiff: string): AnnotatedFileDiff[] {
  const parsedFiles = parseDiff(rawDiff);
  const result: AnnotatedFileDiff[] = [];

  for (const file of parsedFiles) {
    const filePath = unquotePath(file.deleted ? file.from || 'unknown' : file.to || file.from || 'unknown');
    // Skip deleted files, binary files without change chunks, symlinks and submodule (gitlink) bumps
    const mode = (file as { newMode?: string }).newMode;
    if (file.deleted || file.chunks.length === 0 || mode === '120000' || mode === '160000') {
      result.push({ file: filePath, annotatedText: `### File: ${filePath}`, addedLinesCount: 0, unavailable: file.deleted ? 'File deleted' : 'Binary or metadata-only change' });
      continue;
    }

    const fileLines: string[] = [`### File: ${filePath}`];
    let addedCount = 0;

    for (const chunk of file.chunks) {
      fileLines.push(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`);

      for (const change of chunk.changes) {
        // `\ No newline at end of file` is a marker, not a line of the file.
        if (change.content.startsWith('\\')) continue;
        if (change.type === 'add') {
          addedCount++;
          fileLines.push(`+ L${change.ln}: ${change.content.replace(/^\+/, '')}`);
        } else if (change.type === 'del') {
          fileLines.push(`- (old): ${change.content.replace(/^-/, '')}`);
        } else {
          fileLines.push(`  L${change.ln2 ?? change.ln1}: ${change.content}`);
        }
      }
    }

    result.push({
      file: filePath,
      annotatedText: fileLines.join('\n'),
      addedLinesCount: addedCount,
    });
  }

  return result;
}

/**
 * Legacy combined annotator
 */
export function annotateDiffWithLineNumbers(rawDiff: string): { annotatedText: string; files: string[] } {
  const fileDiffs = parseAnnotatedDiffFiles(rawDiff);
  return {
    annotatedText: fileDiffs.map((f) => f.annotatedText).join('\n\n'),
    files: fileDiffs.map((f) => f.file),
  };
}
