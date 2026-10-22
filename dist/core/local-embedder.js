"use strict";
/**
 * Lightweight local TF-IDF & Cosine Similarity vectorizer.
 * Tidak membutuhkan external embedding API sama sekali,
 * sehingga 100% kompatibel dengan gateway model completion seperti 9router, Ollama, Claude, dll.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenize = tokenize;
exports.createTfIdfIndex = createTfIdfIndex;
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2);
}
function createTfIdfIndex(corpus, dimensions = 256) {
    // Hitung Document Frequency (DF)
    const dfMap = new Map();
    const totalDocs = corpus.length || 1;
    for (const doc of corpus) {
        const uniqueTokens = new Set(tokenize(doc));
        for (const token of uniqueTokens) {
            dfMap.set(token, (dfMap.get(token) || 0) + 1);
        }
    }
    // Pilih top terms paling penting sebagai basis dimensi vector
    const sortedTerms = Array.from(dfMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, dimensions)
        .map(([term]) => term);
    const termIndex = new Map();
    sortedTerms.forEach((term, idx) => termIndex.set(term, idx));
    // Return vectorizer function
    return (text) => {
        const vector = new Array(dimensions).fill(0);
        const tokens = tokenize(text);
        if (tokens.length === 0)
            return vector;
        const tfMap = new Map();
        for (const t of tokens) {
            tfMap.set(t, (tfMap.get(t) || 0) + 1);
        }
        let norm = 0;
        for (const [token, count] of tfMap.entries()) {
            const idx = termIndex.get(token);
            if (idx !== undefined) {
                const tf = count / tokens.length;
                const idf = Math.log((totalDocs + 1) / ((dfMap.get(token) || 1) + 1)) + 1;
                const val = tf * idf;
                vector[idx] = val;
                norm += val * val;
            }
        }
        // Normalisasi unit vector (L2 norm)
        const magnitude = Math.sqrt(norm);
        if (magnitude > 0) {
            for (let i = 0; i < dimensions; i++) {
                vector[i] /= magnitude;
            }
        }
        return vector;
    };
}
