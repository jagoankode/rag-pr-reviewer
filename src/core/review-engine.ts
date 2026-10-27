import { createHash } from 'crypto';
import { LineViolation, PRReviewResult } from './schema.js';
import { ReviewRule, RuleSnapshot } from './review-rules.js';
import { ReviewInput } from './review-input.js';
import { fullyCovered, hasChecks, hasParseErrors, isScriptFile, parseSource, runChecks } from './checkers/index.js';
import { RepoFinding } from './checkers/git.js';
import { matchAny } from './checkers/glob.js';
import { out } from './i18n.js';

export type CoverageStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export interface Coverage { ruleId: string; file: string; status: CoverageStatus; reason: string; }
export interface Finding extends LineViolation { ruleId: string; column: number; id: string; check: string; engine: 'ast' | 'filesystem' | 'ai'; }
export interface FileAudit { file: string; violations: Finding[]; coverage: Coverage[]; complete: boolean; skipped?: string; notes?: string[]; }
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** A rule's targetFiles, matched with the same globs as its checks; no targetFiles means every file. */
export function fileMatchesPattern(file: string, patterns?: string[]): boolean {
  return !patterns || !patterns.length || matchAny(file, patterns);
}

function finding(input: ReviewInput, rule: Readonly<ReviewRule>, line: number, column: number, check: string, comment: string, engine: Finding['engine'], severity: Finding['severity'], suggestedFix: string | null = null): Finding {
  const key = JSON.stringify([rule.id, input.file, line, column, check]);
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 24), ruleId: rule.id, rule: rule.title, file: input.file, line, column, check, engine, severity, comment, suggestedFix };
}

export function stableFindings(items: Finding[]): Finding[] {
  return [...new Map([...items].sort((a,b) => compareText(a.id, b.id) || compareText(a.comment, b.comment)).map(v => [v.id, v])).values()]
    .sort((a,b) => compareText(a.file, b.file) || a.line-b.line || a.column-b.column || compareText(a.ruleId, b.ruleId) || compareText(a.check, b.check));
}

/** The rules' declared checks (AST/filesystem). Reproducible for the same input and rule snapshot. */
export function deterministicAudit(input: ReviewInput, snapshot: RuleSnapshot): Finding[] {
  return stableFindings(runChecks(input, snapshot).map(hit =>
    finding(input, hit.rule, hit.line, hit.column, hit.check, hit.comment, hit.engine, hit.severity, hit.suggestedFix)));
}

/** Rules the AI should evaluate for this file: targeted at it, not metadata, and not fully enforced by checks. */
export function rulesForAI(input: ReviewInput, snapshot: RuleSnapshot): Readonly<ReviewRule>[] {
  return snapshot.rules.filter(r => r.category !== 'meta' && !fullyCovered(r) && fileMatchesPattern(input.file, r.targetFiles));
}

/**
 * Parses the AI coverage JSON. Each violation is validated on its own (rule id, file, physical line/column,
 * diff scope); invalid ones are dropped instead of being salvaged. A missing or malformed response marks the
 * file as incomplete, so it can never produce a clean APPROVE.
 */
export function parseAICoverage(raw: string, input: ReviewInput, snapshot: RuleSnapshot): FileAudit {
  const violations: Finding[] = [], coverage: Coverage[] = [];
  let entries: any[] = [];
  let complete = true;
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!Array.isArray(parsed.coverage)) throw new Error('Missing coverage');
    entries = parsed.coverage;
  } catch { complete = false; }
  const lines = input.content.split('\n');
  for (const rule of snapshot.rules) {
    const matches = entries.filter(e => e && e.ruleId === rule.id);
    const e = matches[0];
    if (matches.length !== 1 || !['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(e.status)) {
      complete = false;
      continue;
    }
    for (const v of Array.isArray(e.violations) ? e.violations : []) {
      const valid = v && v.file === input.file && Number.isInteger(v.line) && v.line >= 1 && v.line <= lines.length &&
        (input.scope !== 'diff' || input.addedLines.includes(v.line)) && typeof v.comment === 'string' && v.comment.trim() && ['error', 'warning', 'info'].includes(v.severity);
      if (!valid) continue;
      const column = Number.isInteger(v.column) && v.column >= 1 && v.column <= lines[v.line - 1].length + 1 ? v.column : 1;
      violations.push(finding(input, rule, v.line, column, 'ai', v.comment.trim(), 'ai', v.severity === 'info' ? 'warning' : v.severity, typeof v.suggestedFix === 'string' ? v.suggestedFix : null));
    }
    const failed = violations.some(v => v.ruleId === rule.id);
    // A FAIL whose every violation was invalid is unverified, not a PASS.
    if (e.status === 'FAIL' && !failed) {
      complete = false;
      coverage.push({ ruleId: rule.id, file: input.file, status: 'FAIL', reason: 'Reported violations failed validation.' });
      continue;
    }
    coverage.push({ ruleId: rule.id, file: input.file, status: failed ? 'FAIL' : e.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'PASS', reason: typeof e.reason === 'string' && e.reason.trim() ? e.reason : 'No reason given.' });
  }
  return { file: input.file, violations: stableFindings(violations), coverage, complete };
}

