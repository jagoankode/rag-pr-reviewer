import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { X509Certificate } from 'crypto';
import { execFileSync } from 'child_process';
import { getLumioHome } from './config.js';
import { t } from './i18n.js';
import { logError } from './logger.js';

type CaApi = typeof tls & { getCACertificates?: (type: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };

const WINDOWS_ROOTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const isWsl = (): boolean => process.platform === 'linux' && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()));

/** Every parseable certificate in a PEM bundle; anything else is skipped. */
export function parsePemBundle(text: string): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const pem of text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    try {
      out.push(new X509Certificate(pem));
    } catch {}
  }
  return out;
}

const toPem = (base64: string): string => `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * WSL has its own certificate store and does not see Windows', where IT installs the office CA.
 * Reads the Windows root stores through powershell.exe, cached for a week; `refresh` forces a new read.
 * A failed read leaves an empty cache, so a missing powershell.exe does not slow every start.
 */
export function windowsRootCertificates(refresh = false): string[] {
  if (!isWsl()) return [];
  const file = path.join(getLumioHome(), 'cache', 'windows-roots.pem');
  const fresh = (): boolean => fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < WINDOWS_ROOTS_MAX_AGE_MS;
  try {
    if (refresh || !fresh()) {
      let pems = '';
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | ForEach-Object { [Convert]::ToBase64String($_.RawData) }'],
          { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
        pems = [...new Set(out.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].map(toPem).join('');
      } catch (err) {
        logError('WindowsCA', err);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pems);
    }
    return parsePemBundle(fs.readFileSync(file, 'utf8')).filter(cert => cert.ca).map(cert => cert.toString());
  } catch (err) {
    logError('WindowsCA', err);
    return [];
  }
}

/**
 * Office networks that inspect TLS re-sign traffic with their own CA. That CA is installed in the OS store
 * (and on WSL, in the Windows store), which Node's bundled list does not include, so every request fails
 * with "fetch failed". Trust all of them; this only adds CAs the machine already trusts.
 * Node versions without this API rely on NODE_USE_SYSTEM_CA / NODE_EXTRA_CA_CERTS set by the launcher.
 * Returns how many Windows roots were added, or null when this Node cannot change its CA list.
 */
export function trustSystemCertificates(refreshWindows = false): { windows: number } | null {
  const api = tls as CaApi;
  if (!api.getCACertificates || !api.setDefaultCACertificates) return null;
  try {
    const windows = windowsRootCertificates(refreshWindows);
    api.setDefaultCACertificates([...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system'), ...windows])]);
    return { windows: windows.length };
  } catch (err) {
    logError('SystemCA', err);
    return null;
  }
}

const CERT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** First error code in the cause chain: fetch wraps the socket error as `TypeError: fetch failed`. */
function errorCode(err: any): string | undefined {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) if (typeof e.code === 'string') return e.code;
  return undefined;
}

function hint(code: string | undefined, status: number | undefined): string {
  if (code && CERT_CODES.has(code)) return t('netHintCert');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('netHintDns');
  if (code === 'ECONNREFUSED') return t('netHintRefused');
  if (code && /TIMEOUT|ETIMEDOUT/.test(code)) return t('netHintTimeout');
  if (status === 401 || status === 403) return t('netHintAuth');
  if (status === 404) return t('netHintNotFound');
  return '';
}

/** Names the service and URL, the low-level cause and what the user can do about it. */
export function connectionError(service: string, url: string, err: any): Error {
  const code = errorCode(err);
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const deepest = (() => { let e = err; while (e?.cause) e = e.cause; return e; })();
  const cause = [code, status, deepest?.message || err?.message].filter(Boolean).join(' · ');
  const tip = hint(code, status);
  return new Error(t('netFailed', { service, url, cause }) + (tip ? `\n   ${tip}` : ''), { cause: err });
}
