"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectGuidelinesCommand = inspectGuidelinesCommand;
const chalk_1 = __importDefault(require("chalk"));
const prompts_1 = require("@inquirer/prompts");
const db_js_1 = require("../core/db.js");
async function inspectGuidelinesCommand() {
    const guidelines = await (0, db_js_1.listAllIndexedGuidelines)();
    if (guidelines.length === 0) {
        console.log(chalk_1.default.yellow('\nBelum ada guideline atau coding convention yang di-ingest ke LanceDB.'));
        console.log(chalk_1.default.gray('Jalankan menu "📚 Ingest Guidelines" terlebih dahulu untuk mendaftarkan aturan tim.\n'));
        return;
    }
    console.log(chalk_1.default.bold.cyan(`\n📋 Daftar Aturan & Guidelines Terdaftar di RAG (${guidelines.length} Section/Rule):\n`));
    const choices = guidelines.map((g, index) => ({
        name: `${chalk_1.default.green(`${index + 1}.`)} ${chalk_1.default.bold.white(g.title)} ${chalk_1.default.gray(`[Source: ${g.source}]`)}`,
        value: g.id,
    }));
    choices.push({ name: '🔙 Kembali ke menu utama', value: 'back' });
    while (true) {
        const chosenId = await (0, prompts_1.select)({
            message: 'Pilih aturan untuk melihat detail isi teksnya:',
            choices,
        });
        if (chosenId === 'back')
            break;
        const selected = guidelines.find((g) => g.id === chosenId);
        if (selected) {
            console.log(chalk_1.default.bold.cyan('\n═════════════════════ DETAIL ATURAN CONVENTION ═════════════════════'));
            console.log(chalk_1.default.yellow(`Judul : ${selected.title}`));
            console.log(chalk_1.default.gray(`File  : ${selected.source}\n`));
            // Tampilkan teks markdown murni asli dari file, jangan dikonversi ke HTML oleh marked()
            console.log(chalk_1.default.white(selected.content));
            console.log(chalk_1.default.bold.cyan('\n════════════════════════════════════════════════════════════════════\n'));
        }
    }
}
