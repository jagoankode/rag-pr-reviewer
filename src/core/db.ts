import * as lancedb from '@lancedb/lancedb';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import { DocChunk } from './chunker.js';
import { getActiveAIProvider } from './config.js';
import { createTfIdfIndex } from './local-embedder.js';

const DB_DIR = path.join(os.homedir(), '.pr-rag', 'db');
const TABLE_NAME = 'guidelines';

export interface GuidelineRecord {
  id: string;
  source: string;
  title: string;
  content: string;
  vector: number[];
  [key: string]: unknown;
}

let dbInstance: lancedb.Connection | null = null;

export async function getDb(): Promise<lancedb.Connection> {
  if (!dbInstance) {
    dbInstance = await lancedb.connect(DB_DIR);
  }
  return dbInstance;
}

/**
 * Mengambil semua daftar guidelines/aturan yang tersimpan di LanceDB
 */
export async function listAllIndexedGuidelines(): Promise<{ id: string; source: string; title: string; content: string }[]> {
  const db = await getDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return [];
  }
  const table = await db.openTable(TABLE_NAME);
  const rows = await table.query().toArray();
  return rows.map((r: any) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    content: r.content,
  }));
}

/**
 * Generate embeddings: coba via API provider dulu,
 * jika provider tidak punya endpoint embedding (seperti 9router/chat-only gateway),
 * fallback otomatis ke high-speed local embedding vectorizer (Zero-Failure).
 */
async function generateVectors(
  texts: string[]
): Promise<number[][]> {
  const { client, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

  // Jika provider adalah 9router atau model yang tidak punya embedding endpoint
  if (config.provider === '9router' || embModel === 'local') {
    const vectorizer = createTfIdfIndex(texts);
    return texts.map((t) => vectorizer(t));
  }

  try {
    const { embeddings } = await embedMany({
      model: client.embedding(embModel),
      values: texts,
    });
    return embeddings;
  } catch (err: any) {
    // Fallback otomatis ke local semantic vectorizer jika API provider menolak / tidak support embedding
    const vectorizer = createTfIdfIndex(texts);
    return texts.map((t) => vectorizer(t));
  }
}

/**
 * Ingest chunk dokumen ke LanceDB
 */
export async function insertChunks(chunks: DocChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  const db = await getDb();
  const texts = chunks.map((c) => `${c.title}\n${c.content}`);
  const vectors = await generateVectors(texts);

  const records: GuidelineRecord[] = chunks.map((chunk, i) => ({
    id: chunk.id,
    source: chunk.source,
    title: chunk.title,
    content: chunk.content,
    vector: vectors[i],
  }));

  const tableNames = await db.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    // Drop dan replace table agar dimensi vector selalu sinkron dan fresh
    await db.dropTable(TABLE_NAME);
  }
  await db.createTable(TABLE_NAME, records);

  return records.length;
}

/**
 * Mencari context guidelines yang paling relevan dengan query/diff
 */
export async function searchRelevantGuidelines(
  query: string,
  limit: number = 5
): Promise<DocChunk[]> {
  const db = await getDb();
  const tableNames = await db.tableNames();

  if (!tableNames.includes(TABLE_NAME)) {
    return [];
  }

  const table = await db.openTable(TABLE_NAME);
  const rows = await table.query().toArray();
  if (rows.length === 0) return [];

  // Ambil semua corpus untuk membangun vectorizer query yang cocok
  const corpus = rows.map((r: any) => `${r.title}\n${r.content}`);
  const { client, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

  let queryVector: number[];
  if (config.provider === '9router' || embModel === 'local') {
    const vectorizer = createTfIdfIndex(corpus);
    queryVector = vectorizer(query.slice(0, 4000));
  } else {
    try {
      const { embedding } = await embed({
        model: client.embedding(embModel),
        value: query.slice(0, 4000),
      });
      queryVector = embedding;
    } catch {
      const vectorizer = createTfIdfIndex(corpus);
      queryVector = vectorizer(query.slice(0, 4000));
    }
  }

  const results = await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();

  return results.map((row: any) => ({
    id: row.id,
    source: row.source,
    title: row.title,
    content: row.content,
  }));
}
