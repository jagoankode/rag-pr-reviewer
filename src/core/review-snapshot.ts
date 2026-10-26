import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import ts from 'typescript';
import { ReviewInput } from './review-input.js';
import { RuleSnapshot } from './review-rules.js';
import { getAppVersion } from './version.js';

// Increment whenever checker or snapshot semantics change, including pre-release builds.
export const REVIEW_ENGINE_VERSION = `checks-1/ts-${ts.version}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ReviewRefs { base: string; head: string; mergeBase: string; mode: string; }
export function resolveReviewRefs(options: { staged?: boolean; source?: string; target?: string }, cwd = process.cwd()): ReviewRefs {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const head = git('rev-parse', '--verify', `${!options.staged && options.source && options.target ? options.source : 'HEAD'}^{commit}`);
  const base = git('rev-parse', '--verify', `${!options.staged && options.target ? options.target : 'HEAD'}^{commit}`);
  const pr = !options.staged && !!options.source && !!options.target;
  // Worktree against a base branch: commits since the merge base are part of the review too.
  const branch = !options.staged && !options.source && !!options.target;
  return { base, head, mergeBase: pr ? git('merge-base', base, head) : branch ? git('merge-base', base, 'HEAD') : base, mode: options.staged ? 'staged' : pr ? 'committed-pr' : branch ? 'branch' : 'worktree' };
}
export function snapshotReview(inputs: readonly ReviewInput[], rules: RuleSnapshot, rawDiff: string, refs: ReviewRefs, scope = 'full') {
  // Do not trust caller-supplied input hashes; fingerprint the exact content used by checkers.
  const captured = inputs.map(i => ({ file: i.file, content: i.content, folderFiles: [...i.folderFiles].sort(), addedLines: [...i.addedLines].sort((a,b)=>a-b), diff: i.diff, scope: i.scope, unavailable: !!i.error })).sort((a,b)=>a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const manifest = { engine: `${getAppVersion()}/${REVIEW_ENGINE_VERSION}`, rules: rules.hash, inputs: hash(captured), diff: hash(rawDiff), ...refs, scope };
  return Object.freeze({ fingerprint: hash(manifest), ...manifest });
}
