import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig, ProviderProfile, resolveProviderForModel } from '../src/core/config.js';
import { registerProvider, assignModels, selectModel, parseModelNames, removeModels, removeProvider } from '../src/core/provider-state.js';
const empty: AppConfig = { dbType: 'local', qdrantUrl: 'preserved', embeddingModel: 'local', defaultReportDir: 'reports', providers: {}, modelProviderMap: {}, savedModels: [], defaultModel: '', provider: '' };
const profile = (id: string): ProviderProfile => ({ id, name: id, providerType: 'custom', apiKey: id + '-synthetic', baseUrl: 'http://localhost:1234/v1', models: [] });
test('empty setup and provider-only registration do not create/select models or change other settings', () => {
 const next = registerProvider(empty, profile('a'));
 assert.deepEqual(next, { ...empty, providers: { a: profile('a') } });
 assert.deepEqual(empty.providers, {});
 assert.equal(resolveProviderForModel(empty).providerId, '');
});
test('existing/new providers, multiple models and same-menu selection retain registry', () => {
 let next = registerProvider(empty, profile('a'));
 next = assignModels(next, parseModelNames('one,two,one'), 'a');
 next = assignModels(registerProvider(next, profile('beta')), ['three'], 'beta');
 next = selectModel(next, 'two');
 assert.deepEqual(next.savedModels, ['one', 'two', 'three']);
 assert.deepEqual(next.modelProviderMap, { one: 'a', two: 'a', three: 'beta' });
 assert.equal(next.apiKey, 'a-synthetic');
 assert.equal(next.providers?.beta.apiKey, 'beta-synthetic');
 assert.equal(next.qdrantUrl, empty.qdrantUrl);
});
test('reject sentinel/unknown/duplicate providers without mutating input', () => {
 const next = registerProvider(empty, profile('a')); const before = structuredClone(next);
 assert.throws(() => registerProvider(next, profile('a')));
 assert.throws(() => registerProvider(next, profile('back')));
 assert.throws(() => assignModels(next, ['one'], 'back'));
 assert.throws(() => parseModelNames('one,back'));
 assert.deepEqual(next, before);
});
test('explicit empty credentials never borrow active provider or environment', () => {
 let next = assignModels(registerProvider(empty, profile('a')), ['one'], 'a');
 next = registerProvider(next, { ...profile('openai'), providerType: 'openai', apiKey: '', baseUrl: '' });
 next = assignModels(next, ['gpt-4o'], 'openai');
 assert.equal(resolveProviderForModel(next).apiKey, '');
 assert.equal(resolveProviderForModel(next).baseUrl, '');
});
test('clear/add cannot resurrect mappings; provider deletion removes associated models', () => {
 let next = assignModels(registerProvider(empty, profile('a')), ['one', 'two'], 'a');
 next = removeModels(next, ['one', 'two']);
 next = assignModels(next, ['three'], 'a');
 assert.deepEqual(next.modelProviderMap, { three: 'a' });
 next = removeProvider(next, 'a');
 assert.deepEqual(next.savedModels, []); assert.equal(next.apiKey, ''); assert.equal(next.defaultModel, '');
 assert.equal(next.baseUrl, ''); assert.equal(next.provider, '');
 assert.equal(next.providers?.a, undefined);
});
test('reassignment removes old provider inventory', () => {
 let next = assignModels(registerProvider(registerProvider(empty, profile('a')), profile('beta')), ['one'], 'a');
 next = assignModels(next, ['one'], 'beta');
 assert.deepEqual(next.providers?.a.models, []); assert.deepEqual(next.providers?.beta.models, ['one']);
});

test('fresh commits preserve global settings and restart persistence without project override leakage', async () => {
 const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const path = await import('node:path');
 const { execFileSync } = await import('node:child_process');
 const home = await mkdtemp(path.join(tmpdir(), 'lumio-provider-test-'));
 try {
  await mkdir(path.join(home, '.lumio'));
  const file = path.join(home, '.lumio/config.json');
  await writeFile(file, JSON.stringify(empty));
  await writeFile(path.join(home, '.lumiorc.json'), JSON.stringify({ qdrantUrl: 'project-only', defaultReportDir: 'project-reports' }));
  const modulePath = path.resolve('src/core/provider-state.ts');
  const configPath = path.resolve('src/core/config.ts');
  const env = { ...process.env, HOME: home };
  delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL;
  const run = (code: string) => execFileSync(path.resolve('node_modules/.bin/tsx'), ['-e', code], { cwd: home, env, encoding: 'utf8' });
  run(`import {registerProvider, assignModels, updateProviderState} from ${JSON.stringify(modulePath)}; (async()=>{await updateProviderState(c=>registerProvider(c,${JSON.stringify(profile('a'))}));await updateProviderState(c=>assignModels(c,['one','two'],'a'));})()`);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.qdrantUrl, 'preserved'); assert.equal(disk.defaultReportDir, 'reports');
  assert.deepEqual(disk.modelProviderMap, { one: 'a', two: 'a' });
  const restarted = JSON.parse(run(`import {loadConfig} from ${JSON.stringify(configPath)}; loadConfig(false).then(c=>console.log(JSON.stringify(c)))`));
  assert.deepEqual(restarted, disk);
 } finally { await rm(home, { recursive: true, force: true }); }
});
