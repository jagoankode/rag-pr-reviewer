import ts from 'typescript';
import { CheckContext, Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { FunctionLike, isFunctionLike, isInlineCallback, isInsideCall, functionName, namedOwner, walk } from './ast.js';

const normalizeType = (text: string): string => text.replace(/\s+/g, ' ').replace(/\s*([<>,|&])\s*/g, '$1').replace(/,/g, ', ');

/** Types listed by the rule, compared on normalized text: `any`, `{}`, `Record<string, unknown>`. */
export const forbidType: Primitive<CheckOf<'forbid-type'>> = ({ source, spec }) => {
  const banned = new Set(spec.types.map(normalizeType));
  const out: RawFinding[] = [];
  const reported = new Set<ts.Node>();
  walk(source, node => {
    if (!ts.isTypeNode(node)) return;
    // Report the outermost banned type only: `Record<string, unknown>` once, not also its `unknown`.
    for (let p = node.parent; p; p = p.parent) if (reported.has(p)) return;
    // The `unknown` bridge in `x as unknown as T` belongs to the assertion, not to a declared type.
    if (ts.isAsExpression(node.parent) && ts.isAsExpression(node.parent.parent) && node.parent.parent.expression === node.parent) return;
    const text = normalizeType(node.getText(source));
    if (banned.has(text)) {
      reported.add(node);
      out.push({ node, values: { text, name: text } });
    }
  });
  return out;
};

const skip = (node: ts.Node, ignore: string[] | undefined): boolean => !!ignore && ignore.some(name => isInsideCall(node, name));

/** Keys: `return`, `parameter`, `callbacks` (summary of untyped inline callbacks). */
export const explicitTypes: Primitive<CheckOf<'explicit-types'>> = ({ source, spec, input }) => {
  const out: RawFinding[] = [];
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const inScope = (n: ts.Node) => input.scope !== 'diff' || input.addedLines.includes(lineOf(n));
  const returns = spec.returns !== false, parameters = spec.parameters !== false, callbacks = spec.callbacks || 'each';
  const untyped: ts.Node[] = [];
  walk(source, node => {
    if (!isFunctionLike(node) || skip(node, spec.ignoreInsideCalls)) return;
    if (isInlineCallback(node) && callbacks !== 'each') {
      // Inline callbacks are contextually typed and very common, so they can be summarized once per file.
      const missing = (returns && !node.type) || (parameters && node.parameters.some(p => !p.type));
      if (callbacks === 'summary' && missing && inScope(node)) untyped.push(node);
      return;
    }
    const name = functionName(node) || 'anonymous';
    if (returns && !node.type) out.push({ node: ts.isFunctionDeclaration(node) && node.name ? node.name : node, key: 'return', values: { name, text: name } });
    if (parameters) for (const p of node.parameters) if (!p.type) out.push({ node: p, key: 'parameter', values: { name: p.name.getText(source), text: p.name.getText(source) } });
  });
  if (untyped.length) {
    const lines = [...new Set(untyped.map(lineOf))];
    const listed = lines.slice(0, 15).join(', ') + (lines.length > 15 ? `, … (+${lines.length - 15})` : '');
    out.push({ node: untyped[0], key: 'callbacks', values: { count: untyped.length, lines: listed, text: `${untyped.length}` } });
  }
  return out;
};

function jsDocOf(fn: FunctionLike): ts.JSDoc[] {
  const owner = namedOwner(fn);
  const host: ts.Node = owner ? owner.parent.parent : fn; // VariableDeclaration → List → Statement
  return ((host as ts.Node & { jsDoc?: ts.JSDoc[] }).jsDoc || []);
}

/**
 * Tag layout `@param {Type} name - Description` / `@returns {Type} - Description`, `[name]` for optional parameters.
 * Keys: `return-tag`, `inline-type`, `format`, `optional`.
 */
function tagProblems(ctx: CheckContext, node: FunctionLike, doc: ts.JSDoc): RawFinding[] {
  const out: RawFinding[] = [];
  const { source } = ctx;
  const startLine = source.getLineAndCharacterOfPosition(doc.getStart(source)).line;
  const optionalNames = new Set(node.parameters.filter(p => p.questionToken || p.initializer).map(p => p.name.getText(source)));
  doc.getText(source).split('\n').forEach((raw, offset) => {
    const text = raw.replace(/^\s*\/?\*+\s?/, '');
    const at = (key: string, name: string | undefined) => out.push({ line: startLine + offset + 1, column: raw.indexOf('@') + 1 || 1, key, values: { name, text: text.trim().slice(0, 60) } });
    if (/^@return\b(?!s)/.test(text)) at('return-tag', functionName(node));
    if (/^@(param|returns)\s*\{\{/.test(text)) at('inline-type', functionName(node));
    const param = text.match(/^@param\s+(\{.*\})?\s*(\[?[\w$.]+(?:=[^\]]*)?\]?)?\s*(-)?/);
    if (param) {
      if (!param[1] || !param[2] || !param[3]) at('format', functionName(node));
      const bare = param[2]?.replace(/^\[|\]$/g, '').replace(/=.*$/, '');
      if (bare && optionalNames.has(bare) && !param[2].startsWith('[')) at('optional', bare);
    }
    if (/^@returns\b/.test(text) && !/^@returns\s+\{.+\}\s+-\s+\S/.test(text)) at('format', functionName(node));
  });
  return out;
}

/** Keys: `missing`, plus the tag keys when `tagFormat` is on. */
export const requireJsdoc: Primitive<CheckOf<'require-jsdoc'>> = ctx => {
  const out: RawFinding[] = [];
  walk(ctx.source, node => {
    if (!isFunctionLike(node) || isInlineCallback(node) || skip(node, ctx.spec.ignoreInsideCalls)) return;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !namedOwner(node)) return;
    const name = functionName(node);
    if (!name) return;
    const docs = jsDocOf(node);
    const anchor = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.name || node : namedOwner(node)!.name;
    if (!docs.length) out.push({ node: anchor, key: 'missing', values: { name, text: name } });
    else if (ctx.spec.tagFormat) out.push(...tagProblems(ctx, node, docs[docs.length - 1]));
  });
  return out;
};
