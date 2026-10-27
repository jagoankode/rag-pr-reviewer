import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../core/config.js';
import { callLLM } from '../core/llm-client.js';
import { confirm } from '../core/nav.js';
import { setRuleChecks } from '../core/db.js';
import { Language, t } from '../core/i18n.js';
import { logError } from '../core/logger.js';
import { loadReviewRules, ReviewRule } from '../core/review-rules.js';
import { ReviewInput } from '../core/review-input.js';
import { CheckProposal, compileRule, trialRun } from '../core/rule-compiler.js';
import { isScriptFile } from '../core/checkers/index.js';
import { parseChecks } from '../core/checkers/spec.js';

export interface RulesCompileOptions {
  /** Rule ids or title fragments; default is every non-meta rule without checks. */
  rule?: string[];
  /** Also recompile rules that already have checks. */
  force?: boolean;
  model?: string;
  language?: Language;
  /** Folder whose files the drafts are tried on before approval. */
  try?: string;
  /** Write the drafts to a JSON file for review instead of (or before) saving. */
  out?: string;
  /** Save drafts from a reviewed JSON file instead of asking the AI. */
  from?: string;
  /** Save every draft without asking. */
  yes?: boolean;
}

/** Drafts file: `{ "<rule id>": { title, checks, checksComplete, reason? } }`. */
type DraftFile = Record<string, { title: string; checks: unknown[]; checksComplete?: boolean; reason?: string }>;

const MAX_TRIAL_FILES = 20000;

function trialInputs(dir: string): ReviewInput[] {
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const root = git(['rev-parse', '--show-toplevel'], path.resolve(dir)).trim();
  const all = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
  const scope = path.relative(root, path.resolve(dir)).split(path.sep).join('/');
  const siblings = new Map<string, string[]>();
  for (const f of all) {
    const folder = path.posix.dirname(f);
    siblings.set(folder, [...(siblings.get(folder) || []), path.posix.basename(f)]);
  }
  const files = all.filter(f => (!scope || f === scope || f.startsWith(`${scope}/`)) && isScriptFile(f));
  if (files.length > MAX_TRIAL_FILES) console.log(chalk.yellow(t('compileTrialLimited', { max: MAX_TRIAL_FILES, total: files.length })));
  return files.slice(0, MAX_TRIAL_FILES).map(file => ({
    file, content: fs.readFileSync(path.join(root, file), 'utf8'), folderFiles: (siblings.get(path.posix.dirname(file)) || []).sort(),
    addedLines: [], diff: '', scope: 'full' as const, hash: '',
  }));
}

function pickRules(rules: readonly Readonly<ReviewRule>[], options: RulesCompileOptions): Readonly<ReviewRule>[] {
  if (options.rule?.length) {
    const wanted = options.rule.map(r => r.toLowerCase());
    return rules.filter(r => wanted.some(w => r.id.toLowerCase() === w || r.title.toLowerCase().includes(w)));
  }
  return rules.filter(r => r.category !== 'meta' && (options.force || !r.checks?.length));
}

function printProposal(p: CheckProposal, hasChecks: boolean, trial: ReturnType<typeof trialRun> | undefined, trialFiles: number): void {
  console.log(chalk.bold.cyan(`\n━━ ${p.title} ${chalk.gray(`(${p.ruleId})`)}`));
  if (hasChecks) console.log(chalk.yellow(`   ${t('compileHasChecks')}`));
  if (p.reason) console.log(chalk.gray(`   ${p.reason}`));
  for (const e of p.errors) console.log(chalk.red(`   ✖ ${e}`));
  if (!p.checks.length) {
    console.log(chalk.gray(`   ${t('compileNothing')}`));
    return;
  }
  console.log(chalk.white(`   ${t('compileCount', { count: p.checks.length, complete: p.complete })}`));
  console.log(chalk.gray(JSON.stringify(p.checks, null, 2).replace(/^/gm, '   ')));
  if (!trial) return;
  console.log(chalk.white(`   ${t('compileTrial', { count: trialFiles })}`));
  for (const spec of p.checks) {
    const id = spec.id || spec.type;
    if (spec.type === 'branch-name' || spec.type === 'commit-message') {
      console.log(chalk.gray(`   - ${t('compileRepoCheck', { id })}`));
      continue;
    }
    const hits = trial.filter(h => h.check === id || h.check.startsWith(`${id}:`));
    console.log(`   - ${id}: ${hits.length ? chalk.yellow(t('compileFindings', { count: hits.length })) : chalk.green(t('compileFindings', { count: 0 }))}`);
    for (const h of hits.slice(0, 3)) console.log(chalk.gray(`       ${h.file}:${h.line}  ${h.comment.slice(0, 100)}`));
  }
}

