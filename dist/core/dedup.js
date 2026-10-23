"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeText = normalizeText;
exports.getNormHash = getNormHash;
exports.cosineSimilarity = cosineSimilarity;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Normalisasi teks untuk perbandingan (lowercase, hapus whitespace berlebih dan tanda baca)
 */
function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Buat hash SHA-256 dari teks yang sudah dinormalisasi
 */
function getNormHash(text) {
    return crypto_1.default.createHash('sha256').update(normalizeText(text)).digest('hex');
}
/**
 * Menghitung cosine similarity sederhana antara dua vector
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0)
        return 0;
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
