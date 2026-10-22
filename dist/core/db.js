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
exports.insertChunks = insertChunks;
exports.searchRelevantGuidelines = searchRelevantGuidelines;
const lancedb = __importStar(require("@lancedb/lancedb"));
const ai_1 = require("ai");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const config_js_1 = require("./config.js");
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
 * Ingest chunk dokumen ke LanceDB dengan active embedding model
 */
async function insertChunks(chunks) {
    if (chunks.length === 0)
        return 0;
    const db = await getDb();
    const { client, config } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = config.embeddingModel || 'text-embedding-3-small';
    // Buat embeddings
    const { embeddings } = await (0, ai_1.embedMany)({
        model: client.embedding(embModel),
        values: chunks.map((c) => `${c.title}\n${c.content}`),
    });
    const records = chunks.map((chunk, i) => ({
        id: chunk.id,
        source: chunk.source,
        title: chunk.title,
        content: chunk.content,
        vector: embeddings[i],
    }));
    const tableNames = await db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        await table.add(records);
    }
    else {
        await db.createTable(TABLE_NAME, records);
    }
    return records.length;
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
    const { client, config } = await (0, config_js_1.getActiveAIProvider)();
    const embModel = config.embeddingModel || 'text-embedding-3-small';
    // Embed query
    const { embedding } = await (0, ai_1.embed)({
        model: client.embedding(embModel),
        value: query.slice(0, 4000), // Batasi query embedding
    });
    const results = await table
        .vectorSearch(embedding)
        .limit(limit)
        .toArray();
    return results.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        content: row.content,
    }));
}
