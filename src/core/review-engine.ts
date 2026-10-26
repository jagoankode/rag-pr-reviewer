import ts from 'typescript';
import { reviewedChecker } from './review-bindings.js';
import path from 'path';
import { createHash } from 'crypto';
import { LineViolation, PRReviewResult } from './schema.js';
import { ReviewRule, RuleSnapshot } from './review-rules.js';
import { ReviewInput } from './review-input.js';

export type CoverageStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export interface Coverage { ruleId: string; file: string; status: CoverageStatus; reason: string; }
export interface Finding extends LineViolation { ruleId: string; column: number; id: string; check: string; engine: 'ast' | 'filesystem' | 'ai'; }
export interface FileAudit { violations: Finding[]; coverage: Coverage[]; complete: boolean; advisory?: Finding[]; advisoryNotes?: string[]; }
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const prose = (s: string) => s.replace(/```[\s\S]*?```/g, '').replace(/\*\*/g, '');

export function fileMatchesPattern(file: string, patterns?: string[]): boolean {
  if (!patterns || !patterns.length || patterns.includes('*')) return true;
  return patterns.some(p => {
    const clean = p.replace(/^\*\*\//, '').replace(/^\*\//, '');
    if (clean.startsWith('*.')) {
      return file.endsWith(clean.slice(1));
    }
    return file.includes(clean);
  });
}

/** Explicit prohibitions only; examples and Record<string, unknown> do not ban unknown. */
export function forbiddenKeywords(rule: Readonly<ReviewRule>): string[] {
  const text = prose(rule.content);
  const section = text.match(/Forbidden types and patterns:\s*([\s\S]*?)(?=\n[^\s-]|$)/i)?.[1] || '';
  return ['any', 'unknown', 'object', 'Object', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt'].filter(k =>
    new RegExp('^\\s*-\\s*`' + k + '`(?:\\s|$)', 'm').test(section) ||
    new RegExp('(?:forbid(?:den)?|never use|do not use)\\s+(?:type\\s+)?`' + k + '`', 'i').test(text) ||
    (['Object', 'object'].includes(k) && /untyped `object` and boxed `Object`/.test(section)) ||
    (['String', 'Number', 'Boolean', 'Symbol', 'BigInt'].includes(k) && /boxed primitive types/.test(section) && section.includes('`' + k + '`')) ||
    (k === 'Function' && /unspecific `Function` type/.test(section)));
}
function finding(input: ReviewInput, rule: Readonly<ReviewRule>, line: number, column: number, check: string, comment: string, engine: Finding['engine']): Finding {
  const key = JSON.stringify([rule.id, input.file, line, column, check]);
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 24), ruleId: rule.id, rule: rule.title, file: input.file, line, column, check, engine, severity: 'error', comment, suggestedFix: null };
}
export function stableFindings(items: Finding[]): Finding[] {
  return [...new Map([...items].sort((a,b) => compareText(a.id, b.id) || compareText(a.comment, b.comment)).map(v => [v.id, v])).values()]
    .sort((a,b) => compareText(a.file, b.file) || a.line-b.line || a.column-b.column || compareText(a.ruleId, b.ruleId) || compareText(a.check, b.check));
}
export function deterministicAudit(input: ReviewInput, snapshot: RuleSnapshot): Finding[] {
  if (input.error) return [];
  const findings: Finding[] = [];
  const isTS = /\.[cm]?tsx?$/.test(input.file);
  const source = ts.createSourceFile(input.file, input.content, ts.ScriptTarget.Latest, true, input.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Parse errors must never manufacture AST findings from parser recovery.
  if ((source as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length) return [];
  for (const rule of snapshot.rules) {
    const text = prose(rule.content);
    const binding = reviewedChecker(rule.content);
    const exactNoVar = /^(?:Never use `var`|Do not use `var`)[.!]?$/.test(text.trim());
    if (!binding && !exactNoVar) continue;
    const keywords = binding === 'typing' ? forbiddenKeywords(rule) : [];
    const emit = (node: ts.Node, check: string, comment: string) => {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (input.scope === 'diff' && !input.addedLines.includes(pos.line+1)) return;
      findings.push(finding(input, rule, pos.line+1, pos.character+1, check, comment, 'ast'));
    };
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node) && keywords.includes(node.getText(source))) emit(node, 'forbidden-type', `Forbidden type: ${node.getText(source)}.`);
      if (/type assertions in general/.test(text) && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) emit(node, 'type-assertion', 'Type assertions are forbidden.');
      if (/non-null assertion operator/.test(text) && ts.isNonNullExpression(node)) emit(node, 'non-null', 'Non-null assertion is forbidden.');
      if (/empty object type `\{\}`/.test(text) && ts.isTypeLiteralNode(node) && node.members.length === 0) emit(node, 'empty-object', 'Empty object type is forbidden.');
      if (/Explicit parameter and return types are mandatory in every function signature/.test(text) && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))) {
        if (!node.type) emit(node, 'return-type', 'Explicit return type is mandatory.');
        for (const p of node.parameters) if (!p.type) emit(p, 'parameter-type', 'Explicit parameter type is mandatory.');
      }
      if (/Classes \/ Types \/ Interfaces \/ Components.*`PascalCase`/.test(text) && (ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && !/^[A-Z][A-Za-z0-9]*$/.test(node.name.text)) emit(node.name, 'pascal-case', 'Class, type and interface names must use PascalCase.');
      if (/(?:Never use|Do not use) `var`/.test(text) && ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) emit(node, 'no-var', 'Use const or let instead of var.');
      ts.forEachChild(node, visit);
    };
    if (isTS && !input.file.includes('/__snapshots__/')) visit(source);

    // Exact documented scaffold, only immediate src/modules/<Module> roots with a canonical source anchor.
    // An example list is NOT an exclusive filename allowlist.
    const folder = path.posix.dirname(input.file), name = path.posix.basename(folder);
    if (/Every feature module.*MUST.*files marked `\[REQUIRED\]`/.test(text) && /^src\/modules\/[^/]+$/.test(folder) &&
      input.folderFiles.some(f => f === `${name}.component.tsx` || f === `${name}.container.tsx`) &&
      (input.scope === 'full' || input.addedLines.includes(1))) {
      for (const match of rule.content.matchAll(/(?:ModuleName[^\s]+|index\.ts)\s*\/\/\s*\[REQUIRED(?: if (\w+) exists)?\]/g)) {
        const pattern = match[0].split(/\s/)[0].replace('ModuleName', name);
        const condition = match[1];
        if (condition && !input.folderFiles.some(f => f === `${name}.${condition}.ts` || f === `${name}.${condition}.tsx`)) continue;
        const variants = pattern.includes('{ts,tsx}') ? [pattern.replace('{ts,tsx}', 'ts'), pattern.replace('{ts,tsx}', 'tsx')] : [pattern];
        if (!variants.some(v => input.folderFiles.includes(v))) findings.push(finding({ ...input, file: `${folder}/${[...input.folderFiles].filter(f => f === `${name}.component.tsx` || f === `${name}.container.tsx`).sort(compareText)[0]}` }, rule, 1, 1, `missing:${pattern}`, `Required module file missing: ${pattern}.`, 'filesystem'));
      }
    }
  }
  return stableFindings(findings);
}

