import { FORMAT_RULES, NAMING_TARGETS, SYNTAX } from './spec.js';

/**
 * What each primitive does, for the model that drafts `checks` from a rule's prose (`lumio rules compile`).
 * The schema in spec.ts stays the source of truth: every draft is validated against it before anyone sees it.
 */
export const PRIMITIVE_CATALOG = `
Common fields of every check:
- type (required), id (optional, lowercase kebab-case, stable), severity "error" | "warning" (required), message (required).
- files / exclude: glob lists. A pattern without "/" matches the file name (e.g. "*.view.tsx"); with "/" it matches the path
  from the repository root (e.g. "src/features/**"). Supports *, ?, **, {a,b}. When files is omitted the rule's targetFiles apply.
- fix: suggested fix text. messages / fixes / severities: per-case overrides keyed by the case names listed below.
- Placeholders usable in message/fix: {name} {Name} {text} {value} {file} {count} {lines} (unknown ones are kept as written).

Primitives:
- forbid-syntax { syntax, allow?, ticketPattern?, getters? } — reports a construct. syntax is one of:
  ${SYNTAX.join(', ')}.
  Notes: magic-number skips literals listed in allow and literals inside UPPER_SNAKE constants; magic-string reports string
  literals compared with ==/===; todo-without-ticket reports TODO/FIXME without "(<ticketPattern>)"; fallback reports "??",
  "x || <literal>" and getter calls (names in getters) with a default argument; or-fallback reports "x || <literal>";
  hook-name-without-hook-call reports use* functions that call no use* function ({plain} = suggested plain name);
  runtime-logic reports functions, classes, expressions and JSX at the top level; non-export-statement reports anything that
  is not import/export; jsx reports JSX or createElement; misplaced-directive reports a directive that is not in the prologue.
- forbid-type { types } — type annotations whose text equals one of types (e.g. "any", "{}", "Record<string, unknown>").
- forbid-call { names, argument? } — calls whose callee matches a glob in names ("fetch", "use*", "console.*"); argument is a
  regex on the first literal argument.
- forbid-import { from?, names?, allowTypeOnly?, allowOwnTest? } — imports from modules matching from, or named imports
  matching names. Type-only imports are allowed unless allowTypeOnly is false. allowOwnTest lets "x.test.ts" import from "./x".
- forbid-directive { directives } / require-directive { directive, ifCalls? } — file directives such as "use client";
  require-directive only fires when the file calls something matching ifCalls (when given).
- naming { target, pattern?, forbidden?, forbiddenPattern?, stateHooks?, factories?, callees?, properties?, ignoreLoopVariables? }
  — target is one of ${NAMING_TARGETS.join(', ')}. A name fails when it does not match pattern, is listed in forbidden, or
  matches forbiddenPattern. boolean: variables initialised with true/false or typed boolean, plus the first element of
  "const [x, setX] = <stateHook>(false)". schema: variables initialised by a call chain rooted at one of factories.
  test-title: first string argument of callees, and string values of properties.
- explicit-types { returns?, parameters?, callbacks?: "each" | "summary" | "ignore", ignoreInsideCalls? } — missing return or
  parameter annotations. Cases: return, parameter, callbacks (one summary per file with {count} and {lines}).
- require-jsdoc { tagFormat?, ignoreInsideCalls? } — named functions without a JSDoc block. With tagFormat it also checks
  "@param {Type} name - Description" / "@returns {Type} - Description" and [name] for optional parameters.
  Cases: missing, return-tag, inline-type, format, optional.
- format { rule, keywords? } — rule is one of ${FORMAT_RULES.join(', ')}. blank-line-before uses keywords (return, if, switch,
  for, while, do, try, throw, break, continue) and skips the first statement of a block. eof-newline cases: missing, extra.
- require-files { anchors, required: [{ file, if? }] } — in the folder of a changed file, every unit named by an anchor
  ("{name}.view.tsx") must have each required sibling ("{name}.view.test.{ts,tsx}"); if makes it conditional on another
  sibling existing. Cases: missing.
- branch-name { pattern, allow? } — the branch under review must match pattern unless it matches a glob in allow.
  Placeholder {slug} = branch name in kebab-case.
- commit-message { pattern } — every commit subject on the branch must match pattern.
`.trim();
