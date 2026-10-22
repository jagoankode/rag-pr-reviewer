"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkMarkdown = chunkMarkdown;
exports.scanDocFiles = scanDocFiles;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/**
 * Memotong dokumen markdown berdasarkan header (#, ##, ###)
 * agar konteks aturan/guideline tidak terputus di tengah kalimat.
 */
function chunkMarkdown(content, sourcePath) {
    const lines = content.split('\n');
    const chunks = [];
    let currentTitle = path_1.default.basename(sourcePath, path_1.default.extname(sourcePath));
    let currentBuffer = [];
    let chunkIndex = 0;
    const flush = () => {
        const text = currentBuffer.join('\n').trim();
        if (text.length > 30) {
            chunks.push({
                id: `${path_1.default.basename(sourcePath)}#${chunkIndex++}`,
                source: sourcePath,
                title: currentTitle,
                content: text,
            });
        }
        currentBuffer = [];
    };
    for (const line of lines) {
        const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (headerMatch) {
            flush();
            currentTitle = `${path_1.default.basename(sourcePath)} > ${headerMatch[2].trim()}`;
            currentBuffer.push(line);
        }
        else {
            currentBuffer.push(line);
        }
    }
    flush();
    return chunks;
}
/**
 * Scan direktori secara rekursif untuk mencari file .md / .markdown / .txt
 */
async function scanDocFiles(dirPath) {
    const results = [];
    async function walk(currentDir) {
        const entries = await fs_1.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', 'dist'].includes(entry.name)) {
                    await walk(fullPath);
                }
            }
            else if (entry.isFile()) {
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (['.md', '.markdown', '.txt'].includes(ext)) {
                    results.push(fullPath);
                }
            }
        }
    }
    const stat = await fs_1.promises.stat(dirPath);
    if (stat.isFile()) {
        results.push(dirPath);
    }
    else {
        await walk(dirPath);
    }
    return results;
}
