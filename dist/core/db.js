"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.listAllIndexedGuidelines = listAllIndexedGuidelines;
exports.insertChunks = insertChunks;
exports.ingestDirectKnowledge = ingestDirectKnowledge;
exports.searchRelevantGuidelines = searchRelevantGuidelines;
const lancedb = __importStar(require("@lancedb/lancedb"));
const ai_1 = require("ai");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const config_js_1 = require("./config.js");
const local_embedder_js_1 = require("./local-embedder.js");
const dedup_js_1 = require("./dedup.js");
const DB_DIR = path_1.default.join(os_1.default.homedir(), '.pr-rag', 'db');
const TABLE_NAME = 'guidelines';
let dbInstance = null;
async function getDb() {
    if (!dbInstance) {
        dbInstance = await lancedb.connect(DB_DIR);
    }
    return dbInstance;
}
/**
 * Mengambil semua daftar guidelines/aturan yang tersimpan di LanceDB
 */
async function listAllIndexedGuidelines() {
    const db = await getDb();
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) {
        return [];
    }
    const table = await db.openTable(TABLE_NAME);
    const rows = await table.query().toArray();
    return rows.map((r) => ({
        id: r.id,
        source: r.source,
        title: r.title,
        content: r.content,
    }));
}
/**
 * Generate embeddings untuk array teks
 */
async function generateVectors(texts) {
    const { client, config } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = config.embeddingModel || 'text-embedding-3-small';
    if (config.provider === '9router' || embModel === 'local') {
        const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(texts);
        return texts.map((t) => vectorizer(t));
    }
    try {
        const { embeddings } = await (0, ai_1.embedMany)({
            model: client.embedding(embModel),
            values: texts,
        });
        return embeddings;
    }
    catch {
        const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(texts);
        return texts.map((t) => vectorizer(t));
    }
}
/**
 * Ingest chunk dokumen / knowledge ke LanceDB dengan DEDUP (anti duplikat):
 * Menolak aturan/pengetahuan yang sudah ada (berdasarkan exact hash atau semantic similarity > 0.95)
 */
async function insertChunks(chunks) {
    if (chunks.length === 0) {
        return { insertedCount: 0, duplicateCount: 0, skippedTitles: [] };
    }
    const db = await getDb();
    const tableNames = await db.tableNames();
    let existingRecords = [];
    if (tableNames.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        existingRecords = await table.query().toArray();
    }
    const existingHashes = new Set(existingRecords.map((r) => r.contentHash || (0, dedup_js_1.getNormHash)(r.content)));
    // Filter 1: Cek duplikat teks persis (Normalized SHA-256 Hash)
    const uniqueChunks = [];
    const skippedTitles = [];
    for (const chunk of chunks) {
        const hash = (0, dedup_js_1.getNormHash)(chunk.content);
        if (existingHashes.has(hash)) {
            skippedTitles.push(chunk.title);
        }
        else {
            existingHashes.add(hash); // Hindari duplikat di dalam batch yang sama
            uniqueChunks.push(chunk);
        }
    }
    if (uniqueChunks.length === 0) {
        return {
            insertedCount: 0,
            duplicateCount: skippedTitles.length,
            skippedTitles,
        };
    }
    // Generate vector embeddings untuk chunk baru
    const texts = uniqueChunks.map((c) => `${c.title}\n${c.content}`);
    const vectors = await generateVectors(texts);
    const newRecords = uniqueChunks.map((chunk, i) => ({
        id: chunk.id,
        source: chunk.source,
        title: chunk.title,
        content: chunk.content,
        contentHash: (0, dedup_js_1.getNormHash)(chunk.content),
        vector: vectors[i],
    }));
    if (tableNames.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        await table.add(newRecords);
    }
    else {
        await db.createTable(TABLE_NAME, newRecords);
    }
    return {
        insertedCount: newRecords.length,
        duplicateCount: skippedTitles.length,
        skippedTitles,
    };
}
/**
 * Ingest percakapan interaktif langsung sebagai knowledge
 */
async function ingestDirectKnowledge(title, content, source = 'interactive_conversation') {
    const chunk = {
        id: `direct_${Date.now()}`,
        source,
        title,
        content,
    };
    return await insertChunks([chunk]);
}
/**
 * Mencari context guidelines yang paling relevan dengan query/diff
 */
async function searchRelevantGuidelines(query, limit = 5) {
    const db = await getDb();
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) {
        return [];
    }
    const table = await db.openTable(TABLE_NAME);
    const rows = await table.query().toArray();
    if (rows.length === 0)
        return [];
    const corpus = rows.map((r) => `${r.title}\n${r.content}`);
    const { client, config } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = config.embeddingModel || 'text-embedding-3-small';
    let queryVector;
    if (config.provider === '9router' || embModel === 'local') {
        const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(corpus);
        queryVector = vectorizer(query.slice(0, 4000));
    }
    else {
        try {
            const { embedding } = await (0, ai_1.embed)({
                model: client.embedding(embModel),
                value: query.slice(0, 4000),
            });
            queryVector = embedding;
        }
        catch {
            const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(corpus);
            queryVector = vectorizer(query.slice(0, 4000));
        }
    }
    const results = await table
        .vectorSearch(queryVector)
        .limit(limit)
        .toArray();
    return results.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        content: row.content,
    }));
}
