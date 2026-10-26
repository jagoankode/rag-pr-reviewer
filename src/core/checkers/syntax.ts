import ts from 'typescript';
import { CheckContext, Primitive, RawFinding } from './types.js';
import { CheckOf } from './spec.js';
import { calleeName, containsJsx, directives, functionName, hasAncestor, isFallbackLiteral, isFunctionLike, isHookName, isUpperSnake, literalText, unwrap, walk } from './ast.js';

type Ctx = CheckContext<CheckOf<'forbid-syntax'>>;

const short = (node: ts.Node, source: ts.SourceFile): string => node.getText(source).replace(/\s+/g, ' ').slice(0, 60);

/** Walks the file and reports every node the predicate accepts, with its text as `{text}`. */
const each = (ctx: Ctx, test: (node: ts.Node) => ts.Node | false | undefined): RawFinding[] => {
  const out: RawFinding[] = [];
  walk(ctx.source, node => {
    const hit = test(node);
    if (hit) out.push({ node: hit, values: { text: short(node, ctx.source) } });
  });
  return out;
};

const inJsx = (n: ts.Node): boolean => hasAncestor(n, p => ts.isJsxExpression(p));
const isJsxNode = (n: ts.Node): boolean => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);

const ARITHMETIC = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Literal used in a named UPPER_SNAKE constant declaration or an enum is already extracted. */
const inNamedConstant = (node: ts.Node): boolean => hasAncestor(node, p => ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && isUpperSnake(p.name.text)) || hasAncestor(node, p => ts.isEnumDeclaration(p));

interface CommentRange { pos: number; end: number; kind: ts.CommentKind; }

