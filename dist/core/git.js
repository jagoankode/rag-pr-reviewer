"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGitDiff = getGitDiff;
exports.getAvailableBranches = getAvailableBranches;
exports.getCurrentBranch = getCurrentBranch;
exports.isGitRepo = isGitRepo;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Mengambil diff dari git:
 * 1. Staged diff (`git diff --staged`)
 * 2. Uncommitted changes (`git diff`)
 * 3. Branch comparison: PR style `git diff <target>...<source>`
 */
async function getGitDiff(options = {}) {
    const cwd = options.cwd || process.cwd();
    // Jika user membandingkan origin branch, opsional fetch remote terlebih dahulu
    if (options.fetchRemote) {
        try {
            await execFileAsync('git', ['fetch', '--all', '--prune'], { cwd });
        }
        catch {
            // Abaikan jika offline / fetch gagal
        }
    }
    const args = ['diff'];
    if (options.staged) {
        args.push('--staged');
    }
    else if (options.targetBranch && options.sourceBranch) {
        // PR semantics: git diff <target>...<source>
        // Membandingkan perubahan pada source sejak bercabang dari target
        args.push(`${options.targetBranch}...${options.sourceBranch}`);
    }
    else if (options.targetBranch) {
        args.push(options.targetBranch);
    }
    else if (options.branch) {
        args.push(options.branch);
    }
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            maxBuffer: 15 * 1024 * 1024, // 15MB
        });
        return stdout;
    }
    catch (err) {
        throw new Error(`Gagal mengambil git diff: ${err.message}`);
    }
}
/**
 * Mendapatkan branch lokal & remote (origin/*) yang tersedia di repo
 */
async function getAvailableBranches(cwd = process.cwd()) {
    try {
        const { stdout: localOut } = await execFileAsync('git', ['branch', '--format=%(refname:short)'], { cwd });
        const { stdout: remoteOut } = await execFileAsync('git', ['branch', '-r', '--format=%(refname:short)'], { cwd });
        const local = localOut
            .split('\n')
            .map((b) => b.trim())
            .filter((b) => b.length > 0);
        const remote = remoteOut
            .split('\n')
            .map((b) => b.trim())
            .filter((b) => b.length > 0 && !b.includes('->'));
        return { local, remote };
    }
    catch {
        return { local: [], remote: [] };
    }
}
/**
 * Mendapatkan nama branch saat ini (current branch)
 */
async function getCurrentBranch(cwd = process.cwd()) {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        return stdout.trim() || 'HEAD';
    }
    catch {
        return 'HEAD';
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
