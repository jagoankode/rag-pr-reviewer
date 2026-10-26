import ts from 'typescript';

export const isTsFile = (file: string): boolean => /\.[cm]?tsx?$/.test(file) && !file.endsWith('.d.ts');
export const isScriptFile = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts');

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

export const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
};

/** Name of a called function: `useState(...)` → useState, `React.useState(...)` → useState. */
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

export const isHookName = (name: string | undefined): boolean => !!name && /^use(?:[A-Z0-9]|$)/.test(name);

/** Hook calls are bare `useX()` or `React.useX()`, never `obj.useX()` on arbitrary objects. */
export function isHookCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return isHookName(callee.text);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React' && isHookName(callee.name.text);
}

export type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;
export const isFunctionLike = (node: ts.Node): node is FunctionLike =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);

/** Name a function is known by: declaration name, or the variable/property it is assigned to. */
export function functionName(fn: FunctionLike): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const owner = namedOwner(fn);
  return owner && ts.isIdentifier(owner.name) ? owner.name.text : undefined;
}

/**
 * Variable declaration that names this function, either directly
 * (`const f = () => {}`) or through a wrapper hook (`const f = useCallback(() => {}, [])`).
 */
export function namedOwner(fn: ts.Node): ts.VariableDeclaration | undefined {
  let parent = fn.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer && unwrap(parent.initializer) === fn) return parent;
  if (parent && ts.isCallExpression(parent) && parent.arguments[0] === fn && ['useCallback', 'memo', 'forwardRef'].includes(calleeName(parent) || '')) {
    const declaration = parent.parent;
    if (declaration && ts.isVariableDeclaration(declaration)) return declaration;
  }
  return undefined;
}

/** True when the function is an anonymous callback passed inline as an argument or JSX prop. */
export function isInlineCallback(fn: FunctionLike): boolean {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return false;
  if (namedOwner(fn)) return false;
  let parent = fn.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return !!parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isJsxExpression(parent) || ts.isArrowFunction(parent) || ts.isPropertyAssignment(parent) || ts.isReturnStatement(parent) || ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent) || ts.isArrayLiteralExpression(parent));
}

export function isInsideCall(node: ts.Node, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && calleeName(p) === name) return true;
  return false;
}

export function hasAncestor(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  for (let p = node.parent; p; p = p.parent) if (test(p)) return true;
  return false;
}

/** Top-level `'use …'` directives such as 'use client' or 'use strict', with their statement index. */
export function directives(source: ts.SourceFile): { text: string; statement: ts.Statement; index: number }[] {
  return source.statements
    .map((statement, index) => ({ statement, index }))
    .filter(({ statement }) => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression) && /^use [a-z][a-z -]*$/.test(statement.expression.text))
    .map(({ statement, index }) => ({ text: ((statement as ts.ExpressionStatement).expression as ts.StringLiteral).text, statement, index }));
}

export const containsJsx = (node: ts.Node): boolean => {
  let found = false;
  walk(node, n => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true; });
  return found;
};

export const isCamelCase = (name: string): boolean => /^_?[a-z][a-zA-Z0-9]*$/.test(name);
export const isPascalCase = (name: string): boolean => /^_?[A-Z][a-zA-Z0-9]*$/.test(name) && /[a-z]/.test(name);
export const isUpperSnake = (name: string): boolean => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name);

export const literalText = (node: ts.Node): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

export function isFallbackLiteral(node: ts.Expression): boolean {
  const n = unwrap(node);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || ts.isNumericLiteral(n) ||
    ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n) || n.kind === ts.SyntaxKind.NullKeyword ||
    n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(n) && ts.isNumericLiteral(n.operand));
}
