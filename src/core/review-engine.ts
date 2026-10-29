import { createHash } from 'crypto';
import { LineViolation, PRReviewResult } from './schema.js';
import { ReviewRule, RuleSnapshot } from './review-rules.js';
import { ReviewInput } from './review-input.js';
import { isGeneratedSnapshotFile } from './diff-parser.js';
import { fullyCovered, hasApplicableFileChecks, hasOnlyRepositoryChecks, hasParseErrors, isScriptFile, parseSource, runChecks } from './checkers/index.js';
import { RepoFinding } from './checkers/git.js';
import { matchAny } from './checkers/glob.js';
import { out } from './i18n.js';

export type CoverageStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'UNVERIFIED';
export interface Coverage { ruleId: string; file: string; status: CoverageStatus; reason: string; }
export interface Finding extends LineViolation { ruleId: string; column: number; id: string; check: string; engine: 'ast' | 'filesystem' | 'ai'; }
/** On a line the change did not add: reported apart from the change's findings and never affects the verdict. */
export const isExisting = (v: LineViolation): boolean => v.existing === true;
export interface FileAudit { file: string; violations: Finding[]; coverage: Coverage[]; complete: boolean; skipped?: string; unaudited?: boolean; notes?: string[]; }
export type AIScope = 'changed' | 'full';
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** A rule's targetFiles, matched with the same globs as its checks; no targetFiles means every file. */
export function fileMatchesPattern(file: string, patterns?: string[]): boolean {
  return !patterns || !patterns.length || matchAny(file, patterns);
}

function finding(input: ReviewInput, rule: Readonly<ReviewRule>, line: number, column: number, check: string, comment: string, engine: Finding['engine'], severity: Finding['severity'], suggestedFix: string | null = null): Finding {
  const key = JSON.stringify([rule.id, input.file, line, column, check]);
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 24), ruleId: rule.id, rule: rule.title, file: input.file, line, column, check, engine, severity, comment, suggestedFix,
    ...(input.addedLines.includes(line) ? {} : { existing: true }) };
}

export function stableFindings(items: Finding[]): Finding[] {
  return [...new Map([...items].sort((a,b) => compareText(a.id, b.id) || compareText(a.comment, b.comment)).map(v => [v.id, v])).values()]
    .sort((a,b) => compareText(a.file, b.file) || a.line-b.line || a.column-b.column || compareText(a.ruleId, b.ruleId) || compareText(a.check, b.check));
}

/** The rules' declared checks (AST/filesystem). Reproducible for the same input and rule snapshot. */
export function deterministicAudit(input: ReviewInput, snapshot: RuleSnapshot, failedRules?: Set<string>): Finding[] {
  return stableFindings(runChecks(input, snapshot, failedRules).map(hit =>
    finding(input, hit.rule, hit.line, hit.column, hit.check, hit.comment, hit.engine, hit.severity, hit.suggestedFix)));
}

/** Rules the AI should evaluate for this file: targeted at it, not metadata, and not fully enforced by checks. */
export function rulesForAI(input: ReviewInput, snapshot: RuleSnapshot): Readonly<ReviewRule>[] {
  return snapshot.rules.filter(r => r.category !== 'meta' && !hasOnlyRepositoryChecks(r) && !fullyCovered(r) &&
    fileMatchesPattern(input.file, r.targetFiles));
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
      coverage.push({ ruleId: rule.id, file: input.file, status: 'UNVERIFIED', reason: 'Missing, duplicate or invalid AI coverage.' });
      continue;
    }
    let invalid = e.violations !== undefined && !Array.isArray(e.violations), outOfScope = 0;
    for (const v of Array.isArray(e.violations) ? e.violations : []) {
      // The prompt holds one file, so an omitted path means this file.
      const valid = v && (v.file === undefined || v.file === input.file) && Number.isInteger(v.line) && v.line >= 1 && v.line <= lines.length &&
        typeof v.comment === 'string' && v.comment.trim() && ['error', 'warning', 'info'].includes(v.severity);
      if (!valid) { invalid = true; continue; }
      // A well-formed finding on an unchanged line in diff scope is out of scope, not evidence of a broken answer.
      if (input.scope === 'diff' && !input.addedLines.includes(v.line)) { outOfScope++; continue; }
      const column = Number.isInteger(v.column) && v.column >= 1 && v.column <= lines[v.line - 1].length + 1 ? v.column : 1;
      violations.push(finding(input, rule, v.line, column, 'ai', v.comment.trim(), 'ai', v.severity === 'info' ? 'warning' : v.severity, typeof v.suggestedFix === 'string' ? v.suggestedFix : null));
    }
    const failed = violations.some(v => v.ruleId === rule.id);
    // A FAIL without any usable violation, or with a malformed one, is unverified rather than a PASS.
    if (invalid || (e.status === 'FAIL' && !failed && !outOfScope)) {
      complete = false;
      coverage.push({ ruleId: rule.id, file: input.file, status: 'UNVERIFIED', reason: 'Reported violations failed validation.' });
      continue;
    }
    // Validated violations decide FAIL whatever status the AI wrote; out-of-scope ones leave the changed lines passing.
    const reason = !failed && outOfScope ? 'Violations reported only on unchanged lines.' : typeof e.reason === 'string' && e.reason.trim() ? e.reason
      : failed ? 'Violation found.' : e.status === 'NOT_APPLICABLE' ? 'AI: rule does not concern this file.' : 'AI: no violation found.';
    coverage.push({ ruleId: rule.id, file: input.file, status: failed ? 'FAIL' : e.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'PASS', reason });
  }
  return { file: input.file, violations: stableFindings(violations), coverage, complete };
}

