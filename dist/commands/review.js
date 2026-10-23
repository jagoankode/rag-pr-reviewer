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
        spinner.text = chalk_1.default.cyan('Mem-parse diff per file...');
        const fileDiffs = (0, diff_parser_js_1.parseAnnotatedDiffFiles)(rawDiff);
        if (fileDiffs.length === 0) {
            spinner.info(chalk_1.default.yellow('Tidak ada perubahan baris kode (mungkin hanya file biner/dihapus).'));
            return;
        }
        const { client, config } = await (0, config_js_1.getActiveAIProvider)();
        const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';
        const totalFiles = fileDiffs.length;
        spinner.succeed(chalk_1.default.green(`Ditemukan ${totalFiles} file yang berubah. Memulai analisis per file...\n`));
        const allViolations = [];
        const generalFeedback = [];
        // Iterasi per file dengan progress indicator real-time [1 dari N file]
        for (let i = 0; i < totalFiles; i++) {
            const fileDiff = fileDiffs[i];
            const progressLabel = `[${i + 1}/${totalFiles}]`;
            const fileSpinner = (0, ora_1.default)(chalk_1.default.magenta(`${progressLabel} Menganalisis ${chalk_1.default.bold.underline(fileDiff.file)} (${fileDiff.addedLinesCount} baris)...`)).start();
            try {
                // Cari RAG guideline yang spesifik untuk file/diff ini
                let relevantRules = [];
                try {
                    const chunks = await (0, db_js_1.searchRelevantGuidelines)(`${fileDiff.file}\n${fileDiff.annotatedText}`, options.limit || 5);
                    relevantRules = chunks.map((c) => `[Source: ${c.title}]\n${c.content}`);
                }
                catch {
                    // fallback jika db kosong
                }
                const prompt = `You are a strict Senior Tech Lead and Code Reviewer.
Audit the following file changes against the provided code conventions.

${relevantRules.length > 0
                    ? `### Relevant Coding Standards & Architecture Rules:\n${relevantRules.join('\n\n---\n\n')}`
                    : 'Standard industry conventions: enforce strict typing (no any), error handling, and clean architecture.'}

### Guidelines for Review:
1. Review newly added or modified lines marked with \`+ L<number>:\`.
2. Map every convention violation directly to its exact \`file\` and \`line\` number.
3. If no violation is found, return an empty violations array.
4. SuggestedFix must be a string snippet or null if not applicable.

### File Diff to Review:
${fileDiff.annotatedText}
`;
                let object = null;
                try {
                    const res = await (0, ai_1.generateObject)({
                        model: client(modelName),
                        schema: schema_js_1.FileReviewResultSchema,
                        prompt,
                    });
                    object = res.object;
                }
                catch (genErr) {
                    // Fallback jika model menghasilkan non-strict JSON atau output terpotong
                    try {
                        const rawTextRes = await (0, ai_1.generateText)({
                            model: client(modelName),
                            prompt: `${prompt}\n\nIMPORTANT: Return ONLY a valid JSON object matching this structure: {"violations": [], "notes": []}. No preamble or markdown fences.`,
                        });
                        const cleaned = rawTextRes.text.replace(/```json/gi, '').replace(/```/g, '').trim();
                        object = JSON.parse(cleaned);
                    }
                    catch {
                        throw genErr;
                    }
                }
                if (object && object.violations && object.violations.length > 0) {
                    allViolations.push(...object.violations);
                    fileSpinner.warn(chalk_1.default.yellow(`${progressLabel} ${fileDiff.file} ➔ Ditemukan ${object.violations.length} pelanggaran`));
                }
                else {
                    fileSpinner.succeed(chalk_1.default.gray(`${progressLabel} ${fileDiff.file} ➔ Bersih (Clean)`));
                }
                if (object && object.notes && object.notes.length > 0) {
                    generalFeedback.push(...object.notes);
                }
            }
            catch (err) {
                fileSpinner.fail(chalk_1.default.red(`${progressLabel} ${fileDiff.file} ➔ Gagal dianalisis: ${err.message}`));
            }
        }
        // Tentukan status akhir PR
        const hasErrors = allViolations.some((v) => v.severity === 'error');
        const finalStatus = hasErrors ? 'REQUEST_CHANGES' : allViolations.length > 0 ? 'COMMENT' : 'APPROVE';
        const finalSummary = `Telah selesai mereview ${totalFiles} file yang diubah. Ditemukan total ${allViolations.length} pelanggaran code convention.`;
        const reviewResult = {
            status: finalStatus,
            summary: finalSummary,
            violations: allViolations,
            generalFeedback: Array.from(new Set(generalFeedback)),
        };
        if (options.json) {
            console.log(JSON.stringify(reviewResult, null, 2));
            return reviewResult;
        }
        console.log('');
        printReviewTerminalReport(reviewResult);
        // Simpan report history markdown secara default
        if (options.saveReport !== false) {
            try {
                const reportLabel = targetBranch && sourceBranch
                    ? `${targetBranch.replace(/\//g, '_')}_vs_${sourceBranch.replace(/\//g, '_')}`
                    : targetBranch || (options.staged ? 'staged' : 'local');
                const savedPath = await (0, history_js_1.saveReviewReport)(reviewResult, {
                    branch: reportLabel,
                    staged: options.staged,
                    sourceBranch,
                    targetBranch,
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
        console.log(chalk_1.default.green('✔ Tidak ditemukan pelanggaran code convention pada semua file yang diubah!'));
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
