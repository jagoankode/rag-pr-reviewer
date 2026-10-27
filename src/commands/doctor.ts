import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { AppConfig, getConfigDir, loadConfig, resolveProviderForModel } from '../core/config.js';
import { getAppVersion } from '../core/version.js';
import { compareSemver, fetchLatestVersion } from '../core/updater.js';
import { loadReviewRules } from '../core/review-rules.js';
import { callLLM } from '../core/llm-client.js';
import { t } from '../core/i18n.js';
import { logError } from '../core/logger.js';

type Status = 'ok' | 'warn' | 'fail';
interface CheckResult { status: Status; detail: string; hint?: string; }

const SYMBOL: Record<Status, string> = { ok: chalk.green('✔'), warn: chalk.yellow('▲'), fail: chalk.red('✖') };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function checkVersion(): Promise<CheckResult> {
  const current = getAppVersion();
  const latest = await fetchLatestVersion();
  if (!latest) return { status: 'warn', detail: `v${current}`, hint: t('doctorVersionUnknown') };
  if (compareSemver(latest, current) > 0) return { status: 'warn', detail: `v${current} → v${latest}`, hint: t('doctorVersionOld') };
  return { status: 'ok', detail: `v${current}` };
}

function checkNode(): CheckResult {
  const systemCa = typeof (tls as { getCACertificates?: unknown }).getCACertificates === 'function';
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  const detail = `${process.version} · ${systemCa ? t('doctorSystemCaYes') : t('doctorSystemCaNo')}${extra ? ` · NODE_EXTRA_CA_CERTS=${extra}` : ''}`;
  if (!systemCa && !extra) return { status: 'warn', detail, hint: t('doctorNodeHint') };
  return { status: 'ok', detail };
}

function checkGit(): CheckResult {
  try {
    return { status: 'ok', detail: execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch {
    return { status: 'fail', detail: t('doctorGitMissing'), hint: t('doctorGitHint') };
  }
}

function checkConfig(config: AppConfig): CheckResult {
  const file = path.join(getConfigDir(), 'config.json');
  if (!fs.existsSync(file)) return { status: 'warn', detail: t('doctorConfigMissing', { file }), hint: t('doctorConfigHint') };
  const project = ['.lumiorc.json', '.lumio.json'].find(name => fs.existsSync(path.join(process.cwd(), name)));
  const db = config.dbType === 'qdrant' ? `Qdrant · ${config.qdrantCollection || '-'}` : 'LanceDB';
  return { status: 'ok', detail: `${file} · ${db}${project ? ` · ${t('doctorProjectConfig', { file: project })}` : ''}` };
}

/** Who signed the server certificate, and whether this process trusts it. Shows TLS inspection by name. */
function probeTls(rawUrl: string): Promise<CheckResult> {
  return new Promise(resolve => {
    let url: URL;
    try {
      url = new URL(/^https?:/.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    } catch {
      resolve({ status: 'fail', detail: t('doctorUrlInvalid', { url: rawUrl }) });
      return;
    }
    if (url.protocol !== 'https:') {
      resolve({ status: 'ok', detail: t('doctorTlsPlain', { host: url.host }) });
      return;
    }
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false, timeout: 10_000 });
    const done = (result: CheckResult) => { socket.destroy(); resolve(result); };
    socket.once('secureConnect', () => {
      let cert = socket.getPeerCertificate(true);
      while (cert.issuerCertificate && cert.issuerCertificate !== cert) cert = cert.issuerCertificate;
      const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
      const issuer = pick(cert.issuer?.O) || pick(cert.issuer?.CN) || '?';
      const detail = `${url.host} · ${t('doctorIssuer', { issuer })}`;
      if (socket.authorized) done({ status: 'ok', detail });
      else done({ status: 'fail', detail: `${detail} · ${socket.authorizationError}`, hint: t('netHintCert') });
    });
    socket.once('timeout', () => done({ status: 'fail', detail: `${url.host} · timeout`, hint: t('netHintTimeout') }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done({ status: 'fail', detail: `${url.host} · ${err.code || err.message}`, hint: err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? t('netHintDns') : undefined }));
  });
}

async function checkRules(config: AppConfig): Promise<CheckResult> {
  try {
    const snapshot = await loadReviewRules(config);
    const withChecks = snapshot.rules.filter(r => r.checks?.length).length;
    const detail = t('doctorRulesCount', { count: snapshot.rules.length, checks: withChecks });
    return snapshot.rules.length ? { status: 'ok', detail } : { status: 'warn', detail, hint: t('doctorRulesEmpty') };
  } catch (err) {
    return { status: 'fail', detail: message(err) };
  }
}

async function checkModel(config: AppConfig): Promise<CheckResult> {
  const resolved = resolveProviderForModel(config);
  if (!resolved.model) return { status: 'fail', detail: t('doctorNoModel'), hint: t('doctorNoModelHint') };
  const started = Date.now();
  try {
    const answer = await callLLM('Reply with the single word OK.', resolved.model, AbortSignal.timeout(60_000), config, { temperature: 0 });
    const detail = `${resolved.model} · ${Date.now() - started} ms`;
    return answer.trim() ? { status: 'ok', detail } : { status: 'warn', detail, hint: t('doctorModelEmpty') };
  } catch (err) {
    // Connection errors already carry their own hint.
    return { status: 'fail', detail: `${resolved.model} · ${message(err)}`, hint: err instanceof Error && err.cause ? undefined : t('doctorModelHint') };
  }
}

/** Runs every check in order and prints each result as it completes. Returns false when any check failed. */
export async function doctorCommand(options: { ai?: boolean } = {}): Promise<boolean> {
  const config = await loadConfig();
  const provider = resolveProviderForModel(config);
  const checks: [string, () => CheckResult | Promise<CheckResult>][] = [
    [t('doctorVersion'), checkVersion],
    ['Node.js', checkNode],
    ['Git', checkGit],
    [t('doctorConfig'), () => checkConfig(config)],
  ];
  if (config.dbType === 'qdrant' && config.qdrantUrl) checks.push([t('doctorTls', { service: 'Qdrant' }), () => probeTls(config.qdrantUrl!)]);
  checks.push([t('doctorRules'), () => checkRules(config)]);
  if (options.ai !== false) {
    checks.push([t('doctorTls', { service: 'AI provider' }), () => probeTls(provider.baseUrl || 'https://api.openai.com/v1')]);
    checks.push([t('doctorModel'), () => checkModel(config)]);
  }

  console.log(chalk.bold.cyan(`\n🩺 ${t('doctorTitle')}\n`));
  let failed = 0, warned = 0;
  for (const [label, run] of checks) {
    const spinner = ora(chalk.gray(label)).start();
    let result: CheckResult;
    try {
      result = await run();
    } catch (err) {
      result = { status: 'fail', detail: message(err) };
    }
    if (result.status === 'fail') {
      failed++;
      logError('Doctor', result.detail, { check: label });
    }
    if (result.status === 'warn') warned++;
    spinner.stopAndPersist({ symbol: SYMBOL[result.status], text: `${chalk.bold(label)}  ${chalk.gray(result.detail)}` });
    if (result.hint) console.log(`   ${chalk.yellow(result.hint)}`);
  }
  const summary = failed ? chalk.red(t('doctorFailed', { count: failed })) : warned ? chalk.yellow(t('doctorWarned', { count: warned })) : chalk.green(t('doctorAllOk'));
  console.log(`\n${summary}\n`);
  return failed === 0;
}