/** Deterministic-only audit. Complete means every bound checker ran on a parseable input. */
export function coreAudit(input: ReviewInput, snapshot: RuleSnapshot): FileAudit {
  if (isGeneratedSnapshotFile(input.file)) return { file: input.file, violations: [], coverage: [], complete: true, skipped: 'Generated snapshot excluded from review.' };
  if (input.skipped) return { file: input.file, violations: [], coverage: [], complete: true, skipped: input.skipped };
  const failedRules = new Set<string>();
  const violations = deterministicAudit(input, snapshot, failedRules);
  const parsed = isScriptFile(input.file) ? parseSource(input) : undefined;
  const invalid = !!input.error || (!!parsed && hasParseErrors(parsed));
  const coverage: Coverage[] = snapshot.rules.map(rule => {
    const failed = violations.some(v => v.ruleId === rule.id);
    const applicableChecks = hasApplicableFileChecks(input.file, rule);
    const semanticTarget = rule.category !== 'meta' && fileMatchesPattern(input.file, rule.targetFiles);
    // A fully covered rule is exactly its checks: where none of them can run, there is nothing left to verify.
    const notApplicable = hasOnlyRepositoryChecks(rule) ||
      (!semanticTarget && !applicableChecks) ||
      (fullyCovered(rule) && (!isScriptFile(input.file) || !applicableChecks));
    // Explicit check scopes can extend beyond the semantic targetFiles. Only those checks apply there.
    const checksOnly = !semanticTarget && applicableChecks && !rule.checkErrors?.length;
    const verified = !invalid && !failedRules.has(rule.id) && isScriptFile(input.file) && (fullyCovered(rule) || checksOnly);
    return { ruleId: rule.id, file: input.file,
      // A found violation is conclusive even when other clauses of the rule are still unverified.
      status: notApplicable ? 'NOT_APPLICABLE' : failed ? 'FAIL' : !verified ? 'UNVERIFIED' : 'PASS',
      reason: notApplicable ? 'Rule does not target this file.' : failed ? 'Violation found.' : invalid ? 'Input unavailable or syntax invalid; verification skipped.' :
        !verified ? 'Rule has not been fully verified.' : 'Declared checks found no violation.' };
  });
  return { file: input.file, violations, coverage, complete: snapshot.rules.length > 0 && !invalid && !failedRules.size,
    notes: input.error ? [input.error] : invalid ? [out('syntaxError')] : [] };
}

/**
 * Deterministic checks plus AI review of the remaining rule clauses. Validated AI findings count toward the
 * verdict; an AI outage keeps the deterministic findings and marks the file incomplete.
 */
