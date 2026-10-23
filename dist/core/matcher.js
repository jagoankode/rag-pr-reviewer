"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankGuidelinesByRelevance = rankGuidelinesByRelevance;
const local_embedder_js_1 = require("./local-embedder.js");
/**
 * Score relevance between a query (diff text / scaffold description) and a guideline chunk
 * using TF-IDF / BM25-like lexical keyword scoring with title boosting.
 */
function rankGuidelinesByRelevance(query, rules, limit = 7) {
    if (rules.length === 0)
        return [];
    if (!query || query.trim().length === 0)
        return rules.slice(0, limit);
    const queryTokens = new Set((0, local_embedder_js_1.tokenize)(query));
    if (queryTokens.size === 0)
        return rules.slice(0, limit);
    const scored = rules.map((rule) => {
        const titleTokens = (0, local_embedder_js_1.tokenize)(rule.title);
        const contentTokens = (0, local_embedder_js_1.tokenize)(rule.content);
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
