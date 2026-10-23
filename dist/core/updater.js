"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAndUpgradeApp = checkAndUpgradeApp;
exports.readCachedRules = readCachedRules;
exports.writeCachedRules = writeCachedRules;
exports.syncGuidelinesRules = syncGuidelinesRules;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const https_1 = __importDefault(require("https"));
const child_process_1 = require("child_process");
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const version_js_1 = require("./version.js");
const config_js_1 = require("./config.js");
const db_js_1 = require("./db.js");
const dedup_js_1 = require("./dedup.js");
const CACHE_DIR = path_1.default.join((0, config_js_1.getConfigDir)(), 'cache');
const RULES_CACHE_FILE = path_1.default.join(CACHE_DIR, 'rules.json');
const GITHUB_RAW_PKG = 'https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/package.json';
const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/install.sh';
function fetchJson(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = https_1.default.get(url, {
            headers: {
                'User-Agent': 'lumio-auto-patcher',
                'Cache-Control': 'no-cache',
            },
            timeout: timeoutMs,
        }, (res) => {
            if (res.statusCode !== 200) {
                resolve(null);
                return;
            }
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}
/**
 * Compare semantic versions (e.g. 2.2.0 vs 2.3.0)
 * Returns 1 if vA > vB, -1 if vA < vB, 0 if equal
 */
function compareSemver(vA, vB) {
    const partsA = vA.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const partsB = vB.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const a = partsA[i] || 0;
        const b = partsB[i] || 0;
        if (a > b)
            return 1;
        if (a < b)
            return -1;
    }
    return 0;
}
/**
 * Tier 1: Check App Version & Auto-Upgrade if a newer version is released on GitHub
 */
async function checkAndUpgradeApp(silent = false) {
    // Hanya lakukan auto-upgrade jika dijalankan dari binary yang terpasang di ~/.lumio/app
    const appDir = path_1.default.join((0, config_js_1.getConfigDir)(), 'app');
    const isInstalledBinary = process.argv[1]?.includes(appDir) || process.cwd() !== path_1.default.resolve(appDir, '../..');
    try {
        const remotePkg = await fetchJson(GITHUB_RAW_PKG, 2500);
        if (!remotePkg || !remotePkg.version) {
            return false;
        }
        const currentVersion = (0, version_js_1.getAppVersion)();
        const remoteVersion = remotePkg.version;
        if (compareSemver(remoteVersion, currentVersion) > 0) {
            console.log(chalk_1.default.cyan(`\n╭─────────────────────────────────────────────────────────────╮`));
            console.log(chalk_1.default.cyan(`│  🚀 New Lumio Update Available: ${chalk_1.default.yellow(`v${currentVersion}`)} ➔ ${chalk_1.default.bold.green(`v${remoteVersion}`)}         │`));
            console.log(chalk_1.default.cyan(`│  📦 Auto-patching Lumio to latest release...                │`));
            console.log(chalk_1.default.cyan(`╰─────────────────────────────────────────────────────────────╯\n`));
            const spinner = (0, ora_1.default)('Mengunduh & memperbarui Lumio...').start();
            try {
                // Eksekusi installer non-interactive
                (0, child_process_1.execSync)(`curl -fsSL ${INSTALL_SCRIPT_URL} | bash`, {
                    stdio: 'pipe',
                    timeout: 45000,
                });
                spinner.succeed(chalk_1.default.green(`Lumio berhasil di-upgrade ke v${remoteVersion}! ✨`));
                console.log(chalk_1.default.yellow(`\nMenjalankan ulang perintah dengan versi terbaru...\n`));
                // Re-exec proses dengan argv yang sama
                const nodeExec = process.execPath;
                const binTarget = path_1.default.join(os_1.default.homedir(), '.local', 'bin', 'lumio');
                if (fs_1.default.existsSync(binTarget)) {
                    (0, child_process_1.execSync)(`"${binTarget}" ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit' });
                    process.exit(0);
                }
                return true;
            }
            catch (err) {
                spinner.fail(chalk_1.default.yellow(`Gagal auto-upgrade: ${err.message}. Tetap melanjutkan dengan versi saat ini.`));
                return false;
            }
        }
    }
    catch {
        // Abaikan jika network offline
    }
    return false;
}
/**
 * Membaca rules dari cache lokal disk
 */
function readCachedRules() {
    try {
        if (fs_1.default.existsSync(RULES_CACHE_FILE)) {
            const content = fs_1.default.readFileSync(RULES_CACHE_FILE, 'utf-8');
            return JSON.parse(content);
        }
    }
    catch { }
    return null;
}
/**
 * Menyimpan rules ke cache lokal disk
 */
function writeCachedRules(data) {
    try {
        fs_1.default.mkdirSync(CACHE_DIR, { recursive: true });
        fs_1.default.writeFileSync(RULES_CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    }
    catch (err) {
        // non-fatal
    }
}
/**
 * Tier 2: Check Rules Revision from Qdrant VPS & Auto-Sync
 * Menghitung revision fingerprint secara instan berdasarkan ID & contentHash points di Qdrant
 */
async function syncGuidelinesRules(options = {}) {
    const config = await (0, config_js_1.loadConfig)();
    // Jika menggunakan Local LanceDB (bukan shared VPS Qdrant), return empty atau biarkan LanceDB lokal
    if (config.dbType !== 'qdrant') {
        return [];
    }
    const rawUrl = (config.qdrantUrl || '').trim();
    const collection = (config.qdrantCollection || '').trim();
    if (!rawUrl || !collection) {
        // Belum dikonfigurasi, fallback ke cache lama jika ada
        const cached = readCachedRules();
        return cached ? cached.rules : [];
    }
    const localCache = readCachedRules();
    try {
        const { client } = await (0, db_js_1.getQdrantClient)();
        // 1. Ambil scroll ringan untuk mendapatkan seluruh rules dari Qdrant
        const response = await client.scroll(collection, {
            limit: 500,
            with_payload: true,
            with_vector: false, // TIDAK PERLU VECTOR -> Super cepat & hemat bandwidth!
        });
        const points = response.points || [];
        // 2. Hitung revision hash dari kumpulan contentHash
        const hashes = points
            .map((p) => p.payload?.contentHash || (0, dedup_js_1.getNormHash)(p.payload?.content || ''))
            .sort()
            .join('|');
        const remoteRevision = (0, dedup_js_1.getNormHash)(hashes);
        // 3. Cek apakah revision sama dengan cache lokal
        if (!options.force && localCache && localCache.revision === remoteRevision) {
            if (!options.quiet) {
                // Up to date
            }
            return localCache.rules;
        }
        // 4. Ada update! Petakan rules ke format DocChunk
        const mappedRules = points.map((p) => {
            const payload = p.payload;
            return {
                id: String(p.id),
                source: payload?.source || 'remote_vps',
                title: payload?.title || 'Untitled Guideline',
                content: payload?.content || '',
            };
        });
        const newCacheData = {
            revision: remoteRevision,
            count: mappedRules.length,
            updatedAt: new Date().toISOString(),
            rules: mappedRules,
        };
        writeCachedRules(newCacheData);
        if (!options.quiet) {
            const prevCount = localCache ? localCache.count : 0;
            const diffText = prevCount > 0 ? `(${mappedRules.length} rules, ${mappedRules.length - prevCount >= 0 ? '+' : ''}${mappedRules.length - prevCount} updated)` : `(${mappedRules.length} rules cached)`;
            console.log(chalk_1.default.green(`🔄 Guidelines synced from server ${chalk_1.default.cyan(diffText)}`));
        }
        return mappedRules;
    }
    catch (err) {
        // Graceful offline fallback: jika Qdrant unreachable / internet down
        if (localCache && localCache.rules && localCache.rules.length > 0) {
            if (!options.quiet) {
                console.log(chalk_1.default.yellow(`⚠️ Server Qdrant tidak terjangkau. Menggunakan cache lokal (${localCache.rules.length} aturan).`));
            }
            return localCache.rules;
        }
        return [];
    }
}
