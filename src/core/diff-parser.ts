import parseDiff from 'parse-diff';

export interface DiffLine {
  file: string;
  lineNumber: number;
  content: string;
  type: 'add' | 'del' | 'normal';
}

export interface AnnotatedDiffFile {
  file: string;
  lines: string; // File diff with line numbers prepended: "L20: const a: any = 123;"
}

/**
 * Parses raw git diff and annotates each added/modified line with its exact line number
 * so the LLM can precisely reference the line of violation.
 */
export function annotateDiffWithLineNumbers(rawDiff: string): { annotatedText: string; files: string[] } {
  const parsedFiles = parseDiff(rawDiff);
  const annotatedBlocks: string[] = [];
  const fileNames: string[] = [];

  for (const file of parsedFiles) {
    const filePath = file.to || file.from || 'unknown';
    fileNames.push(filePath);

    const fileLines: string[] = [`### File: ${filePath}`];

    for (const chunk of file.chunks) {
      fileLines.push(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`);
      
      for (const change of chunk.changes) {
        if (change.type === 'add') {
          fileLines.push(`+ L${change.ln}: ${change.content.replace(/^\+/, '')}`);
        } else if (change.type === 'del') {
          fileLines.push(`- (old): ${change.content.replace(/^-/, '')}`);
        } else {
          fileLines.push(`  L${change.ln2 ?? change.ln1}: ${change.content}`);
        }
      }
    }

    annotatedBlocks.push(fileLines.join('\n'));
  }

  return {
    annotatedText: annotatedBlocks.join('\n\n'),
    files: fileNames,
  };
}
