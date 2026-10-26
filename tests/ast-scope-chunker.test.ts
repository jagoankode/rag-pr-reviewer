import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAstScopes } from '../src/core/ast-scope-chunker.js';

test('extractAstScopes captures full function bodies without truncation', () => {
  const code = `
export function add(a: number, b: number): number {
  const sum = a + b;
  return sum;
}

const multiply = (x: number, y: number): number => {
  return x * y;
};
`;

  const chunks = extractAstScopes('calc.ts', code);
  assert.equal(chunks.length, 2);

  const fn1 = chunks.find(c => c.name === 'add');
  assert.ok(fn1);
  assert.equal(fn1.kind, 'function');
  assert.equal(fn1.startLine, 2);
  assert.equal(fn1.endLine, 5);
  assert.ok(fn1.content.includes('return sum;'));
  assert.ok(fn1.content.endsWith('}'));

  const fn2 = chunks.find(c => c.name === 'multiply');
  assert.ok(fn2);
  assert.equal(fn2.kind, 'function');
  assert.equal(fn2.startLine, 7);
  assert.equal(fn2.endLine, 9);
  assert.ok(fn2.content.includes('return x * y;'));
});

test('extractAstScopes handles classes, interfaces, and variables', () => {
  const code = `
interface User {
  id: string;
}

class UserService {
  getUser() { return null; }
}

const MAX_RETRY = 3;
`;

  const chunks = extractAstScopes('user.ts', code);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.some(c => c.kind === 'interface' && c.name === 'User'));
  assert.ok(chunks.some(c => c.kind === 'class' && c.name === 'UserService'));
  assert.ok(chunks.some(c => c.kind === 'variable' && c.name === 'MAX_RETRY'));
});
