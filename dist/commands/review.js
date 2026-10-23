"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewCommand = reviewCommand;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const git_js_1 = require("../core/git.js");
const diff_parser_js_1 = require("../core/diff-parser.js");
const db_js_1 = require("../core/db.js");
const history_js_1 = require("../core/history.js");
const config_js_1 = require("../core/config.js");
const llm_client_js_1 = require("../core/llm-client.js");
const nav_js_1 = require("../core/nav.js");
function extractReviewResult(rawText) {
    const text = (rawText || '').trim();
    // 1. Coba parse langsung
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            return {
                violations: Array.isArray(parsed.violations) ? parsed.violations : [],
                notes: Array.isArray(parsed.notes) ? parsed.notes : [],
            };
        }
    }
    catch { }
    // 2. Ekstrak dari blok markdown ```json ... ```
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
        try {
            const parsed = JSON.parse(codeBlockMatch[1].trim());
            if (parsed && typeof parsed === 'object') {
                return {
                    violations: Array.isArray(parsed.violations) ? parsed.violations : [],
                    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
                };
            }
        }
        catch { }
    }
    // 3. Ambil substring antara kurung kurawal terluar { ... } (mengabaikan thinking process Claude)
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
            const candidate = text.substring(firstBrace, lastBrace + 1);
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') {
                return {
                    violations: Array.isArray(parsed.violations) ? parsed.violations : [],
                    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
                };
            }
        }
        catch { }
    }
    // 4. Fallback toleran jika JSON terpotong sebagian di akhir
    const violations = [];
    const lineMatches = text.matchAll(/\{\s*"file"[^\}]+\}/g);
    for (const m of lineMatches) {
        try {
            const v = JSON.parse(m[0]);
            if (v.file && v.line)
                violations.push(v);
        }
        catch { }
    }
    return { violations, notes: [] };
}
async function reviewCommand(options) {
    const isRepo = await (0, git_js_1.isGitRepo)();
    if (!isRepo) {
        console.error(chalk_1.default.red('Error: Perintah harus dijalankan di dalam git repository!'));
        return;
    }
    const abortController = (0, nav_js_1.createProcessAbortController)();
    const spinner = (0, ora_1.default)(chalk_1.default.blue('Mengambil git diff... (Tekan Ctrl+C untuk batalkan)')).start();
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
        if (abortController.signal.aborted) {
            spinner.info(chalk_1.default.yellow('\nProses review dibatalkan.'));
            return;
        }
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
        const config = await (0, config_js_1.loadConfig)();
        const modelName = options.model || config.defaultModel || 'ag/gemini-3.8-flash';
        const totalFiles = fileDiffs.length;
        spinner.succeed(chalk_1.default.green(`Ditemukan ${totalFiles} file yang berubah. Memulai analisis per file...\n`));
        const allViolations = [];
        const generalFeedback = [];
        // Iterasi per file dengan progress indicator real-time [1 dari N file]
        for (let i = 0; i < totalFiles; i++) {
            if (abortController.signal.aborted) {
                console.log(chalk_1.default.yellow('\n⚠️  Review dibatalkan oleh pengguna di tengah proses.'));
                break;
            }
            const fileDiff = fileDiffs[i];
            const progressLabel = `[${i + 1}/${totalFiles}]`;
            const fileSpinner = (0, ora_1.default)(chalk_1.default.magenta(`${progressLabel} Menganalisis ${chalk_1.default.bold.underline(fileDiff.file)} (${fileDiff.addedLinesCount} baris diff)... (Ctrl+C: Batal)`)).start();
            try {
                // 1. Baca seluruh baris fisik file lokal (All-Line Code Awareness)
                const fullFilePath = path_1.default.resolve(process.cwd(), fileDiff.file);
                let allFileLinesText = '';
                if (fs_1.default.existsSync(fullFilePath)) {
                    try {
                        const rawContent = fs_1.default.readFileSync(fullFilePath, 'utf-8');
                        const lines = rawContent.split('\n');
                        allFileLinesText = lines.map((line, idx) => `L${idx + 1}: ${line}`).join('\n');
                    }
                    catch { }
                }
                // 2. Baca konteks folder dan struktur modul (Folder & Scaffold Awareness)
                const folderDir = path_1.default.dirname(fullFilePath);
                const folderRelative = path_1.default.relative(process.cwd(), folderDir) || '.';
                let folderFilesList = [];
                if (fs_1.default.existsSync(folderDir)) {
                    try {
                        folderFilesList = fs_1.default.readdirSync(folderDir).filter((f) => !f.startsWith('.'));
                    }
                    catch { }
                }
                // 3. Cari RAG guideline yang relevan dari Vector DB (RAG)
                let relevantRules = [];
                try {
                    // Cari aturan terkait kode diff & file
                    const codeQuery = `File: ${fileDiff.file}\n${fileDiff.annotatedText}`;
                    // Cari juga aturan terkait arsitektur modul & scaffold folder
                    const scaffoldQuery = `Module structure scaffold required files for ${folderRelative} folder with files: ${folderFilesList.join(', ')}`;
                    const [codeChunks, scaffoldChunks] = await Promise.all([
                        (0, db_js_1.searchRelevantGuidelines)(codeQuery, 5),
                        (0, db_js_1.searchRelevantGuidelines)(scaffoldQuery, 3),
                    ]);
                    const seen = new Set();
                    for (const c of [...codeChunks, ...scaffoldChunks]) {
                        if (!seen.has(c.id)) {
                            seen.add(c.id);
                            relevantRules.push(`[Rule Title: ${c.title}]\n${c.content}`);
                        }
                    }
                }
                catch {
                    // fallback jika db kosong / error
                }
                // STRICT GROUNDING: Jika tidak ada rule sama sekali di Vector DB, JANGAN izinkan AI berasumsi!
                if (relevantRules.length === 0) {
                    fileSpinner.succeed(chalk_1.default.gray(`${progressLabel} ${fileDiff.file} ➔ Bersih (Tidak ada aturan terkait di Vector DB)`));
                    continue;
                }
                const prompt = `You are a strict Code Convention Auditor.
Your ONLY job is to verify if this code and its module folder violate the EXPLICIT registered conventions provided below.

### REGISTERED TEAM CONVENTIONS (EXACT TRUTH FROM VECTOR DB):
${relevantRules.join('\n\n---\n\n')}

### MODULE CONTEXT & SURROUNDING FOLDER:
- File Under Review: ${fileDiff.file}
- Containing Folder: ${folderRelative}
- Files Present in this Folder: [${folderFilesList.join(', ')}]

### COMPLETE FILE CONTENT WITH PHYSICAL LINE NUMBERS:
${allFileLinesText || fileDiff.annotatedText}

### RECENT GIT CHANGES (DIFF):
${fileDiff.annotatedText}

### STRICT AUDIT RULES:
1. ZERO ASSUMPTIONS: You must ONLY flag violations against the exact rules listed in "REGISTERED TEAM CONVENTIONS" above.
2. DO NOT use generic best practices, personal styling preferences, clean architecture opinions, or external internet standards.
3. SCAFFOLD & MODULE AUDIT: Use the "MODULE CONTEXT & SURROUNDING FOLDER" to verify if required files (e.g., wrapper, container, component, hook, index.ts, test files) are present or missing according to registered conventions. If required files are missing in this folder according to the registered convention, flag it on line 1 of the file under review.
4. WHOLE FILE AUDIT: Inspect all lines of the file that was modified. If any line violates registered conventions (e.g., styling, forbidden types, misplaced hooks, missing JSDoc, double fallback, naming), report the exact line number \`L<number>\`.
5. Every violation MUST cite the exact [Rule Title] from the registered conventions as its "rule" property.
6. If the file and its folder adhere to all registered conventions, return empty violations array [].
7. SuggestedFix must be an actionable replacement code snippet or null if not applicable.

Return strictly a JSON object with this shape:
{
  "violations": [
    {
      "file": "${fileDiff.file}",
      "line": 1,
      "rule": "[Exact Rule Title from Registered Conventions]",
      "severity": "error",
      "comment": "Clear explanation referencing the rule",
      "suggestedFix": null
    }
  ],
  "notes": []
}
`;
                let object = null;
                try {
                    const rawResponse = await (0, llm_client_js_1.callLLM)(prompt, modelName, abortController.signal);
                    object = extractReviewResult(rawResponse);
                }
                catch (callErr) {
                    if (abortController.signal.aborted || callErr.name === 'AbortError') {
                        fileSpinner.warn(chalk_1.default.yellow(`${progressLabel} ${fileDiff.file} ➔ Dibatalkan (Aborted).`));
                        break;
                    }
                    throw callErr;
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
                if (abortController.signal.aborted || err.name === 'AbortError') {
                    fileSpinner.warn(chalk_1.default.yellow(`${progressLabel} ${fileDiff.file} ➔ Dibatalkan.`));
                    break;
                }
                fileSpinner.fail(chalk_1.default.red(`${progressLabel} ${fileDiff.file} ➔ Gagal dianalisis: ${err.message}`));
            }
        }
        if (abortController.signal.aborted) {
            console.log(chalk_1.default.yellow('\nℹ️  Proses review dihentikan dan kembali ke menu.\n'));
            return;
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
