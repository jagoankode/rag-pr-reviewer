import ts from 'typescript';
import { Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { calleeName, literalText, unwrap, walk } from './ast.js';

/** Root identifier of a call chain: `z.object({}).default({})` → z. */
function chainRoot(expr: ts.Expression): string | undefined {
  let current = unwrap(expr);
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

const isBooleanInit = (node: ts.Expression | undefined): boolean =>
  !!node && (unwrap(node).kind === ts.SyntaxKind.TrueKeyword || unwrap(node).kind === ts.SyntaxKind.FalseKeyword);

const isLoopVariable = (node: ts.VariableDeclaration): boolean => {
  const owner = node.parent.parent;
  return ts.isForStatement(owner) || ts.isForOfStatement(owner) || ts.isForInStatement(owner);
};

/** Names the target refers to, with the node to report on. */
function candidates(source: ts.SourceFile, spec: CheckOf<'naming'>): [ts.Node, string][] {
  const out: [ts.Node, string][] = [];
  walk(source, node => {
    switch (spec.target) {
      case 'identifier':
        if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
          if (!(spec.ignoreLoopVariables && ts.isVariableDeclaration(node) && isLoopVariable(node))) out.push([node.name, node.name.text]);
        }
        break;
      case 'variable':
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !(spec.ignoreLoopVariables && isLoopVariable(node))) out.push([node.name, node.name.text]);
        break;
      case 'boolean':
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && (isBooleanInit(node.initializer) || node.type?.kind === ts.SyntaxKind.BooleanKeyword)) out.push([node.name, node.name.text]);
        // `const [loading, setLoading] = useState(false)` declares a boolean state value.
        if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(unwrap(node.initializer))) {
          const call = unwrap(node.initializer) as ts.CallExpression;
          const first = node.name.elements[0];
          const typed = call.typeArguments?.[0]?.kind === ts.SyntaxKind.BooleanKeyword;
          if ((spec.stateHooks || []).includes(calleeName(call) || '') && (isBooleanInit(call.arguments[0]) || typed) && first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
            out.push([first.name, first.name.text]);
          }
        }
        break;
      case 'type':
        if ((ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) out.push([node.name, node.name.text]);
        break;
      case 'schema':
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(unwrap(node.initializer)) && (spec.factories || []).includes(chainRoot(node.initializer) || '')) {
          out.push([node.name, node.name.text]);
        }
        break;
      case 'test-title':
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (spec.callees || []).includes(node.expression.text) && node.arguments[0]) {
          const text = literalText(node.arguments[0]);
          if (text !== undefined) out.push([node.arguments[0], text]);
        }
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && (spec.properties || []).includes(node.name.text)) {
          const text = literalText(node.initializer);
          if (text !== undefined) out.push([node.initializer, text]);
        }
        break;
    }
  });
  return out;
}

export const naming: Primitive<CheckOf<'naming'>> = ({ source, spec }) => {
  const pattern = spec.pattern ? new RegExp(spec.pattern) : undefined;
  const forbiddenPattern = spec.forbiddenPattern ? new RegExp(spec.forbiddenPattern) : undefined;
  const out: RawFinding[] = [];
  for (const [node, name] of candidates(source, spec)) {
    const bad = (pattern && !pattern.test(name)) || spec.forbidden?.includes(name) || (forbiddenPattern && forbiddenPattern.test(name));
    if (bad) out.push({ node, values: { name, Name: name[0].toUpperCase() + name.slice(1), text: name.slice(0, 60) } });
  }
  return out;
};
