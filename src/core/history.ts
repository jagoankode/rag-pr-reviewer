import { promises as fs } from 'fs';
import path from 'path';
import { PRReviewResult } from './schema.js';

export interface SaveReportOptions {
  branch?: string;
  staged?: boolean;
  model?: string;
  outputDir?: string;
}

/**
 * Mengubah PRReviewResult menjadi dokumen Markdown yang rapi dan terstruktur
 */
export function formatReportToMarkdown(
  result: PRReviewResult,
  options: SaveReportOptions = {}
): string {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const targetLabel = options.branch
    ? `Branch: \`${options.branch}\``
    : options.staged
    ? 'Staged changes (`--staged`)'
    : 'Uncommitted working directory changes';

  const statusBadge =
    result.status === 'APPROVE'
      ? '🟢 **APPROVE (LGTM)**'
      : result.status === 'REQUEST_CHANGES'
      ? '🔴 **REQUEST CHANGES**'
      : '🟡 **COMMENT**';

  let md = `# 📋 Pull Request Review Report

- **Date:** ${dateStr}
- **Target:** ${targetLabel}
- **Status:** ${statusBadge}
- **Model:** \`${options.model || 'default'}\`

---

## 📌 Executive Summary
${result.summary}

---

## 🚨 Line-by-Line Code Convention Violations (${result.violations.length})
`;

  if (result.violations.length === 0) {
    md += `\n> ✨ *Tidak ada pelanggaran convention yang ditemukan pada baris yang diubah.*\n`;
  } else {
    result.violations.forEach((v, index) => {
      const severityIcon =
        v.severity === 'error' ? '🔴 **ERROR**' : v.severity === 'warning' ? '🟡 **WARN**' : '🔵 **INFO**';

      md += `
### ${index + 1}. \`${v.file}\` (Line ${v.line})
- **Severity:** ${severityIcon}
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
    md += `\n## 💡 General Architecture Notes\n`;
    result.generalFeedback.forEach((note) => {
      md += `- ${note}\n`;
    });
  }

  md += `\n\n*Generated locally with [pr-rag](https://github.com/jagoankode/rag-pr-reviewer)*\n`;
  return md;
}

/**
 * Menyimpan report markdown ke direktori proyek lokal
 */
export async function saveReviewReport(
  result: PRReviewResult,
  options: SaveReportOptions = {}
): Promise<string> {
  const dir = options.outputDir || path.join(process.cwd(), '.rag-reviews');
  await fs.mkdir(dir, { recursive: true });

  const safeBranch = (options.branch || (options.staged ? 'staged' : 'local'))
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `review-${safeBranch}-${timestamp}.md`;
  const fullPath = path.join(dir, filename);

  const markdownContent = formatReportToMarkdown(result, options);
  await fs.writeFile(fullPath, markdownContent, 'utf-8');

  return fullPath;
}

/**
 * Mengambil daftar history report review yang tersimpan
 */
export async function listSavedReports(dirPath?: string): Promise<{ filename: string; fullPath: string; date: Date }[]> {
  const dir = dirPath || path.join(process.cwd(), '.rag-reviews');
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
