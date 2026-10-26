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

/**
 * Parses raw git diff and annotates each file individually with exact line numbers.
 * Returning per-file blocks enables granular real-time progress indicators (e.g. [1/50] src/payment.ts).
 */
export function parseAnnotatedDiffFiles(rawDiff: string): AnnotatedFileDiff[] {
  const parsedFiles = parseDiff(rawDiff);
  const result: AnnotatedFileDiff[] = [];

  for (const file of parsedFiles) {
    const filePath = file.deleted ? file.from || 'unknown' : file.to || file.from || 'unknown';
    // Skip deleted files or binary files without change chunks
    if (file.deleted || file.chunks.length === 0) {
      result.push({ file: filePath, annotatedText: `### File: ${filePath}`, addedLinesCount: 0, unavailable: file.deleted ? 'File deleted' : 'Binary or metadata-only change' });
      continue;
    }

    const fileLines: string[] = [`### File: ${filePath}`];
    let addedCount = 0;

    for (const chunk of file.chunks) {
      fileLines.push(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`);

      for (const change of chunk.changes) {
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
