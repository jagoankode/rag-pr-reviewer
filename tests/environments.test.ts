import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { envFlag, resolveEnvironment, stripEnvFlag } from '../src/core/config.js';
import { createEnvironment, listEnvironments } from '../src/commands/env.js';

const HOME = '/home/dev';
const node = ['node', 'lumio'];

test('environment: default is ~/.lumio', () => {
  assert.deepEqual(resolveEnvironment(node, {}, HOME), { name: 'default', configDir: '/home/dev/.lumio' });
});

test('environment: --env beats LUMIO_ENV, which beats LUMIO_CONFIG_DIR', () => {
  const env = { LUMIO_ENV: 'staging', LUMIO_CONFIG_DIR: '~/custom' };
  assert.equal(resolveEnvironment([...node, 'review', '--env', 'dev'], env, HOME).configDir, '/home/dev/.lumio/envs/dev');
  assert.equal(resolveEnvironment([...node, '--env=dev'], env, HOME).name, 'dev');
  assert.equal(resolveEnvironment(node, env, HOME).configDir, '/home/dev/.lumio/envs/staging');
  assert.deepEqual(resolveEnvironment(node, { LUMIO_CONFIG_DIR: '~/custom' }, HOME), { configDir: '/home/dev/custom' });
  assert.equal(resolveEnvironment([...node, '--env', 'default'], env, HOME).configDir, '/home/dev/.lumio');
});

test('environment: invalid names fall back to default with an error, never a path outside envs', () => {
  for (const name of ['../prod', 'Dev', '', 'a/b']) {
    const env = resolveEnvironment([...node, '--env', name], {}, HOME);
    assert.equal(env.configDir, '/home/dev/.lumio');
    assert.equal(env.error, name);
  }
});

test('environment: --env is stripped from argv, other options and args after -- are kept', () => {
  assert.deepEqual(stripEnvFlag([...node, '--env', 'dev', 'review', '--json']), [...node, 'review', '--json']);
  assert.deepEqual(stripEnvFlag([...node, 'review', '--env=dev', '--', '--env', 'x']), [...node, 'review', '--', '--env', 'x']);
  assert.equal(envFlag([...node, '--', '--env', 'dev']), undefined);
});

test('environment: create copies config with mode 600, refuses duplicates, lists envs', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lumio-env-'));
  try {
    await fs.mkdir(path.join(home, '.lumio'));
    await fs.writeFile(path.join(home, '.lumio', 'config.json'), JSON.stringify({ dbType: 'qdrant', qdrantCollection: 'team-rules', defaultModel: 'm1' }));
    const dev = await createEnvironment('dev', { collection: 'team-rules-dev' }, home);
    assert.equal(dev.collection, 'team-rules-dev');
    assert.equal(dev.model, 'm1');
    const stat = await fs.stat(path.join(dev.configDir, 'config.json'));
    assert.equal(stat.mode & 0o777, 0o600);
    await assert.rejects(createEnvironment('dev', {}, home));
    await assert.rejects(createEnvironment('default', {}, home));
    await assert.rejects(createEnvironment('qa', { from: 'missing' }, home));
    const qa = await createEnvironment('qa', { from: 'dev' }, home);
    assert.equal(qa.collection, 'team-rules-dev');
    assert.deepEqual((await listEnvironments(home)).map(e => [e.name, e.collection]), [['default', 'team-rules'], ['dev', 'team-rules-dev'], ['qa', 'team-rules-dev']]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
