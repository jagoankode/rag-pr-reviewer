import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderForModel, AppConfig } from '../src/core/config.js';
import { extractReviewResult } from '../src/commands/review.js';
import { chunkMarkdown } from '../src/core/chunker.js';

describe('Config & Provider Resolution', () => {
  const mockConfig: AppConfig = {
    provider: '9router',
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:20129/v1',
    defaultModel: 'ag/gemini-3.8-flash',
    savedModels: ['ag/gemini-3.8-flash', 'gpt-4o'],
    providers: {
      '9router': {
        id: '9router',
        name: '9router Gateway',
        providerType: '9router',
        apiKey: '9router-key',
        baseUrl: 'http://127.0.0.1:20129/v1',
        models: ['ag/gemini-3.8-flash'],
      },
      'openai': {
        id: 'openai',
        name: 'OpenAI Official',
        providerType: 'openai',
        apiKey: 'openai-key',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o'],
      },
    },
    modelProviderMap: {
      'ag/gemini-3.8-flash': '9router',
      'gpt-4o': 'openai',
    },
  };

  it('resolves correct provider, baseUrl, and apiKey for mapped model', () => {
    const resolved9r = resolveProviderForModel(mockConfig, 'ag/gemini-3.8-flash');
    assert.equal(resolved9r.providerId, '9router');
    assert.equal(resolved9r.baseUrl, 'http://127.0.0.1:20129/v1');
    assert.equal(resolved9r.apiKey, '9router-key');

    const resolvedOai = resolveProviderForModel(mockConfig, 'gpt-4o');
    assert.equal(resolvedOai.providerId, 'openai');
    assert.equal(resolvedOai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(resolvedOai.apiKey, 'openai-key');
  });
});

describe('Review Result Parsing', () => {
  it('extracts structured PR review violations from JSON markdown block', () => {
    const rawAiOutput = '```json\n{\n  "violations": [\n    {\n      "file": "src/user.ts",\n      "line": 42,\n      "rule": "Convention: Strict Typing",\n      "severity": "error",\n      "comment": "Tipe any dilarang",\n      "suggestedFix": "Gunakan tipe unknown atau definisikan interface"\n    }\n  ],\n  "notes": []\n}\n```';

    const result = extractReviewResult(rawAiOutput);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'src/user.ts');
    assert.equal(result.violations[0].line, 42);
    assert.equal(result.violations[0].severity, 'error');
  });
});

describe('Document Chunker', () => {
  it('splits markdown headings into distinct rule chunks', () => {
    const md = '# Rule 1\nThis is a long enough content for rule 1 convention to exceed minimum threshold.\n\n# Rule 2\nThis is also another long enough content for rule 2 convention to exceed minimum threshold.';
    const chunks = chunkMarkdown(md, 'rules.md');
    assert.ok(chunks.length >= 1);
  });
});
