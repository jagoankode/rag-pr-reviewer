import ts from 'typescript';
import { ReviewInput } from '../review-input.js';
import { ReviewRule, RuleSnapshot } from '../review-rules.js';
import { CheckContext, Primitive, RawFinding, Severity } from './types.js';
import { CheckOf, CheckSpec, fill } from './spec.js';
import { logError } from '../logger.js';
import { isScriptFile, isTsFile } from './ast.js';
import { matchAny } from './glob.js';
import { forbidSyntax } from './syntax.js';
import { forbidCall, forbidDirective, forbidImport, requireDirective } from './calls.js';
import { naming } from './naming.js';
import { explicitTypes, forbidType, requireJsdoc } from './typing.js';
import { format } from './formatting.js';
import { requireFiles } from './files.js';

export { isScriptFile } from './ast.js';
export type { Severity } from './types.js';

type FileCheck = Exclude<CheckSpec['type'], 'branch-name' | 'commit-message'>;

/** Generic primitives; every team-specific detail arrives through the rule's `checks` payload. */
const PRIMITIVES: { [T in FileCheck]: Primitive<CheckOf<T>> } = {
  'forbid-syntax': forbidSyntax, 'forbid-type': forbidType, 'forbid-call': forbidCall, 'forbid-import': forbidImport,
  'forbid-directive': forbidDirective, 'require-directive': requireDirective, naming, 'explicit-types': explicitTypes,
  'require-jsdoc': requireJsdoc, format, 'require-files': requireFiles,
};

const isFileCheck = (spec: CheckSpec): spec is CheckOf<FileCheck> => spec.type in PRIMITIVES;

export const hasChecks = (rule: Readonly<ReviewRule>): boolean => !!rule.checks?.length;

/** The rule's checks enforce all of it, so the AI prompt can skip it. */
export const fullyCovered = (rule: Readonly<ReviewRule>): boolean => hasChecks(rule) && rule.checksComplete === true;

export interface CheckHit {
  rule: Readonly<ReviewRule>;
  line: number;
  column: number;
  check: string;
  severity: Severity;
  comment: string;
  suggestedFix: string | null;
  engine: 'ast' | 'filesystem';
}

export function parseSource(input: ReviewInput): ts.SourceFile {
  return ts.createSourceFile(input.file, input.content, ts.ScriptTarget.Latest, true, /x$/.test(input.file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(input.file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

export const hasParseErrors = (source: ts.SourceFile): boolean => (source as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0;

/** A check applies to its own `files`, else to the rule's targetFiles, else to every script file. */
const applies = (file: string, spec: CheckSpec, rule: Readonly<ReviewRule>): boolean => {
  const files = spec.files || rule.targetFiles;
  return (!files?.length || matchAny(file, files)) && !matchAny(file, spec.exclude);
};

/** Runs every rule's file checks against one file. Parse errors never manufacture findings. */
export function runChecks(input: ReviewInput, snapshot: RuleSnapshot): CheckHit[] {
  if (input.error || !isScriptFile(input.file) || input.file.includes('/__snapshots__/')) return [];
  const source = parseSource(input);
  if (hasParseErrors(source)) return [];
  const lines = input.content.split('\n');
  const hits: CheckHit[] = [];
  for (const rule of snapshot.rules) {
    for (const spec of rule.checks || []) {
      if (!isFileCheck(spec) || !applies(input.file, spec, rule)) continue;
      const ctx: CheckContext = { input, spec, source, lines, isTS: isTsFile(input.file), isJsx: /x$/.test(input.file) };
      let raws: RawFinding[];
      try {
        raws = (PRIMITIVES[spec.type] as Primitive)(ctx);
      } catch (error) {
        // One faulty check must not abort the whole review.
        logError(`Check:${spec.type}`, error, { file: input.file, rule: rule.id });
        continue;
      }
      for (const raw of raws) {
        const pos = raw.node ? source.getLineAndCharacterOfPosition(raw.node.getStart(source)) : undefined;
        const line = pos ? pos.line + 1 : raw.line || 1;
        const column = pos ? pos.character + 1 : raw.column || 1;
        // Diff scope only reports added lines; file-level findings sit on line 1 and follow the same rule.
        if (input.scope === 'diff' && !input.addedLines.includes(line)) continue;
        const caseKey = raw.key?.split(':')[0];
        const values = { file: input.file, ...raw.values };
        const message = (caseKey && spec.messages?.[caseKey]) || spec.message;
        const fix = (caseKey && spec.fixes?.[caseKey]) || spec.fix;
        hits.push({ rule, line, column, check: [spec.id || spec.type, raw.key].filter(Boolean).join(':'), severity: (caseKey && spec.severities?.[caseKey]) || spec.severity,
          comment: fill(message, values), suggestedFix: fix ? fill(fix, values) : null, engine: spec.type === 'require-files' ? 'filesystem' : 'ast' });
      }
    }
  }
  return hits;
}
