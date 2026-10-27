import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { connectionError, parsePemBundle } from '../src/core/network.js';
import { setLanguage, t } from '../src/core/i18n.js';
setLanguage('en');

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('PEM bundles keep every readable certificate and tell a CA from a site certificate', { skip: !hasOpenssl }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-pem-'));
  try {
    const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Example Root CA',
      '-addext', 'basicConstraints=critical,CA:TRUE');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'site.key', '-out', 'site.csr', '-subj', '/CN=*.example.test');
    openssl('x509', '-req', '-in', 'site.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'site.crt', '-days', '1');
    const bundle = [fs.readFileSync(path.join(dir, 'site.crt'), 'utf8'), 'not a certificate', fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8')].join('\n');
    const certs = parsePemBundle(bundle);
    assert.equal(certs.length, 2);
    assert.deepEqual(certs.filter(c => c.ca).map(c => c.subject), ['CN=Example Root CA']);
    assert.deepEqual(parsePemBundle('-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connection errors name the service, the low-level cause and a matching hint', () => {
  const fetchError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`${code} detail`), { code }) });
  const cert = connectionError('Qdrant', 'https://rules.example.test', fetchError('SELF_SIGNED_CERT_IN_CHAIN')).message;
  assert.match(cert, /^Cannot connect to Qdrant \(https:\/\/rules\.example\.test\): SELF_SIGNED_CERT_IN_CHAIN/);
  assert.ok(cert.includes(t('netHintCert')));
  assert.ok(connectionError('AI provider', 'https://x.example.test', fetchError('ENOTFOUND')).message.includes(t('netHintDns')));
  assert.ok(connectionError('Qdrant', 'https://x.example.test', Object.assign(new Error('Unauthorized'), { status: 401 })).message.includes(t('netHintAuth')));
  assert.equal(connectionError('Qdrant', 'https://x.example.test', new Error('boom')).message, 'Cannot connect to Qdrant (https://x.example.test): boom');
});
