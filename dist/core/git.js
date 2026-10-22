"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGitDiff = getGitDiff;
exports.isGitRepo = isGitRepo;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Mengambil diff dari git (staged, uncommitted vs working tree, atau antar branch)
 */
async function getGitDiff(options = {}) {
    const args = ['diff'];
    if (options.staged) {
        args.push('--staged');
    }
    else if (options.branch) {
        args.push(options.branch);
    }
    // Filter diff stats dan file exclusion jika perlu
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: options.cwd || process.cwd(),
            maxBuffer: 10 * 1024 * 1024, // 10MB
        });
        return stdout;
    }
    catch (err) {
        throw new Error(`Gagal mengambil git diff: ${err.message}`);
    }
}
/**
 * Cek apakah direktori merupakan git repository
 */
async function isGitRepo(cwd = process.cwd()) {
    try {
        await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
        return true;
    }
    catch {
        return false;
    }
}