/** Deterministic-only audit. Complete means every bound checker ran on a parseable input. */
export function coreAudit(input: ReviewInput, snapshot: RuleSnapshot): FileAudit {
  if (input.skipped) return { file: input.file, violations: [], coverage: [], complete: true, skipped: input.skipped };
  const violations = deterministicAudit(input, snapshot);
  const parsed = isScriptFile(input.file) ? parseSource(input) : undefined;
  const invalid = !!input.error || (!!parsed && hasParseErrors(parsed));
  const coverage: Coverage[] = snapshot.rules.map(rule => {
    const failed = violations.some(v => v.ruleId === rule.id);
    const notApplicable = rule.category === 'meta' || !fileMatchesPattern(input.file, rule.targetFiles);
    return { ruleId: rule.id, file: input.file, status: failed ? 'FAIL' : notApplicable && !hasChecks(rule) ? 'NOT_APPLICABLE' : 'PASS',
      reason: invalid ? 'Input unavailable or syntax invalid; verification skipped.' : failed ? 'Violation found.' : notApplicable ? 'Rule does not target this file.' : hasChecks(rule) ? 'Declared checks found no violation.' : 'Not checked deterministically.' };
  });
  return { file: input.file, violations, coverage, complete: snapshot.rules.length > 0 && !invalid, notes: input.error ? [input.error] : invalid ? [out('syntaxError')] : [] };
}

/**
 * Deterministic checks plus AI review of the remaining rule clauses. Validated AI findings count toward the
 * verdict; an AI outage keeps the deterministic findings and marks the file incomplete.
 */
export async function auditFile(input: ReviewInput, snapshot: RuleSnapshot, ai: (findings: Finding[], rules: RuleSnapshot) => Promise<string>): Promise<FileAudit> {
  const core = coreAudit(input, snapshot);
  // Generated snapshots are not authored code, so they never go to the AI.
  if (core.skipped || input.error || !snapshot.rules.length || !core.complete || input.file.includes('/__snapshots__/')) return core;
  const aiRules = rulesForAI(input, snapshot);
  if (!aiRules.length) return core;
  const aiSnapshot: RuleSnapshot = { rules: aiRules, hash: snapshot.hash };
  try {
    const advisory = parseAICoverage(await ai(core.violations, aiSnapshot), input, aiSnapshot);
    // A deterministic finding already owns that rule/line, so an AI repeat of it is dropped.
    const owned = new Set(core.violations.map(v => `${v.ruleId}:${v.line}`));
    const extra = advisory.violations.filter(v => !owned.has(`${v.ruleId}:${v.line}`));
    const coverage = core.coverage.map(c => {
      const a = advisory.coverage.find(x => x.ruleId === c.ruleId);
      return a && c.status !== 'FAIL' ? a : c;
    });
    return { ...core, violations: stableFindings([...core.violations, ...extra]), coverage, complete: advisory.complete,
      notes: advisory.complete ? core.notes : [...(core.notes || []), out('aiIncomplete')] };
  } catch (error) {
    return { ...core, complete: false, notes: [...(core.notes || []), out('aiUnavailable', { message: (error as Error).message })] };
  }
}

// Skip reasons are stable codes from the diff parser; the report shows them in the output language.
const SKIP_REASONS: Record<string, () => string> = { 'File deleted': () => out('skipDeleted'), 'Binary or metadata-only change': () => out('skipBinary') };

/** `partial`: some inputs were never audited (e.g. the finding limit stopped the run). Skipped files do not block completeness. */
export function summarizeAudit(audits: FileAudit[], snapshot: RuleSnapshot, repository: RepoFinding[] = [], partial = false): PRReviewResult {
  const violations = stableFindings(audits.flatMap(a => a.violations));
  const reviewed = audits.filter(a => !a.skipped);
  const complete = !partial && audits.length > 0 && snapshot.rules.length > 0 && reviewed.every(a => a.complete);
  const errors = violations.filter(v => v.severity === 'error').length + repository.filter(r => r.severity === 'error').length;
  const warnings = violations.length + repository.length - errors;
  const status = errors ? 'REQUEST_CHANGES' : warnings || !complete ? 'COMMENT' : 'APPROVE';
  const filesWithFindings = new Set(violations.map(v => v.file)).size;
  const summary = !snapshot.rules.length ? out('summaryNoRules') : out('summary', {
    reviewed: reviewed.length, errors, warnings, files: filesWithFindings,
    repo: repository.length ? out('summaryRepo', { count: repository.length }) : '',
    incomplete: complete ? '' : out('summaryIncomplete'),
  });
  return {
    status, summary, violations, generalFeedback: [], complete, ruleSnapshot: snapshot.hash,
    repository,
    skippedFiles: audits.filter(a => a.skipped).map(a => ({ file: a.file, reason: SKIP_REASONS[a.skipped!]?.() || a.skipped! })),
    notes: [
      ...snapshot.rules.flatMap(r => (r.checkErrors || []).map(e => out('invalidCheck', { title: r.title, error: e }))),
      ...audits.flatMap(a => (a.notes || []).map(n => `${a.file}: ${n}`)),
    ],
    coverage: audits.flatMap(a => a.coverage).sort((a,b) => compareText(a.file,b.file) || compareText(a.ruleId,b.ruleId)),
  };
}
