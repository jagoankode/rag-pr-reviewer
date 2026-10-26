import ts from 'typescript';
import path from 'path';
import { Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { directives, literalText, walk } from './ast.js';
import { matchAny } from './glob.js';

/** Full callee text: `useState`, `React.useState`, `window.fetch`, `jest.mock`. */
function calleeText(call: ts.CallExpression, source: ts.SourceFile): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && (ts.isIdentifier(callee.expression) || ts.isPropertyAccessExpression(callee.expression))) return callee.getText(source).replace(/\s+/g, '');
  return undefined;
}

const firstCall = (source: ts.SourceFile, names: readonly string[]): ts.CallExpression | undefined => {
  let found: ts.CallExpression | undefined;
  walk(source, n => {
    if (!found && ts.isCallExpression(n)) {
      const name = calleeText(n, source);
      if (name && matchAny(name, names)) found = n;
    }
  });
  return found;
};

export const forbidCall: Primitive<CheckOf<'forbid-call'>> = ({ source, spec }) => {
  const out: RawFinding[] = [];
  const argument = spec.argument ? new RegExp(spec.argument) : undefined;
  walk(source, n => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeText(n, source);
    if (!name || !matchAny(name, spec.names)) return;
    const arg = n.arguments[0] && literalText(n.arguments[0]);
    if (argument && !(arg !== undefined && argument.test(arg))) return;
    out.push({ node: n, values: { name, value: arg, text: n.getText(source).replace(/\s+/g, ' ').slice(0, 60) } });
  });
  return out;
};

export const forbidImport: Primitive<CheckOf<'forbid-import'>> = ({ source, spec, input }) => {
  const out: RawFinding[] = [];
  // A test may import private members of the file it tests: `X.util.test.ts` → `./X.util`.
  const ownSource = path.posix.basename(input.file).replace(/(\.snap)?\.(test|spec)\.[cm]?[jt]sx?$/, '');
  const isTest = ownSource !== path.posix.basename(input.file);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = literalText(statement.moduleSpecifier) || '';
    if (spec.from && !matchAny(from, spec.from)) continue;
    if (spec.allowTypeOnly !== false && statement.importClause?.isTypeOnly) continue;
    if (!spec.names) {
      out.push({ node: statement, values: { value: from, text: from } });
      continue;
    }
    if (spec.allowOwnTest && isTest && path.posix.basename(from).replace(/\.[cm]?[jt]sx?$/, '') === ownSource) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const name = (element.propertyName || element.name).text;
      if (matchAny(name, spec.names) && !(spec.allowTypeOnly !== false && element.isTypeOnly)) out.push({ node: element, values: { name, value: from, text: name } });
    }
  }
  return out;
};

export const forbidDirective: Primitive<CheckOf<'forbid-directive'>> = ({ source, spec }) =>
  directives(source).filter(d => spec.directives.includes(d.text)).map(d => ({ node: d.statement, values: { value: d.text, text: d.text } }));

export const requireDirective: Primitive<CheckOf<'require-directive'>> = ({ source, spec }) => {
  if (directives(source).some(d => d.text === spec.directive)) return [];
  const trigger = spec.ifCalls ? firstCall(source, spec.ifCalls) : undefined;
  if (spec.ifCalls && !trigger) return [];
  return [{ line: 1, column: 1, values: { value: spec.directive, text: trigger ? trigger.getText(source).replace(/\s+/g, ' ').slice(0, 40) : spec.directive } }];
};
