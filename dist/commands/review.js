"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewCommand = reviewCommand;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const ai_1 = require("ai");
const git_js_1 = require("../core/git.js");
const diff_parser_js_1 = require("../core/diff-parser.js");
const db_js_1 = require("../core/db.js");
const prompt_js_1 = require("../core/prompt.js");
const config_js_1 = require("../core/config.js");
const history_js_1 = require("../core/history.js");
const schema_js_1 = require("../core/schema.js");
async function reviewCommand(options) {
    const isRepo = await (0, git_js_1.isGitRepo)();
    if (!isRepo) {
        console.error(chalk_1.default.red('Error: Perintah harus dijalankan di dalam git repository!'));
        return;
    }
    const spinner = (0, ora_1.default)(chalk_1.default.blue('Mengambil git diff...')).start();
    try {
        const targetBranch = options.target || options.branch;
        const sourceBranch = options.source;
        if (targetBranch && sourceBranch) {
            spinner.text = chalk_1.default.blue(`Mengambil git diff: ${targetBranch}...${sourceBranch} (PR style)...`);
        }
        else if (targetBranch) {
            spinner.text = chalk_1.default.blue(`Mengambil git diff terhadap branch: ${targetBranch}...`);
        }
        const rawDiff = await (0, git_js_1.getGitDiff)({
            staged: options.staged,
            branch: targetBranch,
            targetBranch: targetBranch,
            sourceBranch: sourceBranch,
            fetchRemote: options.fetchRemote,
        });
        if (!rawDiff || rawDiff.trim().length === 0) {
            spinner.info(chalk_1.default.yellow(options.staged
                ? 'Tidak ada perubahan staged (git diff --staged kosong).'
                : targetBranch && sourceBranch
                    ? `Tidak ada perbedaan antara branch ${targetBranch} dan ${sourceBranch}.`
                    : targetBranch
                        ? `Tidak ada perbedaan terhadap branch ${targetBranch}.`
                        : 'Tidak ada perubahan yang terdeteksi (git diff kosong).'));
            return;
        }
        spinner.text = chalk_1.default.cyan('Mem-parse diff dan mapping nomor baris...');
        const { annotatedText, files } = (0, diff_parser_js_1.annotateDiffWithLineNumbers)(rawDiff);
        spinner.text = chalk_1.default.cyan(`Mencari aturan coding terkait dari LanceDB (${files.length} file diubah)...`);
        let relevantRules = [];
        try {
            const chunks = await (0, db_js_1.searchRelevantGuidelines)(rawDiff, options.limit || 7);
            relevantRules = chunks.map((c) => `[Source: ${c.title}]\n${c.content}`);
            if (relevantRules.length > 0) {
                spinner.info(chalk_1.default.gray(`Ditemukan ${relevantRules.length} guideline yang relevan.`));
            }
            else {
                spinner.info(chalk_1.default.gray('Belum ada guideline yang di-ingest, mereview dengan standar umum.'));
            }
        }
        catch {
            spinner.info(chalk_1.default.gray('Vector store belum diinisialisasi atau kosong. Melanjutkan review umum.'));
        }
        const { client, config } = await (0, config_js_1.getActiveAIProvider)();
        const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';
        spinner.start(chalk_1.default.magenta(`Menganalisis pelanggaran baris per baris via AI (${modelName})...`));
        const prompt = (0, prompt_js_1.buildLineReviewPrompt)(annotatedText, relevantRules);
        const { object: reviewResult } = await (0, ai_1.generateObject)({
            model: client(modelName),
            schema: schema_js_1.PRReviewResultSchema,
            prompt: prompt,
        });
        spinner.succeed(chalk_1.default.green(`Review selesai! Ditemukan ${reviewResult.violations.length} pelanggaran.\n`));
        if (options.json) {
            console.log(JSON.stringify(reviewResult, null, 2));
            return reviewResult;
        }
        printReviewTerminalReport(reviewResult);
        // Simpan report history markdown secara default (kecuali opsi json)
        if (options.saveReport !== false) {
            try {
                const reportLabel = targetBranch && sourceBranch
                    ? `${targetBranch.replace(/\//g, '_')}_vs_${sourceBranch.replace(/\//g, '_')}`
                    : targetBranch || (options.staged ? 'staged' : 'local');
                const savedPath = await (0, history_js_1.saveReviewReport)(reviewResult, {
                    branch: reportLabel,
                    staged: options.staged,
                    model: modelName,
                    outputDir: options.outputDir,
                });
                console.log(chalk_1.default.gray(`💾 History report tersimpan di: ${chalk_1.default.underline.cyan(savedPath)}\n`));
            }
            catch (err) {
                console.warn(chalk_1.default.yellow(`Peringatan: Gagal menyimpan report markdown: ${err.message}`));
            }
        }
        return reviewResult;
    }
    catch (error) {
        spinner.fail(chalk_1.default.red(`Review gagal: ${error.message}`));
        console.log(chalk_1.default.yellow('\n💡 Tips: Pastikan konfigurasi AI Provider, API key, atau nama branch sudah benar di menu TUI.\n'));
        // Return void gracefully agar TUI tidak tertutup/exit
        return;
    }
}
function printReviewTerminalReport(result) {
    const statusColor = result.status === 'APPROVE'
        ? chalk_1.default.bold.green
        : result.status === 'REQUEST_CHANGES'
            ? chalk_1.default.bold.red
            : chalk_1.default.bold.yellow;
    console.log(chalk_1.default.bold.cyan('═════════════════════ PULL REQUEST REVIEW REPORT ═════════════════════'));
    console.log(`Status  : ${statusColor(result.status)}`);
    console.log(`Summary : ${result.summary}\n`);
    if (result.violations.length === 0) {
        console.log(chalk_1.default.green('✔ Tidak ditemukan pelanggaran code convention pada baris yang diubah!'));
    }
    else {
        console.log(chalk_1.default.bold.red(`🚨 Line-by-Line Violations & PR Comments (${result.violations.length}):\n`));
        result.violations.forEach((v) => {
            const tag = v.severity === 'error'
                ? chalk_1.default.bgRed.white.bold(' ERROR ')
                : v.severity === 'warning'
                    ? chalk_1.default.bgYellow.black.bold(' WARN ')
                    : chalk_1.default.bgBlue.white.bold(' INFO ');
            console.log(`${tag} ${chalk_1.default.bold.underline(v.file)} : ${chalk_1.default.bold.yellow(`line ${v.line}`)}`);
            console.log(`    Rule   : ${chalk_1.default.gray(v.rule)}`);
            console.log(`    Comment: ${chalk_1.default.whiteBright(v.comment)}`);
            if (v.suggestedFix) {
                console.log(`    Fix    : ${chalk_1.default.green(v.suggestedFix)}`);
            }
            console.log(chalk_1.default.gray('─'.repeat(70)));
        });
    }
    if (result.generalFeedback && result.generalFeedback.length > 0) {
        console.log(chalk_1.default.bold.cyan('\n📌 General Architecture Notes:'));
        result.generalFeedback.forEach((note) => {
            console.log(` • ${note}`);
        });
    }
    console.log(chalk_1.default.bold.cyan('\n══════════════════════════════════════════════════════════════════════\n'));
}