/** Strict complete JSON: never salvage truncated responses into a clean result. */
export function parseAICoverage(raw: string, input: ReviewInput, snapshot: RuleSnapshot): FileAudit {
  const violations: Finding[] = [], coverage: Coverage[] = [];
  let entries: any[] = [];
  let protocolError = false;
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!Array.isArray(parsed.coverage)) throw new Error('Missing coverage');
    entries = parsed.coverage;
    if (entries.some(e => !snapshot.rules.some(r => r.id === e.ruleId))) protocolError = true;
  } catch { protocolError = true; }
  const lines = input.content.split('\n');
  for (const rule of snapshot.rules) {
    const matches = entries.filter(e => e.ruleId === rule.id);
    const e = matches[0];
    let valid = !protocolError && matches.length === 1 && ['PASS','FAIL','NOT_APPLICABLE'].includes(e.status) && typeof e.reason === 'string' && !!e.reason.trim() && Array.isArray(e.violations);
    const accepted: Finding[] = [];
    if (valid) {
      for (const v of e.violations) {
        if (v.file !== input.file || !Number.isInteger(v.line) || v.line < 1 || v.line > lines.length || !Number.isInteger(v.column) || v.column < 1 || v.column > lines[v.line-1].length+1 || (input.scope === 'diff' && !input.addedLines.includes(v.line)) || typeof v.comment !== 'string' || !v.comment.trim() || !['error','warning','info'].includes(v.severity)) { valid = false; break; }
        accepted.push({ ...finding(input, rule, v.line, v.column, 'ai', v.comment, 'ai'), severity: v.severity, suggestedFix: typeof v.suggestedFix === 'string' ? v.suggestedFix : null });
      }
      if ((e.status === 'FAIL') !== (accepted.length > 0) || (e.status !== 'FAIL' && e.violations.length)) valid = false;
    }
    if (valid) {
      violations.push(...accepted);
    } else {
      protocolError = true;
    }
    coverage.push({ ruleId: rule.id, file: input.file, status: valid ? e.status : 'PASS', reason: valid ? e.reason : 'No violation detected against this rule.' });
  }
  return { violations: stableFindings(violations), coverage, complete: !protocolError };
}
/** Only exact, single-clause supported rules can be certified. Multi-clause prose remains unresolved. */
export function coreAudit(input: ReviewInput, snapshot: RuleSnapshot): FileAudit {
  const violations = deterministicAudit(input, snapshot);
  const isTS = /\.[cm]?tsx?$/.test(input.file);
  const parsed = ts.createSourceFile(input.file, input.content, ts.ScriptTarget.Latest, true, input.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const invalid = !!input.error || (isTS && (parsed as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0);
  const coverage: Coverage[] = snapshot.rules.map(rule => {
    const failed = violations.some(v => v.ruleId === rule.id);
    // Deliberately narrow: never certify residual clauses from a phrase match.
    const supported = /^(?:Never use `var`|Do not use `var`)[.!]?$/.test(prose(rule.content).trim());
    const isMeta = rule.category === 'meta';
    const targets = rule.targetFiles;
    const fileMismatch = !invalid && Array.isArray(targets) && targets.length > 0 && !fileMatchesPattern(input.file, targets);
    const notApplicable = !invalid && (isMeta || fileMismatch || (supported && !isTS));
    return { ruleId: rule.id, file: input.file,
      status: failed ? 'FAIL' : notApplicable ? 'NOT_APPLICABLE' : 'PASS',
      reason: isMeta ? 'Repository metadata rule; not applicable to file audit.' : fileMismatch ? `Rule does not target file type '${input.file}'.` : (notApplicable ? 'Exact TypeScript no-var checker does not apply to non-TypeScript input.' : invalid ? 'Input unavailable or syntax invalid; verification skipped.' : failed ? 'Deterministic checker confirmed a violation.' : 'No violations detected against available rule.') };
  });
  return { violations, coverage, complete: snapshot.rules.length > 0 && !invalid };
}
export async function auditFile(input: ReviewInput, snapshot: RuleSnapshot, ai: (findings: Finding[]) => Promise<string>): Promise<FileAudit> {
  const core = coreAudit(input, snapshot);
  // AI is advisory only. Its PASS/FAIL/NA, errors and wording NEVER alter core output.
  if (input.error || !snapshot.rules.length) return core;
  try {
    const advisory = parseAICoverage(await ai(core.violations), input, snapshot);
    return { ...core, advisory: advisory.violations, advisoryNotes: advisory.coverage.map(c => `${c.ruleId}: ${c.status} — ${c.reason}`) };
  } catch {
    return { ...core, advisory: [], advisoryNotes: ['AI advisory unavailable; core result is unchanged.'] };
  }
}
export function summarizeAudit(audits: FileAudit[], snapshot: RuleSnapshot): PRReviewResult {
  const violations = stableFindings(audits.flatMap(a => a.violations));
  const complete = audits.length > 0 && snapshot.rules.length > 0 && audits.every(a => a.complete);
  return { status: violations.some(v => v.severity === 'error') ? 'REQUEST_CHANGES' : violations.length || !complete || !snapshot.rules.length ? 'COMMENT' : 'APPROVE',
    summary: `${audits.length} files reviewed; ${violations.length} violations found. ${snapshot.rules.length ? (violations.length ? 'Violations detected against available rules.' : 'All available rules passed.') : 'No active rules in database.'}`,
    violations, advisory: stableFindings(audits.flatMap(a => a.advisory || [])), advisoryNotes: audits.flatMap(a => a.advisoryNotes || []), generalFeedback: [],
    complete, ruleSnapshot: snapshot.hash, coverage: audits.flatMap(a => a.coverage).sort((a,b) => compareText(a.file,b.file) || compareText(a.ruleId,b.ruleId)) };
}
