import ts from 'typescript';

export interface AstScopeChunk {
  kind: 'function' | 'variable' | 'class' | 'interface' | 'type' | 'file-header';
  name: string;
  startLine: number; // 1-based
  endLine: number;   // 1-based
  startColumn: number;
  content: string;
  isExported: boolean;
}

/**
 * Mengekstrak blok scope utuh (function, variable declaration, class, interface)
 * menggunakan TypeScript AST murni.
 * Dijamin:
 * 1. Body function UTUH (tidak pernah kepotong kurung kurawal).
 * 2. Posisi baris & kolom 100% akurat sesuai file asli.
 */
export function extractAstScopes(filePath: string, code: string): AstScopeChunk[] {
  const isTS = /\.[cm]?tsx?$/.test(filePath);
  if (!isTS) {
    return [{
      kind: 'file-header',
      name: filePath,
      startLine: 1,
      endLine: code.split('\n').length,
      startColumn: 1,
      content: code,
      isExported: true,
    }];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const chunks: AstScopeChunk[] = [];
  const lines = code.split('\n');

  function getSpan(node: ts.Node) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      content: code.slice(node.getStart(sourceFile), node.getEnd()),
    };
  }

  function hasExport(node: ts.Node): boolean {
    const modifiers = (node as any).modifiers;
    return Array.isArray(modifiers) && modifiers.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  ts.forEachChild(sourceFile, (node) => {
    // 1. Function Declaration (function myFunc() { ... })
    if (ts.isFunctionDeclaration(node)) {
      const span = getSpan(node);
      const name = node.name ? node.name.text : 'anonymous_function';
      chunks.push({
        kind: 'function',
        name,
        startLine: span.startLine,
        endLine: span.endLine,
        startColumn: span.startColumn,
        content: span.content,
        isExported: hasExport(node),
      });
      return;
    }

    // 2. Class Declaration
    if (ts.isClassDeclaration(node)) {
      const span = getSpan(node);
      const name = node.name ? node.name.text : 'anonymous_class';
      chunks.push({
        kind: 'class',
        name,
        startLine: span.startLine,
        endLine: span.endLine,
        startColumn: span.startColumn,
        content: span.content,
        isExported: hasExport(node),
      });
      return;
    }

    // 3. Interface & Type Alias
    if (ts.isInterfaceDeclaration(node)) {
      const span = getSpan(node);
      chunks.push({
        kind: 'interface',
        name: node.name.text,
        startLine: span.startLine,
        endLine: span.endLine,
        startColumn: span.startColumn,
        content: span.content,
        isExported: hasExport(node),
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const span = getSpan(node);
      chunks.push({
        kind: 'type',
        name: node.name.text,
        startLine: span.startLine,
        endLine: span.endLine,
        startColumn: span.startColumn,
        content: span.content,
        isExported: hasExport(node),
      });
      return;
    }

    // 4. Variable Statement (const x = 1, const f = () => { ... })
    if (ts.isVariableStatement(node)) {
      const isExp = hasExport(node);
      for (const decl of node.declarationList.declarations) {
        const span = getSpan(decl);
        const name = decl.name.getText(sourceFile);
        const isArrowOrFunc = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
        chunks.push({
          kind: isArrowOrFunc ? 'function' : 'variable',
          name,
          startLine: span.startLine,
          endLine: span.endLine,
          startColumn: span.startColumn,
          content: span.content,
          isExported: isExp,
        });
      }
      return;
    }
  });

  // Jika tidak ada chunk spesifik yang terdeteksi (atau file kosong / hanya import)
  if (chunks.length === 0) {
    chunks.push({
      kind: 'file-header',
      name: filePath,
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 1,
      content: code,
      isExported: true,
    });
  }

  return chunks;
}
