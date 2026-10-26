import ts from 'typescript';
import { Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { walk } from './ast.js';

const NEEDS_SEMICOLON = new Set([
  ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ContinueStatement, ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.DoStatement, ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

const KEYWORD: Record<number, string> = {
  [ts.SyntaxKind.ReturnStatement]: 'return', [ts.SyntaxKind.IfStatement]: 'if', [ts.SyntaxKind.SwitchStatement]: 'switch',
  [ts.SyntaxKind.ForStatement]: 'for', [ts.SyntaxKind.ForInStatement]: 'for', [ts.SyntaxKind.ForOfStatement]: 'for',
  [ts.SyntaxKind.WhileStatement]: 'while', [ts.SyntaxKind.DoStatement]: 'do', [ts.SyntaxKind.TryStatement]: 'try',
  [ts.SyntaxKind.ThrowStatement]: 'throw', [ts.SyntaxKind.BreakStatement]: 'break', [ts.SyntaxKind.ContinueStatement]: 'continue',
};

const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line) || /\*\/\s*$/.test(line);

/** Statement lists in which "first statement in its block" is meaningful. */
function blockStatements(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return undefined;
}

/** Keys for eof-newline: `missing`, `extra`. */
export const format: Primitive<CheckOf<'format'>> = ({ source, lines, input, spec }) => {
  const out: RawFinding[] = [];
  if (spec.rule === 'eof-newline') {
    if (!input.content.length) return out;
    if (!input.content.endsWith('\n')) out.push({ line: lines.length, column: lines[lines.length - 1].length + 1, key: 'missing' });
    else if (/\n[ \t]*\n$/.test(input.content)) out.push({ line: lines.length - 1, column: 1, key: 'extra' });
    return out;
  }
  const keywords = new Set(spec.keywords || []);
  walk(source, node => {
    if (spec.rule === 'semicolon' && NEEDS_SEMICOLON.has(node.kind) && !(ts.isPropertyDeclaration(node) && node.parent && !ts.isClassLike(node.parent))) {
      const text = node.getText(source);
      // A class member that ends with a block does not take a semicolon.
      const endsWithBlock = ts.isPropertyDeclaration(node) && /}\s*$/.test(text) && !node.initializer;
      if (!text.trimEnd().endsWith(';') && !endsWithBlock) {
        const end = source.getLineAndCharacterOfPosition(node.getEnd());
        out.push({ line: end.line + 1, column: end.character + 1 });
      }
    }
    if (spec.rule === 'curly') {
      const bodies: [ts.Statement | undefined, string][] = [];
      if (ts.isIfStatement(node)) bodies.push([node.thenStatement, 'if'], [node.elseStatement && !ts.isIfStatement(node.elseStatement) ? node.elseStatement : undefined, 'else']);
      if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) bodies.push([node.statement, KEYWORD[node.kind]]);
      for (const [body, keyword] of bodies) if (body && !ts.isBlock(body)) out.push({ node: body, values: { keyword } });
    }
    const keyword = KEYWORD[node.kind];
    if (spec.rule === 'blank-line-before' && keyword && keywords.has(keyword) && node.parent) {
      const statements = blockStatements(node.parent);
      if (!statements || statements.indexOf(node as ts.Statement) <= 0) return;
      const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      let k = startLine - 1;
      while (k >= 0 && isCommentLine(lines[k])) k--;
      if (k >= 0 && lines[k].trim() !== '') out.push({ node, values: { keyword } });
    }
  });
  return out;
};
