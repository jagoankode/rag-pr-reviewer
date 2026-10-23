"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.learnFeatureCommand = learnFeatureCommand;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const path_1 = __importDefault(require("path"));
const ai_1 = require("ai");
const code_scanner_js_1 = require("../core/code-scanner.js");
const learn_schema_js_1 = require("../core/learn-schema.js");
const config_js_1 = require("../core/config.js");
const db_js_1 = require("../core/db.js");
const ingest_js_1 = require("./ingest.js");
async function learnFeatureCommand(targetPath, modelOverride) {
    const resolved = (0, ingest_js_1.resolveUserPath)(targetPath);
    const spinner = (0, ora_1.default)(chalk_1.default.blue(`Memindai source code di ${resolved}...`)).start();
    try {
        const files = await (0, code_scanner_js_1.scanFeatureCodeFiles)(resolved, 15, 25000);
        if (files.length === 0) {
            spinner.warn(chalk_1.default.yellow(`Tidak ditemukan file source code yang didukung di: ${resolved}`));
            return false;
        }
        spinner.text = chalk_1.default.cyan(`Membaca ${files.length} file source code untuk analisis hulu-ke-hilir...`);
        // Gabungkan cuplikan kode terstruktur
        const codeContext = files
            .map((f) => `### File: ${f.relativePath}\n\`\`\`${f.ext.replace('.', '')}\n${f.content.slice(0, 3000)}\n\`\`\``)
            .join('\n\n');
        const { client, config } = await (0, config_js_1.getActiveAIProvider)();
        const modelName = modelOverride || config.defaultModel || 'ag/gemini-3.8-flash';
        spinner.text = chalk_1.default.magenta(`Menganalisis pola arsitektur & aturan coding via AI (${modelName})...`);
        const prompt = `You are a Principal Software Architect.
Analyze the following source code files from a local feature/module folder (${path_1.default.basename(resolved)}).
Trace the flow from entrypoint/route down to business logic and data layer.

Reverse-engineer the implicit and explicit CODING CONVENTIONS, architecture patterns, and rules that this team follows.

Extract rules across these categories:
- Routing & Controller patterns (input validation, error handling, status codes)
- Service / Business logic rules (DTO usage, typing, pure logic vs side effects)
- Model & Database persistence conventions
- Naming conventions (files, variables, interfaces)

Source Code from folder:
${codeContext}
`;
        const { object: mined } = await (0, ai_1.generateObject)({
            model: client(modelName),
            schema: learn_schema_js_1.MinedConventionsSchema,
            prompt,
        });
        spinner.succeed(chalk_1.default.green(`Selesai menganalisis fitur "${mined.featureName}"! Ditemukan ${mined.rules.length} aturan konvensi.\n`));
        console.log(chalk_1.default.bold.cyan('═════════════════ HASIL EKSTRAKSI ARSITEKTUR & ATURAN ═════════════════'));
        console.log(chalk_1.default.yellow(`Fitur   : ${mined.featureName}`));
        console.log(chalk_1.default.gray(`Alur    : ${mined.architectureSummary}\n`));
        console.log(chalk_1.default.bold.green(`Daftar Aturan yang Dipelajari (${mined.rules.length}):`));
        mined.rules.forEach((rule, idx) => {
            console.log(`\n  ${chalk_1.default.bold.cyan(`${idx + 1}. [${rule.layer.toUpperCase()}] ${rule.title}`)}`);
            console.log(`     Aturan : ${chalk_1.default.white(rule.convention)}`);
            if (rule.exampleGood) {
                console.log(`     Pola   : ${chalk_1.default.gray(rule.exampleGood.replace(/\n/g, ' '))}`);
            }
        });
        console.log(chalk_1.default.bold.cyan('\n═══════════════════════════════════════════════════════════════════════\n'));
        // Siapkan chunks untuk disimpan ke LanceDB
        const chunks = mined.rules.map((rule, idx) => ({
            id: `mined_${path_1.default.basename(resolved)}_${idx}_${Date.now()}`,
            source: `local_feature:${resolved}`,
            title: `${mined.featureName} > [${rule.layer.toUpperCase()}] ${rule.title}`,
            content: `${rule.convention}\n\nArchitecture Context:\n${mined.architectureSummary}${rule.exampleGood ? `\n\nExample Good Pattern:\n${rule.exampleGood}` : ''}`,
        }));
        const saveSpinner = (0, ora_1.default)(chalk_1.default.blue('Menyimpan aturan hasil belajar ke LanceDB (dengan cek anti-duplikat)...')).start();
        const result = await (0, db_js_1.insertChunks)(chunks);
        if (result.insertedCount === 0 && result.duplicateCount > 0) {
            saveSpinner.info(chalk_1.default.yellow(`Semua (${result.duplicateCount}) aturan yang dipelajari sudah pernah tersimpan sebelumnya.`));
        }
        else {
            saveSpinner.succeed(chalk_1.default.green(`Berhasil menambahkan ${result.insertedCount} aturan convention baru ke LanceDB!` +
                (result.duplicateCount > 0 ? chalk_1.default.gray(` (${result.duplicateCount} duplikat dilewati)`) : '')));
        }
        return true;
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Gagal mengekstrak aturan dari code: ${error.message}`));
        return false;
    }
}