export async function rulesCompileCommand(options: RulesCompileOptions): Promise<void> {
  const config = await loadConfig();
  // Review comments are always English; drafted check messages follow unless the team asks otherwise.
  const language: Language = options.language || 'en';
  const spinner = ora(chalk.cyan(t('loadingRules'))).start();
  const snapshot = await loadReviewRules(config);
  spinner.stop();

  let proposals: CheckProposal[];
  if (options.from) {
    const drafts: Record<string, unknown> = JSON.parse(fs.readFileSync(options.from, 'utf8'));
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isObject(drafts)) throw new Error(`${options.from}: must be an object keyed by rule id`);
    proposals = Object.entries(drafts).map(([ruleId, entry]) => {
      // A malformed entry is reported like an invalid check, never saved.
      const d: Partial<DraftFile[string]> = isObject(entry) ? entry : {};
      const { checks, errors } = isObject(entry) ? parseChecks(d.checks) : { checks: [], errors: ['entry: must be an object'] };
      const title = snapshot.rules.find(r => r.id === ruleId)?.title || (typeof d.title === 'string' ? d.title : ruleId);
      return { ruleId, title, checks, complete: d.checksComplete === true && !errors.length, reason: typeof d.reason === 'string' ? d.reason : '', errors };
    });
    const unknown = proposals.filter(p => !snapshot.rules.some(r => r.id === p.ruleId));
    if (unknown.length) throw new Error(t('compileNotFound', { ids: unknown.map(p => p.ruleId).join(', ') }));
  } else {
    const targets = pickRules(snapshot.rules, options);
    if (!targets.length) {
      console.log(chalk.yellow(t(!snapshot.rules.length ? 'compileNoRules' : options.rule?.length ? 'compileNoMatch' : 'compileAllDone')));
      return;
    }
    const model = options.model || config.defaultModel || '';
    if (!model) throw new Error(t('noModel'));
    proposals = [];
    for (const [i, rule] of targets.entries()) {
      const s = ora(chalk.cyan(t('compileDrafting', { index: i + 1, total: targets.length, title: rule.title, model }))).start();
      try {
        proposals.push(await compileRule(rule, language, prompt => callLLM(prompt, model, AbortSignal.timeout(180_000), config, { temperature: 0 })));
        s.stop();
      } catch (error) {
        logError('RulesCompile', error, { rule: rule.id, model });
        s.fail(chalk.red(`"${rule.title}": ${(error as Error).message}`));
      }
    }
  }

  if (!proposals.length) {
    console.log(chalk.yellow(`\n${t('compileNoDrafts')}`));
    return;
  }
  const inputs = options.try ? trialInputs(options.try) : undefined;
  for (const p of proposals) {
    const rule = snapshot.rules.find(r => r.id === p.ruleId)!;
    printProposal(p, !!rule.checks?.length, inputs && trialRun(rule, p.checks, inputs), inputs?.length || 0);
  }

  if (options.out) {
    const drafts: DraftFile = Object.fromEntries(proposals.map(p => [p.ruleId, { title: p.title, checks: p.checks, checksComplete: p.complete, reason: p.reason }]));
    fs.writeFileSync(options.out, JSON.stringify(drafts, null, 2) + '\n');
    console.log(chalk.green(`\n${t('compileWritten', { file: options.out })}`));
    if (!options.yes) return;
  }

  const savable = proposals.filter(p => p.checks.length);
  if (!savable.length) return;
  if (!options.yes && !process.stdin.isTTY) {
    console.log(chalk.yellow(`\n${t('compileNotSaved')}`));
    return;
  }
  let saved = 0;
  for (const p of savable) {
    if (!options.yes && !(await confirm({ message: t('compileSavePrompt', { count: p.checks.length, title: p.title }), default: false }))) continue;
    const s = ora(chalk.blue(t('compileSaving', { title: p.title }))).start();
    try {
      await setRuleChecks(p.ruleId, p.checks, p.complete);
      saved++;
      s.succeed(chalk.green(t('compileSaved', { title: p.title })));
    } catch (error) {
      logError('RulesSaveChecks', error, { rule: p.ruleId });
      s.fail(chalk.red(`"${p.title}": ${(error as Error).message}`));
    }
  }
  console.log(chalk.green(`\n${t('compileUpdated', { saved, total: savable.length })}`));
}
