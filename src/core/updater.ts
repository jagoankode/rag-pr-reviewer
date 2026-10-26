import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { getAppVersion } from './version.js';
import { loadConfig, getConfigDir } from './config.js';
import { DocChunk } from './chunker.js';
import { getQdrantClient } from './db.js';
import { getNormHash } from './dedup.js';

export interface RulesCacheData {
  revision: string;
  count: number;
  updatedAt: string;
  rules: DocChunk[];
}

const CACHE_DIR = path.join(getConfigDir(), 'cache');
const RULES_CACHE_FILE = path.join(CACHE_DIR, 'rules.json');
const GITHUB_RAW_PKG = 'https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/package.json';
const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/install.sh';

function fetchJson<T>(url: string, timeoutMs: number = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'lumio-auto-patcher',
          'Cache-Control': 'no-cache',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      }
    );

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
function compareSemver(vA: string, vB: string): number {
  const partsA = vA.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = vB.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Tier 1: Check App Version & Auto-Upgrade if a newer version is released on GitHub
 */
export async function checkAndUpgradeApp(silent: boolean = false): Promise<boolean> {
  // Hanya lakukan auto-upgrade jika dijalankan dari binary yang terpasang di ~/.lumio/app
  const appDir = path.join(getConfigDir(), 'app');
  const isInstalledBinary = process.argv[1]?.includes(appDir) || process.cwd() !== path.resolve(appDir, '../..');

  try {
    const remotePkg = await fetchJson<{ version: string }>(`${GITHUB_RAW_PKG}?t=${Date.now()}`, 2500);
    if (!remotePkg || !remotePkg.version) {
      return false;
    }

    const currentVersion = getAppVersion();
    const remoteVersion = remotePkg.version;

    if (compareSemver(remoteVersion, currentVersion) > 0) {
      console.log(chalk.cyan(`\n╭─────────────────────────────────────────────────────────────╮`));
      console.log(chalk.cyan(`│  🚀 New Lumio Update Available: ${chalk.yellow(`v${currentVersion}`)} ➔ ${chalk.bold.green(`v${remoteVersion}`)}         │`));
      console.log(chalk.cyan(`│  📦 Auto-patching Lumio to latest release...                │`));
      console.log(chalk.cyan(`╰─────────────────────────────────────────────────────────────╯\n`));

      const spinner = ora('Mengunduh & memperbarui Lumio...').start();

      try {
        // Eksekusi installer non-interactive
        execSync(`curl -fsSL ${INSTALL_SCRIPT_URL} | bash`, {
          stdio: 'pipe',
          timeout: 45000,
        });
        spinner.succeed(chalk.green(`Lumio berhasil di-upgrade ke v${remoteVersion}! ✨`));
        console.log(chalk.cyan(`\n💡 Silakan ketik ${chalk.bold.green('lumio')} kembali untuk mulai menggunakan versi terbaru.\n`));
        process.exit(0);
      } catch (err: any) {
        spinner.fail(chalk.yellow(`Gagal auto-upgrade: ${err.message}. Tetap melanjutkan dengan versi saat ini.`));
        return false;
      }
    }
  } catch {
    // Abaikan jika network offline
  }

  return false;
}

/**
 * Membaca rules dari cache lokal disk
 */
export function readCachedRules(): RulesCacheData | null {
  try {
    if (fs.existsSync(RULES_CACHE_FILE)) {
      const content = fs.readFileSync(RULES_CACHE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {}
  return null;
}

/**
 * Menyimpan rules ke cache lokal disk
 */
export function writeCachedRules(data: RulesCacheData): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(RULES_CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    // non-fatal
  }
}

/**
 * Tier 2: Check Rules Revision from Qdrant VPS & Auto-Sync
 * Menghitung revision fingerprint secara instan berdasarkan ID & contentHash points di Qdrant
 */
export async function syncGuidelinesRules(options: { force?: boolean; quiet?: boolean } = {}): Promise<DocChunk[]> {
  const config = await loadConfig();

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
    const { client } = await getQdrantClient();

    // 1. Ambil scroll ringan untuk mendapatkan seluruh rules dari Qdrant (KECUALI system-prompt)
    const response = await client.scroll(collection, {
      limit: 500,
      with_payload: true,
      with_vector: false, // TIDAK PERLU VECTOR -> Super cepat & hemat bandwidth!
    });

    // Filter ketat: kecualikan system-prompt agar tidak tercampur sebagai aturan coding!
    const points = (response.points || []).filter(
      (p: any) => p.payload?.source !== 'system-prompt'
    );

    // 2. Hitung revision hash dari kumpulan contentHash
    const hashes = points
      .map((p: any) => p.payload?.contentHash || getNormHash(p.payload?.content || ''))
      .sort()
      .join('|');
    const remoteRevision = getNormHash(hashes);

    // 3. Cek apakah revision sama dengan cache lokal
    if (!options.force && localCache && localCache.revision === remoteRevision) {
      if (!options.quiet) {
        // Up to date
      }
      return localCache.rules;
    }

    // 4. Ada update! Petakan rules ke format DocChunk
    const mappedRules: DocChunk[] = points.map((p: any) => {
      const payload = p.payload as any;
      return {
        id: String(p.id),
        source: payload?.source || 'remote_vps',
        title: payload?.title || 'Untitled Guideline',
        content: payload?.content || '',
      };
    });

    const newCacheData: RulesCacheData = {
      revision: remoteRevision,
      count: mappedRules.length,
      updatedAt: new Date().toISOString(),
      rules: mappedRules,
    };

    writeCachedRules(newCacheData);

    if (!options.quiet) {
      const prevCount = localCache ? localCache.count : 0;
      const diffText = prevCount > 0 ? `(${mappedRules.length} rules, ${mappedRules.length - prevCount >= 0 ? '+' : ''}${mappedRules.length - prevCount} updated)` : `(${mappedRules.length} rules cached)`;
      console.log(chalk.green(`🔄 Guidelines synced from server ${chalk.cyan(diffText)}`));
    }

    return mappedRules;
  } catch (err: any) {
    // Graceful offline fallback: jika Qdrant unreachable / internet down
    if (localCache && localCache.rules && localCache.rules.length > 0) {
      if (!options.quiet) {
        console.log(chalk.yellow(`⚠️ Server Qdrant tidak terjangkau. Menggunakan cache lokal (${localCache.rules.length} aturan).`));
      }
      return localCache.rules;
    }
    return [];
  }
}
