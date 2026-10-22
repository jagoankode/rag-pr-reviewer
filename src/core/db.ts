import * as lancedb from '@lancedb/lancedb';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import { DocChunk } from './chunker.js';
import { getActiveAIProvider } from './config.js';

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
 * Ingest chunk dokumen ke LanceDB dengan active embedding model
 */
export async function insertChunks(chunks: DocChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  const db = await getDb();
  const { client, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

  // Buat embeddings
  const { embeddings } = await embedMany({
    model: client.embedding(embModel),
    values: chunks.map((c) => `${c.title}\n${c.content}`),
  });

  const records: GuidelineRecord[] = chunks.map((chunk, i) => ({
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
  } else {
    await db.createTable(TABLE_NAME, records);
  }

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
  const { client, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

  // Embed query
  const { embedding } = await embed({
    model: client.embedding(embModel),
    value: query.slice(0, 4000), // Batasi query embedding
  });

  const results = await table
    .vectorSearch(embedding)
    .limit(limit)
    .toArray();

  return results.map((row: any) => ({
    id: row.id,
    source: row.source,
    title: row.title,
    content: row.content,
  }));
}