export async function auditFile(input: ReviewInput, snapshot: RuleSnapshot, ai: (findings: Finding[], rules: RuleSnapshot) => Promise<string>, aiScope: AIScope = 'changed'): Promise<FileAudit> {
  const core = coreAudit(input, snapshot);
  // Generated snapshots are not authored code, so they never go to the AI.
  if (core.skipped || input.error || !snapshot.rules.length || !core.complete) return core;
  const aiRules = rulesForAI(input, snapshot);
  if (!aiRules.length) return core;
  const aiSnapshot: RuleSnapshot = { rules: aiRules, hash: snapshot.hash };
  const aiInput = aiScope === 'full' ? input : { ...input, scope: 'diff' as const };
  // Nothing was added, so in diff scope the AI could not report anything: skip the call.
  if (aiInput.scope === 'diff' && !input.addedLines.length) {
    const ids = new Set(aiRules.map(r => r.id));
    return { ...core, coverage: core.coverage.map(c => ids.has(c.ruleId) && c.status === 'UNVERIFIED'
      ? { ...c, status: 'NOT_APPLICABLE' as const, reason: 'No added lines to review.' } : c) };
  }
  let advisory: FileAudit | undefined;
  let failure: string | undefined;
  try {
    advisory = parseAICoverage(await ai(core.violations, aiSnapshot), aiInput, aiSnapshot);
    const pending = new Set(advisory.coverage.filter(c => c.status === 'UNVERIFIED').map(c => c.ruleId));
    if (pending.size) {
      // Awaited inside the same file worker: a follow-up never creates another concurrency slot.
      const remaining: RuleSnapshot = { rules: aiRules.filter(r => pending.has(r.id)), hash: snapshot.hash };
      const followup = parseAICoverage(await ai(core.violations, remaining), aiInput, remaining);
      const replacements = new Map(followup.coverage.map(c => [c.ruleId, c]));
      const coverage = advisory.coverage.map(c => replacements.get(c.ruleId) || c);
      advisory = { ...advisory, violations: stableFindings([...advisory.violations, ...followup.violations]), coverage,
        complete: coverage.every(c => c.status !== 'UNVERIFIED') };
    }
  } catch (error) {
    failure = out('aiUnavailable', { message: (error as Error).message });
  }
  // Preserve confirmed evidence if the follow-up failed; deterministic findings own their rule/line.
  const owned = new Set(core.violations.map(v => `${v.ruleId}:${v.line}`));
  const extra = advisory?.violations.filter(v => !owned.has(`${v.ruleId}:${v.line}`)) || [];
  const violations = stableFindings([...core.violations, ...extra]);
  const answers = new Map(advisory?.coverage.map(a => [a.ruleId, a]));
  const failedRules = new Set(violations.map(v => v.ruleId));
  const coverage = core.coverage.map(c => {
    const a = answers.get(c.ruleId);
    // Any confirmed violation, deterministic or AI, makes the rule FAIL even if the AI answer was unusable.
    if (failedRules.has(c.ruleId)) return c.status === 'FAIL' ? c : { ...(a || c), status: 'FAIL' as const };
    return a || c;
  });
  const complete = !failure && advisory?.complete === true && coverage.every(c => c.status !== 'UNVERIFIED');
  return { ...core, violations, coverage, complete,
    notes: complete ? core.notes : [...(core.notes || []), failure || out('aiIncomplete')] };
}

// Skip reasons are stable codes from the diff parser; the report shows them in the output language.
const SKIP_REASONS: Record<string, () => string> = { 'File deleted': () => out('skipDeleted'), 'Binary or metadata-only change': () => out('skipBinary'),
  'Generated snapshot excluded from review.': () => out('skipSnapshot') };

/**
 * `partial`: some inputs were never audited (e.g. the finding limit stopped the run). Skipped files do not block completeness.
 * Only findings on lines the change added decide the verdict; those on existing code are listed in `existingViolations`.
 */
export function summarizeAudit(audits: FileAudit[], snapshot: RuleSnapshot, repository: RepoFinding[] = [], partial = false): PRReviewResult {
  const all = stableFindings(audits.flatMap(a => a.violations));
  const violations = all.filter(v => !isExisting(v)), existingViolations = all.filter(isExisting);
  const reviewed = audits.filter(a => !a.skipped && !a.unaudited);
  const complete = !partial && !audits.some(a => a.unaudited) && audits.length > 0 && snapshot.rules.length > 0 &&
    reviewed.every(a => a.complete && a.coverage.every(c => c.status !== 'UNVERIFIED'));
  const errors = violations.filter(v => v.severity === 'error').length + repository.filter(r => r.severity === 'error').length;
  const warnings = violations.length + repository.length - errors;
  const status = errors ? 'REQUEST_CHANGES' : warnings || !complete ? 'COMMENT' : 'APPROVE';
  const filesWithFindings = new Set(violations.map(v => v.file)).size;
  const coverage = audits.flatMap(a => a.coverage).sort((a,b) => compareText(a.file,b.file) || compareText(a.ruleId,b.ruleId));
  const coverageSummary = {
    total: coverage.length,
    verified: coverage.filter(c => c.status === 'PASS' || c.status === 'FAIL').length,
    notApplicable: coverage.filter(c => c.status === 'NOT_APPLICABLE').length,
    unverified: coverage.filter(c => c.status === 'UNVERIFIED').length,
  };
  const summary = !snapshot.rules.length ? out('summaryNoRules') : out('summary', {
    reviewed: reviewed.length, errors, warnings, files: filesWithFindings,
    repo: repository.length ? out('summaryRepo', { count: repository.length }) : '',
    existing: existingViolations.length ? out('summaryExisting', { count: existingViolations.length }) : '',
    incomplete: complete ? '' : out('summaryIncomplete'),
  }) + ' ' + out('summaryCoverage', coverageSummary);
  return {
    status, summary, violations, existingViolations, generalFeedback: [], complete, ruleSnapshot: snapshot.hash,
    repository,
    skippedFiles: audits.filter(a => a.skipped).map(a => ({ file: a.file, reason: SKIP_REASONS[a.skipped!]?.() || a.skipped! })),
    notes: [
      ...snapshot.rules.flatMap(r => (r.checkErrors || []).map(e => out('invalidCheck', { title: r.title, error: e }))),
      ...audits.flatMap(a => (a.notes || []).map(n => `${a.file}: ${n}`)),
    ],
    coverage, coverageSummary, ruleTitles: Object.fromEntries(snapshot.rules.map(r => [r.id, r.title])),
  };
}
