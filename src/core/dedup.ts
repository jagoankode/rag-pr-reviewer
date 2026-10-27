import crypto from 'crypto';

/**
 * Normalisasi teks untuk perbandingan (lowercase, whitespace berlebih).
 * Tanda baca dipertahankan: `===` vs `==` adalah aturan yang berbeda.
 * contentHash lama di DB memakai normalisasi yang menghapus tanda baca, jadi bandingkan selalu
 * dengan hash yang dihitung ulang dari content, bukan contentHash tersimpan.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Buat hash SHA-256 dari teks yang sudah dinormalisasi
 */
export function getNormHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

/**
 * Menghitung cosine similarity sederhana antara dua vector
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
