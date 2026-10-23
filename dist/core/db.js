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
exports.getQdrantClient = getQdrantClient;
exports.listAllIndexedGuidelines = listAllIndexedGuidelines;
exports.insertChunks = insertChunks;
exports.ingestDirectKnowledge = ingestDirectKnowledge;
exports.searchRelevantGuidelines = searchRelevantGuidelines;
const lancedb = __importStar(require("@lancedb/lancedb"));
const js_client_rest_1 = require("@qdrant/js-client-rest");
const ai_1 = require("ai");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const config_js_1 = require("./config.js");
const local_embedder_js_1 = require("./local-embedder.js");
const dedup_js_1 = require("./dedup.js");
const DB_DIR = path_1.default.join(os_1.default.homedir(), '.pr-rag', 'db');
const TABLE_NAME = 'guidelines';
let dbInstance = null;
let qdrantInstance = null;
async function getDb() {
    if (!dbInstance) {
        dbInstance = await lancedb.connect(DB_DIR);
    }
    return dbInstance;
}
async function getQdrantClient() {
    const config = await (0, config_js_1.loadConfig)();
    const url = config.qdrantUrl || 'https://knowlage.jagoankode.site';
    const apiKey = config.qdrantApiKey || undefined;
    const collection = config.qdrantCollection || 'guidelines';
    if (!qdrantInstance) {
        qdrantInstance = new js_client_rest_1.QdrantClient({ url, apiKey });
    }
    // Pastikan koleksi ada di Qdrant
    const collections = await qdrantInstance.getCollections();
    const exists = collections.collections.some((c) => c.name === collection);
    if (!exists) {
        // Default 256 dimensi untuk TF-IDF / local vectorizer atau 1536 untuk openai text-embedding-3-small
        const vectorSize = config.provider === '9router' || config.embeddingModel === 'local' ? 256 : 1536;
        await qdrantInstance.createCollection(collection, {
            vectors: {
                size: vectorSize,
                distance: 'Cosine',
            },
        });
    }
    return { client: qdrantInstance, collection };
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
 * Mengambil semua daftar guidelines/aturan yang tersimpan (Local LanceDB atau VPS Qdrant)
 */
async function listAllIndexedGuidelines() {
    const config = await (0, config_js_1.loadConfig)();
    if (config.dbType === 'qdrant') {
        try {
            const { client, collection } = await getQdrantClient();
            const points = await client.scroll(collection, { limit: 100, with_payload: true });
            return points.points.map((p) => {
                const payload = p.payload;
                return {
                    id: String(p.id),
                    source: payload?.source || 'remote_vps',
                    title: payload?.title || 'Untitled',
                    content: payload?.content || '',
                };
            });
        }
        catch (err) {
            throw new Error(`Gagal membaca data dari Qdrant VPS: ${err.message}`);
        }
    }
    // Local LanceDB fallback
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
 * Ingest chunk dokumen / knowledge ke database (Local LanceDB atau Remote Qdrant VPS)
 */
async function insertChunks(chunks) {
    if (chunks.length === 0) {
        return { insertedCount: 0, duplicateCount: 0, skippedTitles: [] };
    }
    const config = await (0, config_js_1.loadConfig)();
    // ROUTE 1: REMOTE QDRANT VPS
    if (config.dbType === 'qdrant') {
        const { client, collection } = await getQdrantClient();
        // Ambil points eksisting untuk hash matching anti-duplikat
        const existingPoints = await client.scroll(collection, { limit: 1000, with_payload: true });
        const existingHashes = new Set(existingPoints.points.map((p) => p.payload?.contentHash || (0, dedup_js_1.getNormHash)(p.payload?.content || '')));
        const uniqueChunks = [];
        const skippedTitles = [];
        for (const chunk of chunks) {
            const hash = (0, dedup_js_1.getNormHash)(chunk.content);
            if (existingHashes.has(hash)) {
                skippedTitles.push(chunk.title);
            }
            else {
                existingHashes.add(hash);
                uniqueChunks.push(chunk);
            }
        }
        if (uniqueChunks.length === 0) {
            return { insertedCount: 0, duplicateCount: skippedTitles.length, skippedTitles };
        }
        const texts = uniqueChunks.map((c) => `${c.title}\n${c.content}`);
        const vectors = await generateVectors(texts);
        const points = uniqueChunks.map((chunk, i) => ({
            id: typeof chunk.id === 'string' && /^[0-9a-fA-F-]+$/.test(chunk.id) ? chunk.id : Math.floor(Math.random() * 1000000000),
            vector: vectors[i],
            payload: {
                originalId: chunk.id,
                source: chunk.source,
                title: chunk.title,
                content: chunk.content,
                contentHash: (0, dedup_js_1.getNormHash)(chunk.content),
            },
        }));
        await client.upsert(collection, {
            wait: true,
            points,
        });
        return {
            insertedCount: points.length,
            duplicateCount: skippedTitles.length,
            skippedTitles,
        };
    }
    // ROUTE 2: LOCAL LANCEDB
    const db = await getDb();
    const tableNames = await db.tableNames();
    let existingRecords = [];
    let tableHasContentHash = false;
    if (tableNames.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        existingRecords = await table.query().toArray();
        try {
            const tblSchema = await table.schema();
            tableHasContentHash = tblSchema.fields.some((f) => f.name === 'contentHash');
        }
        catch {
            tableHasContentHash = false;
        }
    }
    const existingHashes = new Set(existingRecords.map((r) => r.contentHash || (0, dedup_js_1.getNormHash)(r.content)));
    const uniqueChunks = [];
    const skippedTitles = [];
    for (const chunk of chunks) {
        const hash = (0, dedup_js_1.getNormHash)(chunk.content);
        if (existingHashes.has(hash)) {
            skippedTitles.push(chunk.title);
        }
        else {
            existingHashes.add(hash);
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
    const texts = uniqueChunks.map((c) => `${c.title}\n${c.content}`);
    const vectors = await generateVectors(texts);
    const newRecords = uniqueChunks.map((chunk, i) => {
        const rec = {
            id: chunk.id,
            source: chunk.source,
            title: chunk.title,
            content: chunk.content,
            vector: vectors[i],
        };
        if (!tableNames.includes(TABLE_NAME) || tableHasContentHash) {
            rec.contentHash = (0, dedup_js_1.getNormHash)(chunk.content);
        }
        return rec;
    });
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
 * Mencari context guidelines yang paling relevan dengan query/diff (Local LanceDB atau Qdrant VPS)
 */
async function searchRelevantGuidelines(query, limit = 5) {
    const config = await (0, config_js_1.loadConfig)();
    // ROUTE 1: REMOTE QDRANT VPS
    if (config.dbType === 'qdrant') {
        try {
            const { client, collection } = await getQdrantClient();
            const points = await client.scroll(collection, { limit: 100, with_payload: true });
            if (points.points.length === 0)
                return [];
            const corpus = points.points.map((p) => `${p.payload?.title}\n${p.payload?.content}`);
            let queryVector;
            if (config.provider === '9router' || config.embeddingModel === 'local') {
                const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(corpus);
                queryVector = vectorizer(query.slice(0, 4000));
            }
            else {
                const { client: aiClient } = await (0, config_js_1.getActiveAIProvider)();
                const embModel = config.embeddingModel || 'text-embedding-3-small';
                try {
                    const { embedding } = await (0, ai_1.embed)({
                        model: aiClient.embedding(embModel),
                        value: query.slice(0, 4000),
                    });
                    queryVector = embedding;
                }
                catch {
                    const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(corpus);
                    queryVector = vectorizer(query.slice(0, 4000));
                }
            }
            const searchResults = await client.query(collection, {
                query: queryVector,
                limit,
                with_payload: true,
            });
            return searchResults.points.map((res) => ({
                id: String(res.id),
                source: res.payload?.source || 'remote_vps',
                title: res.payload?.title || 'Untitled',
                content: res.payload?.content || '',
            }));
        }
        catch {
            return [];
        }
    }
    // ROUTE 2: LOCAL LANCEDB
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
    const { client, config: aiConfig } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = aiConfig.embeddingModel || 'text-embedding-3-small';
    let queryVector;
    if (aiConfig.provider === '9router' || embModel === 'local') {
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
