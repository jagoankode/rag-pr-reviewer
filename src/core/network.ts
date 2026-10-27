import tls from 'tls';
import { t } from './i18n.js';
import { logError } from './logger.js';

type CaApi = typeof tls & { getCACertificates?: (type: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };

/**
 * Office networks that inspect TLS re-sign traffic with their own CA. That CA is installed in the OS store,
 * which Node's bundled list does not include, so every request fails with "fetch failed". Trust both.
 * Node versions without this API rely on NODE_USE_SYSTEM_CA / NODE_EXTRA_CA_CERTS set by the launcher.
 */
export function trustSystemCertificates(): void {
  const api = tls as CaApi;
  if (!api.getCACertificates || !api.setDefaultCACertificates) return;
  try {
    api.setDefaultCACertificates([...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system')])]);
  } catch (err) {
    logError('SystemCA', err);
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
