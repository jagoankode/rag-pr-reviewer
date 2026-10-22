"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUserPath = resolveUserPath;
exports.ingestCommand = ingestCommand;
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
async function ingestCommand(targetPath) {
    const resolvedPath = resolveUserPath(targetPath);
    const spinner = (0, ora_1.default)(chalk_1.default.blue(`Scanning files at: ${resolvedPath}...`)).start();
    try {
        const files = await (0, chunker_js_1.scanDocFiles)(resolvedPath);
        if (files.length === 0) {
            spinner.warn(chalk_1.default.yellow(`Tidak ditemukan file markdown/dokumen di: ${resolvedPath}`));
            return;
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
            return;
        }
        spinner.text = chalk_1.default.cyan(`Membuat embeddings & menyimpan ${allChunks.length} chunks ke LanceDB...`);
        const count = await (0, db_js_1.insertChunks)(allChunks);
        spinner.succeed(chalk_1.default.green(`Berhasil meng-ingest ${count} chunks ke vector database lokal!`));
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Gagal meng-ingest dokumen: ${error.message}`));
        process.exit(1);
    }
}
