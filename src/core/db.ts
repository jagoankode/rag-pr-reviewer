import * as lancedb from '@lancedb/lancedb';
import { QdrantClient } from '@qdrant/js-client-rest';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { DocChunk } from './chunker.js';
import { getActiveAIProvider, loadConfig, getConfigDir } from './config.js';
import { createTfIdfIndex } from './local-embedder.js';
import { getNormHash } from './dedup.js';
import { syncGuidelinesRules, readCachedRules } from './updater.js';
import { rankGuidelinesByRelevance } from './matcher.js';

const TABLE_NAME = 'guidelines';

export interface GuidelineRecord {
  id: string;
  source: string;
  title: string;
  content: string;
  contentHash?: string;
  vector: number[];
  [key: string]: unknown;
}

let dbInstance: lancedb.Connection | null = null;
let qdrantInstance: QdrantClient | null = null;

export async function getDb(): Promise<lancedb.Connection> {
  if (!dbInstance) {
    const dbDir = path.join(getConfigDir(), 'db');
    dbInstance = await lancedb.connect(dbDir);
  }
  return dbInstance;
}

export function getVectorSize(config: { provider?: string; embeddingModel?: string }): number {
  if (config.provider === '9router' || config.embeddingModel === 'local') {
    return 256;
  }
  const model = (config.embeddingModel || '').toLowerCase();
  if (model.includes('large') || model.includes('3072')) {
    return 3072;
  }
  return 1536;
}

export async function getQdrantClient(): Promise<{ client: QdrantClient; collection: string }> {
  const config = await loadConfig();
  const rawUrl = (config.qdrantUrl || '').trim();
  const collection = (config.qdrantCollection || '').trim();

  if (!rawUrl || !collection) {
    throw new Error(
      'Qdrant URL dan Collection belum diset! Silakan konfigurasi via TUI (`lumio` -> "Database Storage Mode") sebelum menjalankan operasi database.'
    );
  }

  const url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
  const apiKey = config.qdrantApiKey || undefined;

  if (!qdrantInstance) {
    const parsedUrl = new URL(url);
    const defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
    const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;

    qdrantInstance = new QdrantClient({
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

async function generateVectors(texts: string[]): Promise<number[][]> {
  const { embeddingClient, config } = await getActiveAIProvider();
  const embModel = config.embeddingModel || 'text-embedding-3-small';

  if (config.provider === '9router' || embModel === 'local') {
    const vectorizer = createTfIdfIndex(texts);
    return texts.map((t) => vectorizer(t));
  }

  try {
    const { embeddings } = await embedMany({
      model: embeddingClient.embedding(embModel),
      values: texts,
    });
    return embeddings;
  } catch (err: any) {
    throw new Error(
      `Gagal memanggil API embedding (${embModel}): ${err.message || String(err)}.\nPeriksa endpoint Base URL, API Key, atau ganti embedding model ke "local" jika endpoint tidak mendukung embeddings.`
    );
  }
}

export interface InsertResult {
  insertedCount: number;
  duplicateCount: number;
  skippedTitles: string[];
}

export async function listAllIndexedGuidelines(): Promise<{ id: string; source: string; title: string; content: string }[]> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      const points = await client.scroll(collection, { limit: 500, with_payload: true });
      return points.points.map((p) => {
        const payload = p.payload as any;
        return {
          id: String(p.id),
          source: payload?.source || 'remote_vps',
          title: payload?.title || 'Untitled',
          content: payload?.content || '',
        };
      });
    } catch (err: any) {
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
  return rows.map((r: any) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    content: r.content,
  }));
}

export async function insertChunks(chunks: DocChunk[]): Promise<InsertResult> {
  if (chunks.length === 0) {
    return { insertedCount: 0, duplicateCount: 0, skippedTitles: [] };
  }

  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    const { client, collection } = await getQdrantClient();

    const existingPoints = await client.scroll(collection, { limit: 1000, with_payload: true });
    const existingHashes = new Set(
      existingPoints.points.map((p: any) => p.payload?.contentHash || getNormHash(p.payload?.content || ''))
    );

    const uniqueChunks: DocChunk[] = [];
    const skippedTitles: string[] = [];

    for (const chunk of chunks) {
      const hash = getNormHash(chunk.content);
      if (existingHashes.has(hash)) {
        skippedTitles.push(chunk.title);
      } else {
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
        contentHash: getNormHash(chunk.content),
      },
    }));

    await client.upsert(collection, {
      wait: true,
      points,
    });

    // Pemicu update cache lokal setelah admin ingest
    await syncGuidelinesRules({ force: true, quiet: true });

    return {
      insertedCount: uniqueChunks.length,
      duplicateCount: skippedTitles.length,
      skippedTitles,
    };
  }

  // Local LanceDB fallback
  const db = await getDb();
  const tableNames = await db.tableNames();

  let existingRecords: any[] = [];
  let table: lancedb.Table | null = null;

  if (tableNames.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
    existingRecords = await table.query().toArray();
  }

  const existingHashes = new Set(
    existingRecords.map((r: any) => r.contentHash || getNormHash(r.content || ''))
  );

  const uniqueChunks: DocChunk[] = [];
  const skippedTitles: string[] = [];

  for (const chunk of chunks) {
    const hash = getNormHash(chunk.content);
    if (existingHashes.has(hash)) {
      skippedTitles.push(chunk.title);
    } else {
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

  const records: GuidelineRecord[] = uniqueChunks.map((chunk, i) => ({
    id: chunk.id,
    source: chunk.source,
    title: chunk.title,
    content: chunk.content,
    contentHash: getNormHash(chunk.content),
    vector: vectors[i],
  }));

  if (!table) {
    table = await db.createTable(TABLE_NAME, records);
  } else {
    await table.add(records);
  }

  return {
    insertedCount: uniqueChunks.length,
    duplicateCount: skippedTitles.length,
    skippedTitles,
  };
}

export async function insertGuideline(
  title: string,
  content: string,
  source: string = 'manual'
): Promise<InsertResult> {
  const chunk: DocChunk = {
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
export async function searchRelevantGuidelines(
  query: string,
  limit: number = 5
): Promise<DocChunk[]> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      // Ambil rules dari cache lokal / auto-sync patch terbaru
      let allRules: DocChunk[] = [];
      const cached = readCachedRules();
      if (cached && cached.rules && cached.rules.length > 0) {
        allRules = cached.rules;
      } else {
        allRules = await syncGuidelinesRules({ quiet: true });
      }

      if (allRules.length === 0) {
        return [];
      }

      // Ranking relevansi kode/scaffold terhadap pasal-pasal
      return rankGuidelinesByRelevance(query, allRules, limit);
    } catch (err: any) {
      const detail = err.data?.status?.error || err.message || String(err);
      console.error(chalk.red(`\n[Guidelines Rules Error]: ${detail}`));
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
  if (rows.length === 0) return [];

  const corpus = rows.map((r: any) => `${r.title}\n${r.content}`);
  const { client, config: aiConfig } = await getActiveAIProvider();
  const embModel = aiConfig.embeddingModel || 'text-embedding-3-small';

  let queryVector: number[];
  if (aiConfig.provider === '9router' || embModel === 'local') {
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
