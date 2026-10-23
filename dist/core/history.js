"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveReportDir = resolveReportDir;
exports.formatReportToMarkdown = formatReportToMarkdown;
exports.saveReviewReport = saveReviewReport;
exports.listSavedReports = listSavedReports;
exports.deleteReportFile = deleteReportFile;
exports.clearAllReports = clearAllReports;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
function resolveReportDir(dirInput) {
    let cleaned = (dirInput || '.lumio-reviews').trim();
    if (cleaned.startsWith('~/') || cleaned === '~') {
        cleaned = path_1.default.join(os_1.default.homedir(), cleaned.slice(1));
    }
    return path_1.default.isAbsolute(cleaned) ? cleaned : path_1.default.resolve(process.cwd(), cleaned);
}
/**
 * Mengubah PRReviewResult menjadi dokumen Markdown murni (100% Plain Markdown, tanpa tag HTML)
 */
function formatReportToMarkdown(result, options = {}) {
    const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    let targetLabel = 'Uncommitted working directory changes';
    if (options.sourceBranch && options.targetBranch) {
        targetLabel = `PR Diff: \`${options.targetBranch}\` <- \`${options.sourceBranch}\``;
    }
    else if (options.branch) {
        targetLabel = `Branch Diff: \`${options.branch}\``;
    }
    else if (options.staged) {
        targetLabel = 'Staged changes (`--staged`)';
    }
    const statusLabel = result.status === 'APPROVE'
        ? '**APPROVE (LGTM)**'
        : result.status === 'REQUEST_CHANGES'
            ? '**REQUEST CHANGES**'
            : '**COMMENT**';
    let md = `# Lumio - Pull Request Review Report

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
    }
    else {
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
    md += `\n\n*Audited by Lumio (https://github.com/jagoankode/rag-pr-reviewer)*\n`;
    return md;
}
/**
 * Menyimpan report markdown ke direktori proyek lokal
 */
async function saveReviewReport(result, options = {}) {
    const dir = resolveReportDir(options.outputDir);
    await fs_1.promises.mkdir(dir, { recursive: true });
    let safeName = 'local';
    if (options.sourceBranch && options.targetBranch) {
        safeName = `${options.targetBranch}_vs_${options.sourceBranch}`;
    }
    else if (options.branch) {
        safeName = options.branch;
    }
    else if (options.staged) {
        safeName = 'staged';
    }
    safeName = safeName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `lumio-review-${safeName}-${timestamp}.md`;
    const fullPath = path_1.default.join(dir, filename);
    const markdownContent = formatReportToMarkdown(result, options);
    await fs_1.promises.writeFile(fullPath, markdownContent, 'utf-8');
    return fullPath;
}
/**
 * Mengambil daftar history report review yang tersimpan
 */
async function listSavedReports(dirPath) {
    const dir = resolveReportDir(dirPath);
    try {
        const files = await fs_1.promises.readdir(dir);
        const mdFiles = files.filter((f) => f.endsWith('.md'));
        const reports = await Promise.all(mdFiles.map(async (filename) => {
            const fullPath = path_1.default.join(dir, filename);
            const stat = await fs_1.promises.stat(fullPath);
            return { filename, fullPath, date: stat.mtime };
        }));
        return reports.sort((a, b) => b.date.getTime() - a.date.getTime());
    }
    catch {
        return [];
    }
}
/**
 * Menghapus satu file report
 */
async function deleteReportFile(filePath) {
    await fs_1.promises.unlink(filePath);
}
/**
 * Menghapus semua file report di dalam direktori
 */
async function clearAllReports(dirPath) {
    const dir = resolveReportDir(dirPath);
    try {
        const files = await fs_1.promises.readdir(dir);
        const mdFiles = files.filter((f) => f.endsWith('.md'));
        for (const f of mdFiles) {
            await fs_1.promises.unlink(path_1.default.join(dir, f));
        }
        return mdFiles.length;
    }
    catch {
        return 0;
    }
}
