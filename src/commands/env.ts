import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { DEFAULT_ENV, getEnvironment, isValidEnvName } from '../core/config.js';
import { t } from '../core/i18n.js';

export interface EnvironmentInfo {
  name: string;
  configDir: string;
  hasConfig: boolean;
  collection?: string;
  model?: string;
}

const dirFor = (name: string, home: string): string =>
  name === DEFAULT_ENV ? path.join(home, '.lumio') : path.join(home, '.lumio', 'envs', name);

async function describe(name: string, home: string): Promise<EnvironmentInfo> {
  const configDir = dirFor(name, home);
  try {
    const config = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf-8'));
    return { name, configDir, hasConfig: true, collection: config.dbType === 'qdrant' ? config.qdrantCollection : 'local', model: config.defaultModel };
  } catch {
    return { name, configDir, hasConfig: false };
  }
}

/** The default environment plus every directory under ~/.lumio/envs. */
export async function listEnvironments(home: string = os.homedir()): Promise<EnvironmentInfo[]> {
  let names: string[] = [];
  try {
    const entries = await fs.readdir(path.join(home, '.lumio', 'envs'), { withFileTypes: true });
    names = entries.filter(e => e.isDirectory() && isValidEnvName(e.name) && e.name !== DEFAULT_ENV).map(e => e.name).sort();
  } catch {
    // No named environments yet
  }
  return Promise.all([DEFAULT_ENV, ...names].map(name => describe(name, home)));
}

/**
 * Creates a named environment from a copy of another one's config.json (keys included, so mode 600).
 * Caches, logs and the local DB start empty.
 */
export async function createEnvironment(name: string, options: { from?: string; collection?: string } = {}, home: string = os.homedir()): Promise<EnvironmentInfo> {
  if (!isValidEnvName(name) || name === DEFAULT_ENV) throw new Error(t('envInvalid', { name }));
  const from = options.from || DEFAULT_ENV;
  if (!isValidEnvName(from)) throw new Error(t('envInvalid', { name: from }));
  const target = dirFor(name, home);
  const file = path.join(target, 'config.json');
  if (await fs.access(file).then(() => true, () => false)) throw new Error(t('envExists', { name, file }));
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await fs.readFile(path.join(dirFor(from, home), 'config.json'), 'utf-8'));
  } catch {
    throw new Error(t('envSourceMissing', { name: from }));
  }
  if (options.collection) config = { ...config, dbType: 'qdrant', qdrantCollection: options.collection };
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return describe(name, home);
}

export async function envListCommand(): Promise<void> {
  const active = getEnvironment();
  for (const env of await listEnvironments()) {
    const current = env.name === active.name;
    const details = env.hasConfig ? [env.collection || '-', env.model || '-'].join(' · ') : t('envNoConfig');
    console.log(`${current ? chalk.green('*') : ' '} ${chalk.bold(env.name.padEnd(12))} ${chalk.gray(details)}  ${chalk.dim(env.configDir)}`);
  }
  if (!active.name) console.log(chalk.yellow(`* LUMIO_CONFIG_DIR ${active.configDir}`));
}

export async function envCreateCommand(name: string, options: { from?: string; collection?: string }): Promise<void> {
  const env = await createEnvironment(name, options);
  console.log(chalk.green(t('envCreated', { name, dir: env.configDir, from: options.from || DEFAULT_ENV })));
  console.log(chalk.gray(t('envCreatedHint', { name })));
}
