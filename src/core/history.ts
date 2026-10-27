import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { PRReviewResult } from './schema.js';
import { out } from './i18n.js';

export interface SaveReportOptions {
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  staged?: boolean;
  model?: string;
  outputDir?: string;
}

export function resolveReportDir(dirInput?: string): string {
  let cleaned = (dirInput || '.lumio-reviews').trim();
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

  let targetLabel = out('mdTargetUncommitted');
  if (options.sourceBranch && options.targetBranch) {
    targetLabel = `${out('mdTargetPr')}: \`${options.targetBranch}\` <- \`${options.sourceBranch}\``;
  } else if (options.branch) {
    targetLabel = `${out('mdTargetBranch')}: \`${options.branch}\``;
  } else if (options.staged) {
    targetLabel = out('mdTargetStaged');
  }

  const statusLabel =
    result.status === 'APPROVE'
      ? '**APPROVE (LGTM)**'
      : result.status === 'REQUEST_CHANGES'
      ? '**REQUEST CHANGES**'
      : '**COMMENT**';

  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  let md = `# ${out('mdTitle')}

- **${out('mdDate')}:** ${dateStr}
- **${out('mdTarget')}:** ${targetLabel}
- **Status:** ${statusLabel}
- **${out('mdModel')}:** \`${options.model || 'default'}\`

## ${out('mdSummary')}

${result.summary}
`;

  if (result.repository?.length) {
    md += `\n## ${out('mdRepo')} (${result.repository.length})\n\n| ${out('mdSeverity')} | ${out('mdSubject')} | ${out('mdComment')} | ${out('mdFix')} |\n| --- | --- | --- | --- |\n`;
    for (const r of result.repository) md += `| ${r.severity} | \`${cell(r.subject)}\` | ${cell(r.comment)} | ${cell(r.suggestedFix || '-')} |\n`;
  }

  md += `\n## ${out('mdViolations')} (${result.violations.length})\n`;
  if (result.violations.length === 0) {
    md += `\n*${out('mdNoViolations')}${result.complete === false ? out('mdIncomplete') : ''}*\n`;
  } else {
    const byFile = new Map<string, typeof result.violations>();
    for (const v of result.violations) byFile.set(v.file, [...(byFile.get(v.file) || []), v]);
    for (const [file, items] of byFile) {
      md += `\n### \`${file}\`\n\n| ${out('mdLine')} | ${out('mdSeverity')} | ${out('mdRule')} | ${out('mdComment')} | ${out('mdFix')} |\n| ---: | --- | --- | --- | --- |\n`;
      for (const v of items) {
        md += `| ${v.line} | ${v.severity} | ${cell(v.rule)} | ${cell(v.comment)} | ${cell(v.suggestedFix || '-')} |\n`;
      }
    }
  }

  if (result.coverage?.length) {
    const perRule = new Map<string, { fail: number; pass: number; na: number }>();
    for (const c of result.coverage) {
      const entry = perRule.get(c.ruleId) || { fail: 0, pass: 0, na: 0 };
      if (c.status === 'FAIL') entry.fail++; else if (c.status === 'PASS') entry.pass++; else entry.na++;
      perRule.set(c.ruleId, entry);
    }
    const titles = new Map(result.violations.map(v => [v.ruleId, v.rule]));
    md += `\n## ${out('mdCoverage')}\n\n| ${out('mdRule')} | FAIL | PASS | N/A |\n| --- | ---: | ---: | ---: |\n`;
    for (const [ruleId, e] of perRule) md += `| ${cell(titles.get(ruleId || '') || ruleId)} | ${e.fail} | ${e.pass} | ${e.na} |\n`;
  }
  if (result.skippedFiles?.length) {
    md += `\n## ${out('mdSkipped')}\n\n`;
    for (const s of result.skippedFiles) md += `- \`${s.file}\`: ${s.reason}\n`;
  }
  if (result.notes?.length) {
    md += `\n## ${out('mdNotes')}\n\n`;
    for (const note of result.notes) md += `- ${note}\n`;
  }
  if (result.reviewSnapshot) {
    const s = result.reviewSnapshot;
    md += `
## ${out('mdReproducibility')}

- **Review ID:** \`${s.fingerprint}\`
- **Base:** \`${s.base}\`
- **Head:** \`${s.head}\`
- **Merge base:** \`${s.mergeBase}\`
- **Engine:** \`${s.engine}\`
- **Rules:** \`${s.rules}\`
- **Input digest:** \`${s.inputs}\`
- **Mode / scope:** ${s.mode} / ${s.scope}
`;
  }
  md += `\n\n*${out('mdFooter')} (https://github.com/jagoankode/rag-pr-reviewer)*\n`;
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
  const filename = `lumio-review-${safeName}-${timestamp}.md`;
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
