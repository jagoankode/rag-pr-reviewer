import { DocChunk } from './chunker.js';
import { tokenize } from './local-embedder.js';

/**
 * Kamus sinonim & translasi istilah teknis Indonesia ➔ English.
 * Menghubungkan pertanyaan developer berbahasa Indonesia dengan dokumentasi coding convention (English).
 */
const TECH_SYNONYMS: Record<string, string[]> = {
  // Fungsi & Method
  fungsi: ['function', 'method', 'arrow'],
  fungsional: ['functional', 'function'],
  pembuatan: ['creation', 'naming', 'declaration', 'definition'],
  membuat: ['create', 'naming', 'declare'],
  panggil: ['call', 'invoke'],
  memanggil: ['call', 'invoking'],

  // Variabel & Data
  variabel: ['variable', 'const', 'let', 'naming'],
  peubah: ['variable'],
  konstanta: ['constant', 'magic', 'config'],
  konstan: ['constant', 'static'],

  // Tipe Data & TypeScript
  tipe: ['type', 'typing', 'interface', 'zod', 'schema'],
  pengetikan: ['typing', 'type'],
  bentuk: ['shape', 'schema', 'type'],
  anotasi: ['annotation', 'typing'],

  // Kondisi & Logika
  kondisi: ['condition', 'conditional', 'branching', 'guard'],
  pengkondisian: ['conditional', 'condition', 'branching'],
  percabangan: ['branching', 'switch', 'exhaustive', 'pattern'],
  fallback: ['fallback', 'default', 'upstream'],
  bawaan: ['default', 'fallback'],
  cadangan: ['fallback', 'default'],
  kembalian: ['return', 'returns', 'early'],

  // Komponen & UI / Frontend
  komponen: ['component', 'container', 'wrapper', 'view'],
  tampilan: ['view', 'component', 'ui', 'rendering'],
  kait: ['hook', 'hooks', 'use'],
  cantolan: ['hook', 'hooks'],

  // Testing & Quality
  pengujian: ['test', 'testing', 'unit', 'snapshot', 'jest'],
  tes: ['test', 'testing', 'unit', 'snap'],
  uji: ['test', 'testing'],
  cakupan: ['coverage', 'threshold'],

  // Struktur & Organisasi Kode
  berkas: ['file', 'files', 'structure', 'module'],
  struktur: ['structure', 'scaffold', 'architecture', 'module'],
  modul: ['module', 'architecture'],
  penamaan: ['naming', 'name', 'convention'],
  nama: ['name', 'naming'],
  aturan: ['convention', 'rule', 'policy', 'standard'],
  pedoman: ['convention', 'guideline', 'standard'],
  panduan: ['guideline', 'convention', 'standard'],
  tata: ['convention', 'style', 'format'],

  // Dokumentasi & Style
  komentar: ['comment', 'jsdoc'],
  format: ['format', 'formatting', 'style'],
  pemformatan: ['formatting', 'style'],

  // Performa & Error
  performa: ['performance', 'memoization', 'memo', 'usememo', 'usecallback'],
  kinerja: ['performance', 'memoization'],
  kesalahan: ['error', 'handling', 'catch', 'throw'],
  penanganan: ['handling', 'guard', 'handler'],
};

/**
 * Memperluas token query dengan kamus sinonim istilah teknis ID ➔ EN
 */
export function expandQueryTokens(query: string): Set<string> {
  const baseTokens = tokenize(query);
  const tokenSet = new Set<string>(baseTokens);

  for (const token of baseTokens) {
    const synonyms = TECH_SYNONYMS[token];
    if (synonyms) {
      for (const syn of synonyms) {
        tokenSet.add(syn);
      }
    }
  }

  return tokenSet;
}

/**
 * Score relevance between a query (diff text / scaffold description / dialog prompt)
 * and a guideline chunk using TF-IDF / BM25-like lexical keyword scoring with title boosting
 * and Tech Synonym Expansion.
 */
export function rankGuidelinesByRelevance(query: string, rules: DocChunk[], limit: number = 7): DocChunk[] {
  if (rules.length === 0) return [];
  if (!query || query.trim().length === 0) return rules.slice(0, limit);

  const queryTokens = expandQueryTokens(query);
  if (queryTokens.size === 0) return rules.slice(0, limit);

  const scored = rules.map((rule) => {
    const titleTokens = tokenize(rule.title);
    const contentTokens = tokenize(rule.content);

    let score = 0;

    // 1. Title match gets high boost (3x)
    for (const t of titleTokens) {
      if (queryTokens.has(t)) {
        score += 3;
      }
    }

    // 2. Content match
    for (const t of contentTokens) {
      if (queryTokens.has(t)) {
        score += 1;
      }
    }

    // Length normalization
    const lengthPenalty = Math.log(contentTokens.length + 10) / 10;
    const finalScore = score / (lengthPenalty || 1);

    return { rule, score: finalScore };
  });

  // Urutkan skor tertinggi
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0)
    .slice(0, limit)
    .map((item) => item.rule);
}
