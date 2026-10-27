import { execFileSync } from 'child_process';
import { RuleSnapshot } from '../review-rules.js';
import { fill } from './spec.js';
import { matchAny } from './glob.js';
import { Severity } from './types.js';

export interface RepoFinding {
  ruleId: string;
  rule: string;
  check: 'branch-name' | 'commit-message';
  severity: Severity;
  subject: string;
  comment: string;
  suggestedFix: string | null;
}

export interface RepoContext {
  branch?: string;
  commits: { sha: string; subject: string }[];
}

/** Branch and commit checks declared by the rules (`branch-name`, `commit-message`). */
export function repoAudit(snapshot: RuleSnapshot, repo: RepoContext): RepoFinding[] {
  const out: RepoFinding[] = [];
  const branch = repo.branch?.replace(/^(?:origin|upstream)\//, '');
  for (const rule of snapshot.rules) {
    for (const spec of rule.checks || []) {
      const report = (subject: string, values: Record<string, string>) => out.push({ ruleId: rule.id, rule: rule.title, check: spec.type as RepoFinding['check'], severity: spec.severity, subject,
        comment: fill(spec.message, values), suggestedFix: spec.fix ? fill(spec.fix, values) : null });
      if (spec.type === 'branch-name' && branch && !matchAny(branch, spec.allow, false) && !new RegExp(spec.pattern).test(branch)) {
        report(branch, { name: branch, text: branch, slug: branch.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') });
      }
      if (spec.type === 'commit-message') {
        const pattern = new RegExp(spec.pattern);
        for (const commit of repo.commits) if (!pattern.test(commit.subject)) report(`${commit.sha} ${commit.subject}`, { name: commit.sha, value: commit.subject, text: commit.subject });
      }
    }
  }
  return out;
}

/** Branch under review and its non-merge commits since the merge base. */
export function readRepoContext(refs: { head: string; mergeBase: string; mode: string }, source: string | undefined, cwd = process.cwd()): RepoContext {
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Without a source the checked-out branch is reviewed; a source that is not a branch (SHA, tag) has no branch to check.
  let branch: string | undefined;
  try {
    branch = source ? git('rev-parse', '--symbolic-full-name', source).match(/^refs\/(?:heads|remotes)\/(.+)$/)?.[1] : git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch { branch = undefined; }
  if (branch === 'HEAD') branch = undefined;
  const range = refs.mode === 'committed-pr' ? `${refs.mergeBase}..${refs.head}` : refs.mode === 'branch' ? `${refs.mergeBase}..HEAD` : undefined;
  const commits = range ? git('log', '--no-merges', '--format=%h%x09%s', range).split('\n').filter(Boolean).map(line => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  }) : [];
  return { branch, commits };
}
