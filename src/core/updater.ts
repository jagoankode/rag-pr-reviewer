import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { execFileSync } from 'child_process';
import readline from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { getAppVersion } from './version.js';
import { loadConfig, getConfigDir } from './config.js';
import { DocChunk } from './chunker.js';
import { getQdrantClient, scrollAllPoints } from './db.js';
import { t } from './i18n.js';
import { logError } from './logger.js';

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
export function compareSemver(vA: string, vB: string): number {
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

/** Latest version on GitHub main, or null when it cannot be read. */
export async function fetchLatestVersion(timeoutMs: number = 5000): Promise<string | null> {
  return (await fetchJson<{ version: string }>(`${GITHUB_RAW_PKG}?t=${Date.now()}`, timeoutMs))?.version || null;
}

// A clean install (download + npm install) takes about 45s, so the old 45s limit cut most upgrades off.
const UPGRADE_TIMEOUT_MS = 5 * 60_000;

async function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question(chalk.gray(message), () => resolve()));
  rl.close();
}

const INSTALLED_APP_DIR = path.join(getConfigDir(), 'app');

/** True when this process runs the installed copy (~/.lumio/app), not a dev checkout. */
export function isRunningFromInstalledApp(entry: string | undefined = process.argv[1], appDir: string = INSTALLED_APP_DIR): boolean {
  if (!entry) return false;
  const rel = path.relative(path.resolve(appDir), path.resolve(entry));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function readInstalledAppVersion(appDir: string = INSTALLED_APP_DIR): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
}

// /bin/sh has no pipefail: a failed download would pipe nothing into bash and still exit 0.
export function runInstaller(scriptUrl: string = INSTALL_SCRIPT_URL, timeout: number = UPGRADE_TIMEOUT_MS): void {
  execFileSync('bash', ['-c', 'set -o pipefail; curl -fsSL "$1" | bash', 'lumio-upgrade', scriptUrl], {
    stdio: 'pipe',
    timeout,
  });
}

export type UpgradeStatus = 'up-to-date' | 'check-failed' | 'install-failed' | 'skipped';

/**
 * Tier 1: Check App Version & Auto-Upgrade if a newer version is released on GitHub.
 * A successful upgrade always exits: the running process is the old version, so the user starts Lumio again.
 * @param silent skip the upgrade entirely, e.g. for `--json` output that must stay machine-readable
 * @param exitCode exit code after a successful upgrade; review uses a non-zero code so a git hook never treats
 *   an unreviewed run as passing
 * @param interactive the TUI follows; on failure wait for Enter so the message is read before the screen clears
 * @param explicit `lumio upgrade`: also upgrade when not running from the installed app dir
 */
export async function checkAndUpgradeApp(
  silent: boolean = false,
  exitCode: number = 0,
  interactive: boolean = false,
  explicit: boolean = false
): Promise<UpgradeStatus> {
  if (silent) return 'skipped';
  // Auto-upgrade replaces ~/.lumio/app, so it never runs from a dev checkout (node dist/index.js, tsx).
  if (!explicit && !isRunningFromInstalledApp()) return 'skipped';

  const remotePkg = await fetchJson<{ version: string }>(`${GITHUB_RAW_PKG}?t=${Date.now()}`, 2500);
  if (!remotePkg || !remotePkg.version) return 'check-failed';

  const currentVersion = getAppVersion();
  const remoteVersion = remotePkg.version;
  if (compareSemver(remoteVersion, currentVersion) <= 0) return 'up-to-date';

  console.log(chalk.cyan(`\n╭─────────────────────────────────────────────────────────────╮`));
  console.log(chalk.cyan(`│  🚀 New Lumio Update Available: ${chalk.yellow(`v${currentVersion}`)} ➔ ${chalk.bold.green(`v${remoteVersion}`)}         │`));
  console.log(chalk.cyan(`│  📦 Auto-patching Lumio to latest release...                │`));
  console.log(chalk.cyan(`╰─────────────────────────────────────────────────────────────╯\n`));

  const spinner = ora(t('upgradeDownloading')).start();

  try {
    runInstaller();
    const installed = readInstalledAppVersion();
    if (!installed || compareSemver(installed, remoteVersion) !== 0) {
      throw new Error(t('upgradeVersionMismatch', { expected: remoteVersion, actual: installed ? `v${installed}` : '-' }));
    }
  } catch (err: any) {
    logError('AutoUpgrade', err, { from: currentVersion, to: remoteVersion, timedOut: !!err.killed });
    spinner.fail(chalk.yellow(t('upgradeFailed', { message: err.killed ? t('upgradeTimeout') : err.message })));
    if (interactive && process.stdin.isTTY) await waitForEnter(t('upgradeContinue'));
    return 'install-failed';
  }

  spinner.succeed(chalk.green(t('upgradeDone', { version: remoteVersion })));
  console.log(chalk.cyan(`\n${t('upgradeRestart', { command: chalk.bold.green('lumio') })}\n`));
  process.exit(exitCode);
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
 * Menghitung revision fingerprint dari id, source, title & content points di Qdrant
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

    // 1. Ambil seluruh rules dari Qdrant (KECUALI system-prompt), paginasi penuh tanpa vector
    const allPoints = await scrollAllPoints(client, collection);

    // Filter ketat: kecualikan system-prompt agar tidak tercampur sebagai aturan coding!
    const points = allPoints.filter(
      (p: any) => p.payload?.source !== 'system-prompt'
    );

    const mappedRules: DocChunk[] = points.map((p: any) => {
      const payload = p.payload as any;
      return {
        id: String(p.id),
        source: payload?.source || 'remote_vps',
        title: payload?.title || 'Untitled Guideline',
        content: payload?.content || '',
      };
    });

    // 2. Revision = fingerprint of every cached field. Stored contentHash is not used: older points hold
    // hashes from a previous normalization and it does not cover title/source.
    const remoteRevision = crypto
      .createHash('sha256')
      .update(JSON.stringify([...mappedRules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))))
      .digest('hex');

    // 3. Cek apakah revision sama dengan cache lokal
    if (!options.force && localCache && localCache.revision === remoteRevision) {
      return localCache.rules;
    }

    // 4. Ada update!
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
      console.log(chalk.green(t('rulesSynced', { detail: chalk.cyan(diffText) })));
    }

    return mappedRules;
  } catch (err: any) {
    logError('RulesSync', err, { collection });
    // Graceful offline fallback: jika Qdrant unreachable / internet down
    if (localCache && localCache.rules && localCache.rules.length > 0) {
      if (!options.quiet) {
        console.log(chalk.yellow(t('qdrantOffline', { count: localCache.rules.length })));
      }
      return localCache.rules;
    }
    return [];
  }
}
