import { z } from 'zod';

/**
 * Machine-checkable part of a rule, stored with the rule in the database (payload field `checks`).
 * The engine only knows these generic primitives; which ones apply, where, and what they report is team data.
 */

export const SYNTAX = [
  'var', 'non-null-assertion', 'type-assertion', 'empty-object-type', 'index-signature',
  'function-declaration', 'optional-parameter-before-required', 'inline-object-type-in-signature',
  'jsx', 'jsx-and-number', 'jsx-nested-ternary', 'jsx-ternary-null', 'jsx-inline-handler-wrapper',
  'runtime-logic', 'non-export-statement', 'misplaced-directive', 'non-async-server-export',
  'fallback', 'or-fallback', 'magic-number', 'magic-string',
  'block-comment', 'commented-out-code', 'todo-without-ticket', 'hook-name-without-hook-call',
] as const;

export const NAMING_TARGETS = ['identifier', 'variable', 'boolean', 'type', 'schema', 'test-title'] as const;
export const FORMAT_RULES = ['eof-newline', 'semicolon', 'curly', 'blank-line-before'] as const;

const regex = z.string().min(1).refine(s => { try { new RegExp(s); return true; } catch { return false; } }, 'invalid regular expression');
const globs = z.array(z.string().min(1)).min(1);

const base = {
  /** Stable key used in finding ids; defaults to the primitive name. */
  id: z.string().regex(/^[a-z0-9][a-z0-9:-]*$/).optional(),
  /** Files the check applies to (glob). Defaults to the rule's targetFiles, else every script file. */
  files: globs.optional(),
  exclude: globs.optional(),
  severity: z.enum(['error', 'warning']),
  /** Reported text, in the team's language. Placeholders: {name} {Name} {text} {value} {keyword} {file} {count} {lines}. */
  message: z.string().min(1),
  fix: z.string().min(1).optional(),
  /** Per-case overrides (message, fix, severity) for primitives that report several cases, keyed like `return`, `parameter`, `missing`. */
  messages: z.record(z.string(), z.string().min(1)).optional(),
  fixes: z.record(z.string(), z.string().min(1)).optional(),
  severities: z.record(z.string(), z.enum(['error', 'warning'])).optional(),
};

export const CheckSpecSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('forbid-syntax'), syntax: z.enum(SYNTAX),
    /** magic-number: literals that are allowed. todo-without-ticket: ticket regex. fallback: getter functions with a default argument. */
    allow: z.array(z.string()).optional(), ticketPattern: regex.optional(), getters: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('forbid-type'), types: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ ...base, type: z.literal('forbid-call'), names: globs, argument: regex.optional() }).strict(),
  z.object({ ...base, type: z.literal('forbid-import'), from: globs.optional(), names: globs.optional(),
    allowTypeOnly: z.boolean().optional(), allowOwnTest: z.boolean().optional() }).strict()
    .refine(s => s.from || s.names, 'forbid-import needs `from` or `names`'),
  z.object({ ...base, type: z.literal('forbid-directive'), directives: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ ...base, type: z.literal('require-directive'), directive: z.string().min(1), ifCalls: globs.optional() }).strict(),
  z.object({ ...base, type: z.literal('naming'), target: z.enum(NAMING_TARGETS),
    pattern: regex.optional(), forbidden: z.array(z.string().min(1)).optional(), forbiddenPattern: regex.optional(),
    /** boolean: hooks whose `[value, setter]` holds a boolean. schema: factory identifiers such as `z`. test-title: callees and object properties holding titles. */
    stateHooks: z.array(z.string()).optional(), factories: z.array(z.string()).optional(),
    callees: z.array(z.string()).optional(), properties: z.array(z.string()).optional(),
    ignoreLoopVariables: z.boolean().optional() }).strict()
    .refine(s => s.pattern || s.forbidden || s.forbiddenPattern, 'naming needs `pattern`, `forbidden` or `forbiddenPattern`'),
  z.object({ ...base, type: z.literal('explicit-types'), returns: z.boolean().optional(), parameters: z.boolean().optional(),
    callbacks: z.enum(['each', 'summary', 'ignore']).optional(), ignoreInsideCalls: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('require-jsdoc'), tagFormat: z.boolean().optional(), ignoreInsideCalls: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('format'), rule: z.enum(FORMAT_RULES), keywords: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('require-files'),
    /** Files that identify a unit, with `{name}` capturing its name, e.g. `{name}.view.tsx`. */
    anchors: globs,
    required: z.array(z.object({ file: z.string().min(1), if: z.string().min(1).optional() }).strict()).min(1) }).strict(),
  z.object({ ...base, type: z.literal('branch-name'), pattern: regex, allow: z.array(z.string()).optional() }).strict(),
  z.object({ ...base, type: z.literal('commit-message'), pattern: regex }).strict(),
]);

export type CheckSpec = z.infer<typeof CheckSpecSchema>;
export type CheckOf<T extends CheckSpec['type']> = Extract<CheckSpec, { type: T }>;

/** Validates a rule's `checks` payload (array, or JSON string from table stores). Invalid entries are reported, never guessed. */
export function parseChecks(raw: unknown): { checks: CheckSpec[]; errors: string[] } {
  if (raw == null || raw === '') return { checks: [], errors: [] };
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { checks: [], errors: ['checks: not valid JSON'] }; }
  }
  if (!Array.isArray(value)) return { checks: [], errors: ['checks: must be an array'] };
  const checks: CheckSpec[] = [], errors: string[] = [];
  value.forEach((item, i) => {
    const parsed = CheckSpecSchema.safeParse(item);
    if (parsed.success) checks.push(parsed.data);
    else errors.push(`checks[${i}]: ${parsed.error.issues.map(e => `${e.path.join('.') || 'type'} ${e.message}`).join('; ')}`);
  });
  return { checks, errors };
}

/** Fills `{placeholder}` values; unknown placeholders are left as written. */
export function fill(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (all, key) => values[key] === undefined ? all : String(values[key]));
}
