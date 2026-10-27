import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

// config.ts reads the home dir at import time, so every module under test is imported after HOME is swapped.
const realCwd = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-app-fixes-'));
const home = path.join(tmpRoot, 'home');
const proj = path.join(tmpRoot, 'proj');
const lumioDir = path.join(home, '.lumio');
const configFile = path.join(lumioDir, 'config.json');
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.OPENAI_API_KEY;
fs.mkdirSync(lumioDir, { recursive: true });
fs.mkdirSync(proj, { recursive: true });

let config: typeof import('../src/core/config.js');
let db: typeof import('../src/core/db.js');
let dedup: typeof import('../src/core/dedup.js');
let updater: typeof import('../src/core/updater.js');
let providerState: typeof import('../src/core/provider-state.js');

before(async () => {
  assert.equal(os.homedir(), home);
  config = await import('../src/core/config.js');
  db = await import('../src/core/db.js');
  dedup = await import('../src/core/dedup.js');
  updater = await import('../src/core/updater.js');
  providerState = await import('../src/core/provider-state.js');
  assert.equal(config.getConfigDir(), lumioDir);
});

after(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const writeConfig = (c: object) => fs.writeFileSync(configFile, JSON.stringify(c));
const oldNormHash = (text: string) =>
  crypto.createHash('sha256').update(text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()).digest('hex');

/** Minimal Qdrant REST mock: one collection, scroll pages of `pageSize`, upsert appends. */
function mockQdrant(points: any[], pageSize = 2) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      const reply = (result: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', time: 0, result }));
      };
      const url = req.url || '';
      if (url.startsWith('/collections/rules/points/scroll')) {
        const offset = Number(JSON.parse(body || '{}').offset ?? 0);
        const page = points.slice(offset, offset + pageSize);
        return reply({ points: page, next_page_offset: offset + pageSize < points.length ? offset + pageSize : null });
      }
      if (url.startsWith('/collections/rules/points') && req.method === 'PUT') {
        points.push(...JSON.parse(body).points);
        return reply({ operation_id: 1, status: 'completed' });
      }
      if (url.startsWith('/collections/rules')) {
        return reply({ status: 'green', config: { params: { vectors: { size: 256, distance: 'Cosine' } } } });
      }
      if (url.startsWith('/collections')) return reply({ collections: [{ name: 'rules' }] });
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise<{ server: http.Server; port: number; hits: string[] }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port, hits }))
  );
}

test('dedup hash keeps punctuation but ignores case and whitespace', () => {
  const a = 'Always use `===` instead of `==`.';
  const b = 'Always use `==` instead of `===`.';
  assert.notEqual(dedup.getNormHash(a), dedup.getNormHash(b));
  assert.notEqual(dedup.getNormHash('Max length: 80'), dedup.getNormHash('Max length 8.0'));
  assert.equal(dedup.getNormHash('  ALWAYS use\n`===`  instead of `==`. '), dedup.getNormHash(a));
});

test('auto-upgrade only runs from the installed app dir', () => {
  const appDir = path.join(lumioDir, 'app');
  assert.equal(updater.isRunningFromInstalledApp(path.join(appDir, 'dist', 'index.js'), appDir), true);
  assert.equal(updater.isRunningFromInstalledApp(path.join(tmpRoot, 'checkout', 'dist', 'index.js'), appDir), false);
  assert.equal(updater.isRunningFromInstalledApp(`${appDir}-dev/dist/index.js`, appDir), false);
  assert.equal(updater.isRunningFromInstalledApp(appDir, appDir), false);
  assert.equal(updater.isRunningFromInstalledApp(undefined, appDir), false);
});

test('checkAndUpgradeApp skips without network when silent or not installed', async () => {
  assert.equal(await updater.checkAndUpgradeApp(true), 'skipped');
  // The test runner is not under ~/.lumio/app.
  assert.equal(await updater.checkAndUpgradeApp(false), 'skipped');
});

test('installer pipeline fails when the download fails and reads the installed version', () => {
  assert.throws(() => updater.runInstaller(`file://${path.join(tmpRoot, 'missing-install.sh')}`, 10_000));
  const script = path.join(tmpRoot, 'fake-install.sh');
  const appDir = path.join(tmpRoot, 'fake-app');
  fs.writeFileSync(script, `mkdir -p '${appDir}' && echo '{"version":"9.1.0"}' > '${appDir}/package.json'\n`);
  updater.runInstaller(`file://${script}`, 10_000);
  assert.equal(updater.readInstalledAppVersion(appDir), '9.1.0');
  assert.equal(updater.readInstalledAppVersion(path.join(tmpRoot, 'nowhere')), null);
});

test('saving settings from a project dir writes only global values plus the edited field', async () => {
  writeConfig({ dbType: 'local', language: 'id', qdrantCollection: 'global-rules' });
  fs.writeFileSync(path.join(proj, '.lumiorc.json'), JSON.stringify({ qdrantCollection: 'project-rules', defaultReportDir: 'project-reports' }));
  process.chdir(proj);
  try {
    assert.equal((await config.loadConfig()).qdrantCollection, 'project-rules');
    await providerState.updateProviderState((latest) => ({ ...latest, language: 'en' }));
  } finally {
    process.chdir(realCwd);
  }
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  assert.equal(saved.language, 'en');
  assert.equal(saved.qdrantCollection, 'global-rules');
  assert.notEqual(saved.defaultReportDir, 'project-reports');
});