function collectComments(source: ts.SourceFile): CommentRange[] {
  const text = source.getFullText();
  const seen = new Map<number, CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach(r => seen.set(r.pos, r));
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    // getChildren includes tokens such as a closing `}`, so comments before them are found too.
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

const TOOL_DIRECTIVE = /^\/\*\s*(eslint|istanbul|webpack|prettier|global|jshint|c8|@ts-)/;
const CODE_LIKE = /^(import|export|const|let|var|return|if|for|while|function|class|await|async)\b|;\s*$|^[\w$.]+\(.*\)\s*;?$|^<\/?[A-Za-z][^>]*>?$|^[{}]\s*$/;

function comments(ctx: Ctx, test: (raw: string, range: CommentRange, text: string) => number | undefined, values: (raw: string) => Record<string, string> = () => ({})): RawFinding[] {
  const out: RawFinding[] = [];
  const text = ctx.source.getFullText();
  for (const range of collectComments(ctx.source)) {
    const raw = text.slice(range.pos, range.end);
    const offset = test(raw, range, text);
    if (offset === undefined) continue;
    const pos = ctx.source.getLineAndCharacterOfPosition(range.pos + offset);
    out.push({ line: pos.line + 1, column: pos.character + 1, values: { text: raw.slice(0, 60), ...values(raw) } });
  }
  return out;
}

const SYNTAX: Record<CheckOf<'forbid-syntax'>['syntax'], (ctx: Ctx) => RawFinding[]> = {
  var: ctx => each(ctx, n => ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped) && n),
  'non-null-assertion': ctx => each(ctx, n => ts.isNonNullExpression(n) && n),
  'type-assertion': ctx => each(ctx, n => {
    if (!ts.isAsExpression(n) && !ts.isTypeAssertionExpression(n)) return;
    if (ts.isAsExpression(n) && ts.isTypeReferenceNode(n.type) && n.type.typeName.getText(ctx.source) === 'const') return;
    // `x as unknown as T` is one assertion, reported on its outer `as`.
    if (ts.isAsExpression(n.parent) && n.parent.expression === n) return;
    // Anchor on the asserted type so multi-line expressions point at the `as X` line.
    return ts.isAsExpression(n) ? n.type : n;
  }),
  'empty-object-type': ctx => each(ctx, n => ts.isTypeLiteralNode(n) && n.members.length === 0 && n),
  'index-signature': ctx => each(ctx, n => ts.isIndexSignatureDeclaration(n) && n),
  'function-declaration': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => { if (ts.isFunctionDeclaration(n) && n.body && n.name) out.push({ node: n.name, values: { name: n.name.text, text: n.name.text } }); });
    return out;
  },
  'optional-parameter-before-required': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!isFunctionLike(n)) return;
      const optional = n.parameters.find(p => p.questionToken || p.initializer);
      if (optional && n.parameters.slice(n.parameters.indexOf(optional) + 1).some(p => !p.questionToken && !p.initializer && !p.dotDotDotToken)) {
        out.push({ node: optional, values: { name: optional.name.getText(ctx.source), text: optional.name.getText(ctx.source) } });
      }
    });
    return out;
  },
  'inline-object-type-in-signature': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!isFunctionLike(n)) return;
      for (const t of [...n.parameters.map(p => p.type), n.type]) if (t && ts.isTypeLiteralNode(t) && t.members.length) out.push({ node: t, values: { text: short(t, ctx.source) } });
    });
    return out;
  },
  jsx: ctx => each(ctx, n => {
    const createElement = ts.isCallExpression(n) && calleeName(n) === 'createElement';
    // Report the outermost element only.
    return (isJsxNode(n) || createElement) && !(n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) && n;
  }),
  'jsx-and-number': ctx => each(ctx, n => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken || !inJsx(n)) return;
    const left = unwrap(n.left);
    return ((ts.isPropertyAccessExpression(left) && left.name.text === 'length') || ts.isNumericLiteral(left)) && left;
  }).map(f => ({ ...f, values: { text: f.node!.getText(ctx.source) } })),
  'jsx-nested-ternary': ctx => each(ctx, n => ts.isConditionalExpression(n) && inJsx(n) && [n.whenTrue, n.whenFalse].some(b => ts.isConditionalExpression(unwrap(b))) &&
    !ts.isConditionalExpression(unwrap(n.parent as ts.Expression)) && n),
  'jsx-ternary-null': ctx => each(ctx, n => ts.isConditionalExpression(n) && inJsx(n) && [n.whenTrue, n.whenFalse].some(b => unwrap(b).kind === ts.SyntaxKind.NullKeyword) && n),
  'jsx-inline-handler-wrapper': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!ts.isJsxAttribute(n) || !/^on[A-Z]/.test(n.name.getText(ctx.source)) || !n.initializer || !ts.isJsxExpression(n.initializer) || !n.initializer.expression) return;
      const fn = unwrap(n.initializer.expression);
      if (!ts.isArrowFunction(fn) || fn.parameters.length) return;
      let body: ts.Node = fn.body;
      if (ts.isBlock(body) && body.statements.length === 1 && ts.isExpressionStatement(body.statements[0])) body = body.statements[0].expression;
      if (ts.isCallExpression(body) && body.arguments.length === 0) {
        out.push({ node: fn, values: { text: fn.getText(ctx.source), name: n.name.getText(ctx.source), value: body.expression.getText(ctx.source) } });
      }
    });
    return out;
  },
  'runtime-logic': ctx => ctx.source.statements.filter(s =>
    ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isExpressionStatement(s) || ts.isIfStatement(s) || containsJsx(s) ||
    (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => {
      const init = d.initializer && unwrap(d.initializer);
      return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    }))).map(s => ({ node: s, values: { text: short(s, ctx.source) } })),
  'non-export-statement': ctx => ctx.source.statements
    .filter(s => !ts.isExportDeclaration(s) && !ts.isExportAssignment(s) && !ts.isImportDeclaration(s))
    .map(s => ({ node: s, values: { text: short(s, ctx.source) } })),
  // A directive only takes effect in the prologue, i.e. when every statement before it is a directive too.
  'misplaced-directive': ctx => directives(ctx.source).filter((d, i) => d.index !== i).map(d => ({ node: d.statement, values: { value: d.text, text: d.text } })),
  'non-async-server-export': ctx => {
    if (!directives(ctx.source).some(d => d.text === 'use server')) return [];
    const isAsync = (n: ts.Node | undefined) => !!n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
    return ctx.source.statements.filter(s => {
      const exported = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) return false;
      return !(ts.isFunctionDeclaration(s) ? isAsync(s) : ts.isVariableStatement(s) && s.declarationList.declarations.every(d => isAsync(d.initializer && unwrap(d.initializer))));
    }).map(s => ({ node: s, values: { text: short(s, ctx.source) } }));
  },
  fallback: ctx => {
    const getters = ctx.spec.getters || [];
    return each(ctx, n => ((ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || (n.operatorToken.kind === ts.SyntaxKind.BarBarToken && isFallbackLiteral(n.right)))) ||
      (ts.isCallExpression(n) && getters.includes(calleeName(n) || '') && n.arguments.length >= 3)) && n);
  },
  'or-fallback': ctx => each(ctx, n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken && isFallbackLiteral(n.right) && !isFallbackLiteral(n.left) && n.operatorToken)
    .map(f => ({ ...f, values: { text: short(f.node!.parent, ctx.source) } })),
  'magic-number': ctx => {
    const allow = ctx.spec.allow || [];
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!ts.isNumericLiteral(n) || allow.includes(n.text) || inNamedConstant(n) || hasAncestor(n, p => ts.isTypeNode(p))) return;
      const parent = n.parent && ts.isPrefixUnaryExpression(n.parent) ? n.parent.parent : n.parent;
      const inLogic = (ts.isBinaryExpression(parent) && ARITHMETIC.has(parent.operatorToken.kind)) || (ts.isCallExpression(parent) && parent.arguments.some(a => unwrap(a) === n || unwrap(a) === n.parent));
      if (inLogic) out.push({ node: n, values: { value: n.text, text: n.text } });
    });
    return out;
  },
  'magic-string': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!ts.isBinaryExpression(n) || !EQUALITY.has(n.operatorToken.kind) || inNamedConstant(n)) return;
      for (const side of [n.left, n.right]) {
        const other = side === n.left ? n.right : n.left;
        const value = literalText(unwrap(side));
        if (value && !ts.isTypeOfExpression(unwrap(other))) out.push({ node: side, values: { value, text: value, VALUE: value.toUpperCase().replace(/[^A-Z0-9]+/g, '_') } });
      }
    });
    return out;
  },
  'block-comment': ctx => comments(ctx, (raw, range, text) => {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia || raw.startsWith('/**') || TOOL_DIRECTIVE.test(raw)) return;
    // `{/* ... */}` is the only comment syntax available inside JSX.
    const before = text.slice(0, range.pos).trimEnd().slice(-1), after = text.slice(range.end).trimStart()[0];
    return before === '{' && after === '}' ? undefined : 0;
  }),
  'commented-out-code': ctx => comments(ctx, (raw, range) => {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return;
    const body = raw.replace(/^\/\/\s?/, '').trim();
    return body && !/^(TODO|FIXME|NOTE|eslint|@ts-|prettier)/.test(body) && CODE_LIKE.test(body) ? 0 : undefined;
  }),
  'todo-without-ticket': ctx => {
    const ticket = ctx.spec.ticketPattern || '\\S+';
    const marker = new RegExp(`\\b(TODO|FIXME)\\b(?!\\s*\\(${ticket}\\))`);
    return comments(ctx, raw => raw.match(marker)?.index, raw => ({ value: raw.match(marker)?.[1] || '' }));
  },
  'hook-name-without-hook-call': ctx => {
    const out: RawFinding[] = [];
    walk(ctx.source, n => {
      if (!isFunctionLike(n) || !n.body) return;
      const name = functionName(n);
      if (!isHookName(name)) return;
      let callsHook = false;
      walk(n.body, c => { if (ts.isCallExpression(c) && isHookName(calleeName(c))) callsHook = true; });
      if (!callsHook) out.push({ node: n, values: { name, text: name, plain: name![3]?.toLowerCase() + name!.slice(4) } });
    });
    return out;
  },
};

export const forbidSyntax: Primitive<CheckOf<'forbid-syntax'>> = ctx => SYNTAX[ctx.spec.syntax](ctx);
