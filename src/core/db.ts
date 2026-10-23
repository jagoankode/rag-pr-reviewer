import * as lancedb from '@lancedb/lancedb';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import { DocChunk } from './chunker.js';
import { getActiveAIProvider } from './config.js';
import { createTfIdfIndex } from './local-embedder.js';
import { getNormHash, cosineSimilarity } from './dedup.js';

const DB_DIR = path.join(os.homedir(), '.pr-rag', 'db');
const TABLE_NAME = 'guidelines';

export interface GuidelineRecord {
  id: string;
  source: string;
  title: string;
  content: string;
  contentHash: string;
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
 * Generate embeddings untuk array teks
 */
async function generateVectors(
  texts: string[]
): Promise<number[][]> {
  const { client, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

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
  } catch {
    const vectorizer = createTfIdfIndex(texts);
    return texts.map((t) => vectorizer(t));
  }
}

export interface InsertResult {
  insertedCount: number;
  duplicateCount: number;
  skippedTitles: string[];
}

/**
 * Ingest chunk dokumen / knowledge ke LanceDB dengan DEDUP (anti duplikat):
 * Menolak aturan/pengetahuan yang sudah ada (berdasarkan exact hash atau semantic similarity > 0.95)
 */
export async function insertChunks(chunks: DocChunk[]): Promise<InsertResult> {
  if (chunks.length === 0) {
    return { insertedCount: 0, duplicateCount: 0, skippedTitles: [] };
  }

  const db = await getDb();
  const tableNames = await db.tableNames();
  let existingRecords: any[] = [];

  if (tableNames.includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME);
    existingRecords = await table.query().toArray();
  }

  const existingHashes = new Set(existingRecords.map((r: any) => r.contentHash || getNormHash(r.content)));

  // Filter 1: Cek duplikat teks persis (Normalized SHA-256 Hash)
  const uniqueChunks: DocChunk[] = [];
  const skippedTitles: string[] = [];

  for (const chunk of chunks) {
    const hash = getNormHash(chunk.content);
    if (existingHashes.has(hash)) {
      skippedTitles.push(chunk.title);
    } else {
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

  const newRecords: GuidelineRecord[] = uniqueChunks.map((chunk, i) => ({
    id: chunk.id,
    source: chunk.source,
    title: chunk.title,
    content: chunk.content,
    contentHash: getNormHash(chunk.content),
    vector: vectors[i],
  }));

  if (tableNames.includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME);
    await table.add(newRecords);
  } else {
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
export async function ingestDirectKnowledge(
  title: string,
  content: string,
  source: string = 'interactive_conversation'
): Promise<InsertResult> {
  const chunk: DocChunk = {
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
