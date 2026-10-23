"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUserPath = resolveUserPath;
exports.isWebUrl = isWebUrl;
exports.fetchUrlContent = fetchUrlContent;
exports.ingestCommand = ingestCommand;
exports.ingestDirectRuleCommand = ingestDirectRuleCommand;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const fs_1 = require("fs");
const chunker_js_1 = require("../core/chunker.js");
const db_js_1 = require("../core/db.js");
function resolveUserPath(inputPath) {
    let cleaned = inputPath.trim();
    if (cleaned.startsWith('~/') || cleaned === '~') {
        cleaned = path_1.default.join(os_1.default.homedir(), cleaned.slice(1));
    }
    return path_1.default.resolve(process.cwd(), cleaned);
}
function isWebUrl(input) {
    const trimmed = input.trim();
    return /^https?:\/\//i.test(trimmed);
}
async function fetchUrlContent(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; LumioBot/2.0; +https://github.com/jagoankode/rag-pr-reviewer)',
            'Accept': 'text/plain, text/markdown, text/html, application/json',
        },
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const text = await res.text();
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const title = pathParts.length > 0 ? pathParts[pathParts.length - 1] : parsedUrl.hostname;
    return { title, content: text };
}
async function ingestCommand(targetPath) {
    const trimmed = targetPath.trim();
    const isUrl = isWebUrl(trimmed);
    if (isUrl) {
        const spinner = (0, ora_1.default)(chalk_1.default.blue(`Mengambil konten dokumen dari URL: ${trimmed}...`)).start();
        try {
            const { title, content } = await fetchUrlContent(trimmed);
            const chunks = (0, chunker_js_1.chunkMarkdown)(content, trimmed);
            if (chunks.length === 0) {
                spinner.warn(chalk_1.default.yellow('Konten dari URL kosong atau teks tidak cukup panjang untuk diproses.'));
                return false;
            }
            spinner.text = chalk_1.default.cyan(`Memeriksa duplikasi & menyimpan chunks baru...`);
            const result = await (0, db_js_1.insertChunks)(chunks);
            if (result.insertedCount === 0 && result.duplicateCount > 0) {
                spinner.info(chalk_1.default.yellow(`Semua (${result.duplicateCount}) aturan dari URL sudah ada di database (ditolak agar tidak duplikat).`));
            }
            else {
                spinner.succeed(chalk_1.default.green(`Berhasil meng-ingest ${result.insertedCount} aturan baru dari URL!` +
                    (result.duplicateCount > 0
                        ? chalk_1.default.gray(` (${result.duplicateCount} aturan duplikat ditolak/dilewati)`)
                        : '')));
            }
            return true;
        }
        catch (error) {
            spinner.fail(chalk_1.default.red(`Gagal meng-ingest dokumen dari URL: ${error.message}`));
            return false;
        }
    }
    const resolvedPath = resolveUserPath(targetPath);
    const spinner = (0, ora_1.default)(chalk_1.default.blue(`Scanning files at: ${resolvedPath}...`)).start();
    try {
        const files = await (0, chunker_js_1.scanDocFiles)(resolvedPath);
        if (files.length === 0) {
            spinner.warn(chalk_1.default.yellow(`Tidak ditemukan file dokumen (.md, .txt) di: ${resolvedPath}`));
            return false;
        }
        spinner.text = chalk_1.default.blue(`Membaca dan memotong dokumen dari ${files.length} file...`);
        let allChunks = [];
        for (const file of files) {
            const content = await fs_1.promises.readFile(file, 'utf-8');
            const chunks = (0, chunker_js_1.chunkMarkdown)(content, file);
            allChunks.push(...chunks);
        }
        if (allChunks.length === 0) {
            spinner.warn(chalk_1.default.yellow('File kosong atau teks tidak cukup panjang untuk di-chunk.'));
            return false;
        }
        spinner.text = chalk_1.default.cyan(`Memeriksa duplikasi & menyimpan chunks baru...`);
        const result = await (0, db_js_1.insertChunks)(allChunks);
        if (result.insertedCount === 0 && result.duplicateCount > 0) {
            spinner.info(chalk_1.default.yellow(`Semua (${result.duplicateCount}) aturan sudah ada di database (ditolak agar tidak duplikat).`));
        }
        else {
            spinner.succeed(chalk_1.default.green(`Berhasil menyimpan ${result.insertedCount} aturan baru!` +
                (result.duplicateCount > 0
                    ? chalk_1.default.gray(` (${result.duplicateCount} aturan duplikat ditolak/dilewati)`)
                    : '')));
        }
        return true;
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Gagal meng-ingest dokumen: ${error.message}`));
        return false;
    }
}
/**
 * Ingest aturan langsung lewat percakapan/input teks bebas
 */
async function ingestDirectRuleCommand(title, content) {
    const spinner = (0, ora_1.default)(chalk_1.default.blue('Memeriksa duplikasi & menyimpan aturan baru ke LanceDB...')).start();
    try {
        const chunk = {
            id: `rule_${Date.now()}`,
            source: 'manual_conversation',
            title: title.trim(),
            content: content.trim(),
        };
        const result = await (0, db_js_1.insertChunks)([chunk]);
        if (result.insertedCount === 0) {
            spinner.info(chalk_1.default.yellow(`Aturan serupa sudah tersimpan sebelumnya (ditolak agar tidak duplikat).`));
        }
        else {
            spinner.succeed(chalk_1.default.green(`Aturan "${title}" berhasil disimpan ke knowledge RAG!`));
        }
        return true;
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Gagal menyimpan aturan: ${error.message}`));
        return false;
    }
}