test('Qdrant client is rebuilt when URL or API key change', async () => {
  const a = await mockQdrant([]);
  const b = await mockQdrant([]);
  try {
    writeConfig({ dbType: 'qdrant', qdrantUrl: `http://127.0.0.1:${a.port}`, qdrantCollection: 'rules' });
    await db.getQdrantClient();
    writeConfig({ dbType: 'qdrant', qdrantUrl: `http://127.0.0.1:${b.port}`, qdrantCollection: 'rules' });
    await db.getQdrantClient();
    assert.equal(a.hits.length, 1);
    assert.equal(b.hits.length, 1);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('Qdrant listing paginates and dedup ignores stale stored contentHash', async () => {
  const existing = 'Always use `==` instead of `===`.';
  const points = [
    { id: 1, payload: { source: 'fixture', title: 'Eq', content: existing, contentHash: oldNormHash(existing) } },
    { id: 2, payload: { source: 'fixture', title: 'Two', content: 'Rule two' } },
    { id: 3, payload: { source: 'fixture', title: 'Three', content: 'Rule three' } },
    { id: 4, payload: { source: 'system-prompt', title: 'Prompt', content: 'prompt' } },
    { id: 5, payload: { source: 'fixture', title: 'Five', content: 'Rule five' } },
  ];
  const q = await mockQdrant(points);
  try {
    writeConfig({ dbType: 'qdrant', qdrantUrl: `http://127.0.0.1:${q.port}`, qdrantCollection: 'rules' });
    const listed = await db.listAllIndexedGuidelines();
    assert.deepEqual(listed.map((g) => g.id), ['1', '2', '3', '5']);

    const res = await db.insertChunks([
      { id: 'a', source: 'fixture', title: 'Inverse', content: 'Always use `===` instead of `==`.' },
      { id: 'b', source: 'fixture', title: 'Same', content: '  always USE `==` instead of `===`. ' },
      { id: 'c', source: 'fixture', title: 'Last page dup', content: 'rule FIVE' },
    ]);
    assert.equal(res.insertedCount, 1);
    assert.deepEqual(res.skippedTitles, ['Same', 'Last page dup']);

    // The rules cache covers every page and changes revision when content changes.
    const cached = updater.readCachedRules()!;
    assert.equal(cached.count, 5);
    const rev = cached.revision;
    points[1].payload.title = 'Two renamed';
    await updater.syncGuidelinesRules({ quiet: true });
    assert.notEqual(updater.readCachedRules()!.revision, rev);
  } finally {
    q.server.close();
  }
});

test('local LanceDB search works across separate ingests and delete escapes ids', async () => {
  writeConfig({ dbType: 'local', embeddingModel: 'local' });
  await db.insertChunks([
    { id: 'naming/one', source: 'fixture', title: 'Component naming', content: 'naming components use pascal case component files' },
    { id: 'naming/two', source: 'fixture', title: 'Hook naming', content: 'hooks prefix with use hooks naming' },
  ]);
  await db.insertChunks([
    { id: "o'neil/api", source: 'fixture', title: 'API client', content: 'api calls must use axios instance with interceptors timeout' },
  ]);
  const [top] = await db.searchRelevantGuidelines('axios instance interceptors timeout api', 1);
  assert.equal(top.id, "o'neil/api");

  assert.equal(await db.deleteGuideline("o'neil/api"), true);
  const ids = (await db.listAllIndexedGuidelines()).map((g) => g.id).sort();
  assert.deepEqual(ids, ['naming/one', 'naming/two']);
});

test('install.sh swap keeps the old app when copying the new one fails', () => {
  const root = path.join(tmpRoot, 'installer');
  const shim = path.join(root, 'shim');
  const ihome = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'src', 'repo', 'dist'), { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'repo', 'package.json'), '{"version":"9.9.9"}');
  fs.writeFileSync(path.join(root, 'src', 'repo', 'dist', 'index.js'), '');
  execFileSync('tar', ['-czf', path.join(root, 'repo.tgz'), '-C', path.join(root, 'src'), 'repo']);
  const sh = (name: string, body: string) => fs.writeFileSync(path.join(shim, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  sh('curl', `cat '${path.join(root, 'repo.tgz')}'`);
  sh('npm', 'mkdir -p node_modules/commander');
  sh('cp', 'if [ -n "$CP_FAIL" ] && [[ "$*" == *app.new* ]]; then exit 1; fi\nexec /bin/cp "$@"');

  const run = (extra: Record<string, string>) => {
    fs.rmSync(ihome, { recursive: true, force: true });
    fs.mkdirSync(path.join(ihome, '.lumio', 'app'), { recursive: true });
    fs.writeFileSync(path.join(ihome, '.lumio', 'app', 'package.json'), '{"version":"1.0.0"}');
    let code = 0;
    try {
      execFileSync('bash', [path.join(realCwd, 'install.sh')], {
        env: { ...process.env, HOME: ihome, PATH: `${shim}:${process.env.PATH}`, ...extra },
        stdio: 'pipe',
      });
    } catch (err: any) {
      code = err.status;
    }
    const version = JSON.parse(fs.readFileSync(path.join(ihome, '.lumio', 'app', 'package.json'), 'utf-8')).version;
    return { code, version, entries: fs.readdirSync(path.join(ihome, '.lumio')) };
  };

  assert.deepEqual(run({ CP_FAIL: '1' }), { code: 1, version: '1.0.0', entries: ['app'] });
  assert.deepEqual(run({}), { code: 0, version: '9.9.9', entries: ['app'] });
});
