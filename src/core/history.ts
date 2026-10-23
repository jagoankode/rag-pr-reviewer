import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { PRReviewResult } from './schema.js';

export interface SaveReportOptions {
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  staged?: boolean;
  model?: string;
  outputDir?: string;
}

export function resolveReportDir(dirInput?: string): string {
  let cleaned = (dirInput || '.rag-reviews').trim();
  if (cleaned.startsWith('~/') || cleaned === '~') {
    cleaned = path.join(os.homedir(), cleaned.slice(1));
  }
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(process.cwd(), cleaned);
}

/**
 * Mengubah PRReviewResult menjadi dokumen Markdown murni (100% Plain Markdown, tanpa tag HTML)
 */
export function formatReportToMarkdown(
  result: PRReviewResult,
  options: SaveReportOptions = {}
): string {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

  let targetLabel = 'Uncommitted working directory changes';
  if (options.sourceBranch && options.targetBranch) {
    targetLabel = `PR Diff: \`${options.targetBranch}\` <- \`${options.sourceBranch}\``;
  } else if (options.branch) {
    targetLabel = `Branch Diff: \`${options.branch}\``;
  } else if (options.staged) {
    targetLabel = 'Staged changes (`--staged`)';
  }

  const statusLabel =
    result.status === 'APPROVE'
      ? '**APPROVE (LGTM)**'
      : result.status === 'REQUEST_CHANGES'
      ? '**REQUEST CHANGES**'
      : '**COMMENT**';

  let md = `# Pull Request Review Report

- **Date:** ${dateStr}
- **Target:** ${targetLabel}
- **Status:** ${statusLabel}
- **Model:** \`${options.model || 'default'}\`

---

## Executive Summary

${result.summary}

---

## Line-by-Line Code Convention Violations (${result.violations.length})
`;

  if (result.violations.length === 0) {
    md += `\n*Tidak ada pelanggaran code convention yang ditemukan pada baris yang diubah.*\n`;
  } else {
    result.violations.forEach((v, index) => {
      const severity = v.severity.toUpperCase();

      md += `
### ${index + 1}. \`${v.file}\` (Line ${v.line})

- **Severity:** [${severity}]
- **Rule:** \`${v.rule}\`
- **Comment:** ${v.comment}
`;
      if (v.suggestedFix) {
        md += `
**Suggested Fix:**

\`\`\`typescript
${v.suggestedFix}
\`\`\`
`;
      }
      md += `\n---\n`;
    });
  }

  if (result.generalFeedback && result.generalFeedback.length > 0) {
    md += `\n## General Architecture Notes\n\n`;
    result.generalFeedback.forEach((note) => {
      md += `- ${note}\n`;
    });
  }

  md += `\n\n*Generated locally with pr-rag (https://github.com/jagoankode/rag-pr-reviewer)*\n`;
  return md;
}

/**
 * Menyimpan report markdown ke direktori proyek lokal
 */
export async function saveReviewReport(
  result: PRReviewResult,
  options: SaveReportOptions = {}
): Promise<string> {
  const dir = resolveReportDir(options.outputDir);
  await fs.mkdir(dir, { recursive: true });

  let safeName = 'local';
  if (options.sourceBranch && options.targetBranch) {
    safeName = `${options.targetBranch}_vs_${options.sourceBranch}`;
  } else if (options.branch) {
    safeName = options.branch;
  } else if (options.staged) {
    safeName = 'staged';
  }
  safeName = safeName.replace(/[^a-zA-Z0-9_-]/g, '_');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `review-${safeName}-${timestamp}.md`;
  const fullPath = path.join(dir, filename);

  const markdownContent = formatReportToMarkdown(result, options);
  await fs.writeFile(fullPath, markdownContent, 'utf-8');

  return fullPath;
}

/**
 * Mengambil daftar history report review yang tersimpan
 */
export async function listSavedReports(dirPath?: string): Promise<{ filename: string; fullPath: string; date: Date }[]> {
  const dir = resolveReportDir(dirPath);
  try {
    const files = await fs.readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const reports = await Promise.all(
      mdFiles.map(async (filename) => {
        const fullPath = path.join(dir, filename);
        const stat = await fs.stat(fullPath);
        return { filename, fullPath, date: stat.mtime };
      })
    );
    return reports.sort((a, b) => b.date.getTime() - a.date.getTime());
  } catch {
    return [];
  }
}

/**
 * Menghapus satu file report
 */
export async function deleteReportFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

/**
 * Menghapus semua file report di dalam direktori
 */
export async function clearAllReports(dirPath?: string): Promise<number> {
  const dir = resolveReportDir(dirPath);
  try {
    const files = await fs.readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    for (const f of mdFiles) {
      await fs.unlink(path.join(dir, f));
    }
    return mdFiles.length;
  } catch {
    return 0;
  }
}
