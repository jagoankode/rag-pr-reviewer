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
exports.getVectorSize = getVectorSize;
exports.getQdrantClient = getQdrantClient;
exports.listAllIndexedGuidelines = listAllIndexedGuidelines;
exports.insertChunks = insertChunks;
exports.insertGuideline = insertGuideline;
exports.searchRelevantGuidelines = searchRelevantGuidelines;
const lancedb = __importStar(require("@lancedb/lancedb"));
const js_client_rest_1 = require("@qdrant/js-client-rest");
const ai_1 = require("ai");
const path_1 = __importDefault(require("path"));
const chalk_1 = __importDefault(require("chalk"));
const config_js_1 = require("./config.js");
const local_embedder_js_1 = require("./local-embedder.js");
const dedup_js_1 = require("./dedup.js");
const updater_js_1 = require("./updater.js");
const matcher_js_1 = require("./matcher.js");
const TABLE_NAME = 'guidelines';
let dbInstance = null;
let qdrantInstance = null;
async function getDb() {
    if (!dbInstance) {
        const dbDir = path_1.default.join((0, config_js_1.getConfigDir)(), 'db');
        dbInstance = await lancedb.connect(dbDir);
    }
    return dbInstance;
}
function getVectorSize(config) {
    if (config.provider === '9router' || config.embeddingModel === 'local') {
        return 256;
    }
    const model = (config.embeddingModel || '').toLowerCase();
    if (model.includes('large') || model.includes('3072')) {
        return 3072;
    }
    return 1536;
}
async function getQdrantClient() {
    const config = await (0, config_js_1.loadConfig)();
    const rawUrl = (config.qdrantUrl || '').trim();
    const collection = (config.qdrantCollection || '').trim();
    if (!rawUrl || !collection) {
        throw new Error('Qdrant URL dan Collection belum diset! Silakan konfigurasi via TUI (`lumio` -> "Database Storage Mode") sebelum menjalankan operasi database.');
    }
    const url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
    const apiKey = config.qdrantApiKey || undefined;
    if (!qdrantInstance) {
        const parsedUrl = new URL(url);
        const defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
        const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;
        qdrantInstance = new js_client_rest_1.QdrantClient({
            url,
            port,
            apiKey,
            checkCompatibility: false,
        });
    }
    const collections = await qdrantInstance.getCollections();
    const exists = collections.collections.some((c) => c.name === collection);
    if (!exists) {
        const vectorSize = getVectorSize(config);
        await qdrantInstance.createCollection(collection, {
            vectors: {
                size: vectorSize,
                distance: 'Cosine',
            },
        });
    }
    return { client: qdrantInstance, collection };
}
async function generateVectors(texts) {
    const { embeddingClient, config } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = config.embeddingModel || 'text-embedding-3-small';
    if (config.provider === '9router' || embModel === 'local') {
        const vectorizer = (0, local_embedder_js_1.createTfIdfIndex)(texts);
        return texts.map((t) => vectorizer(t));
    }
    try {
        const { embeddings } = await (0, ai_1.embedMany)({
            model: embeddingClient.embedding(embModel),
            values: texts,
        });
        return embeddings;
    }
    catch (err) {
        throw new Error(`Gagal memanggil API embedding (${embModel}): ${err.message || String(err)}.\nPeriksa endpoint Base URL, API Key, atau ganti embedding model ke "local" jika endpoint tidak mendukung embeddings.`);
    }
}
async function listAllIndexedGuidelines() {
    const config = await (0, config_js_1.loadConfig)();
    if (config.dbType === 'qdrant') {
        try {
            const { client, collection } = await getQdrantClient();
            const points = await client.scroll(collection, { limit: 500, with_payload: true });
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
async function insertChunks(chunks) {
    if (chunks.length === 0) {
        return { insertedCount: 0, duplicateCount: 0, skippedTitles: [] };
    }
    const config = await (0, config_js_1.loadConfig)();
    if (config.dbType === 'qdrant') {
        const { client, collection } = await getQdrantClient();
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
        // Pemicu update cache lokal setelah admin ingest
        await (0, updater_js_1.syncGuidelinesRules)({ force: true, quiet: true });
        return {
            insertedCount: uniqueChunks.length,
            duplicateCount: skippedTitles.length,
            skippedTitles,
        };
    }
    // Local LanceDB fallback
    const db = await getDb();
    const tableNames = await db.tableNames();
    let existingRecords = [];
    let table = null;
    if (tableNames.includes(TABLE_NAME)) {
        table = await db.openTable(TABLE_NAME);
        existingRecords = await table.query().toArray();
    }
    const existingHashes = new Set(existingRecords.map((r) => r.contentHash || (0, dedup_js_1.getNormHash)(r.content || '')));
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
    const records = uniqueChunks.map((chunk, i) => ({
        id: chunk.id,
        source: chunk.source,
        title: chunk.title,
        content: chunk.content,
        contentHash: (0, dedup_js_1.getNormHash)(chunk.content),
        vector: vectors[i],
    }));
    if (!table) {
        table = await db.createTable(TABLE_NAME, records);
    }
    else {
        await table.add(records);
    }
    return {
        insertedCount: uniqueChunks.length,
        duplicateCount: skippedTitles.length,
        skippedTitles,
    };
}
async function insertGuideline(title, content, source = 'manual') {
    const chunk = {
        id: String(Math.floor(Math.random() * 1000000000)),
        source,
        title,
        content,
    };
    return await insertChunks([chunk]);
}
/**
 * Cari guideline relevan.
 * Mode Qdrant otomatis memanfaatkan Auto-Synced Rules Cache & Lexical Matching (0 external embedding call).
 */
async function searchRelevantGuidelines(query, limit = 5) {
    const config = await (0, config_js_1.loadConfig)();
    if (config.dbType === 'qdrant') {
        try {
            // Ambil rules dari cache lokal / auto-sync patch terbaru
            let allRules = [];
            const cached = (0, updater_js_1.readCachedRules)();
            if (cached && cached.rules && cached.rules.length > 0) {
                allRules = cached.rules;
            }
            else {
                allRules = await (0, updater_js_1.syncGuidelinesRules)({ quiet: true });
            }
            if (allRules.length === 0) {
                return [];
            }
            // Ranking relevansi kode/scaffold terhadap pasal-pasal
            return (0, matcher_js_1.rankGuidelinesByRelevance)(query, allRules, limit);
        }
        catch (err) {
            const detail = err.data?.status?.error || err.message || String(err);
            console.error(chalk_1.default.red(`\n[Guidelines Rules Error]: ${detail}`));
            return [];
        }
    }
    // Local LanceDB Mode
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
