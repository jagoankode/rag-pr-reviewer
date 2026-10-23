"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanFeatureCodeFiles = scanFeatureCodeFiles;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const SUPPORTED_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.go', '.py', '.java', '.kt', '.rs', '.php',
    '.cs', '.rb', '.sql'
]);
const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    '.rag-reviews', '.openclaw', '.cache', 'coverage',
    'vendor', '__pycache__', '.venv', '.idea', '.vscode'
]);
/**
 * Scan folder fitur/layer lokal dan baca isi source code (dibatasi agar efisien & hemat token)
 */
async function scanFeatureCodeFiles(targetPath, maxFiles = 20, maxBytesPerFile = 30000) {
    const files = [];
    async function walk(currentDir) {
        if (files.length >= maxFiles)
            return;
        let entries;
        try {
            entries = await fs_1.promises.readdir(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= maxFiles)
                break;
            const fullPath = path_1.default.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) {
                    await walk(fullPath);
                }
            }
            else if (entry.isFile()) {
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTS.has(ext)) {
                    try {
                        const stat = await fs_1.promises.stat(fullPath);
                        if (stat.size > 0 && stat.size <= maxBytesPerFile) {
                            const content = await fs_1.promises.readFile(fullPath, 'utf-8');
                            const relPath = path_1.default.relative(targetPath, fullPath);
                            files.push({
                                relativePath: relPath || entry.name,
                                absolutePath: fullPath,
                                ext,
                                content,
                            });
                        }
                    }
                    catch {
                        // Abaikan file yang gagal dibaca
                    }
                }
            }
        }
    }
    const stat = await fs_1.promises.stat(targetPath);
    if (stat.isFile()) {
        const content = await fs_1.promises.readFile(targetPath, 'utf-8');
        files.push({
            relativePath: path_1.default.basename(targetPath),
            absolutePath: targetPath,
            ext: path_1.default.extname(targetPath).toLowerCase(),
            content,
        });
    }
    else {
        await walk(targetPath);
    }
    return files;
}
