import * as lancedb from '@lancedb/lancedb';
import { QdrantClient } from '@qdrant/js-client-rest';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import { DocChunk } from './chunker.js';
import { getActiveAIProvider, loadConfig, getConfigDir } from './config.js';
import { createTfIdfIndex } from './local-embedder.js';
import { getNormHash } from './dedup.js';

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

export async function getQdrantClient(): Promise<{ client: QdrantClient; collection: string }> {
  const config = await loadConfig();
  let rawUrl = (config.qdrantUrl || 'https://knowlage.jagoankode.site').trim();
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `https://${rawUrl}`;
  }
  const url = rawUrl;
  const apiKey = config.qdrantApiKey || undefined;
  const collection = config.qdrantCollection || 'guidelines';

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

async function generateVectors(texts: string[]): Promise<number[][]> {
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

export async function listAllIndexedGuidelines(): Promise<{ id: string; source: string; title: string; content: string }[]> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      const points = await client.scroll(collection, { limit: 100, with_payload: true });
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

    return {
      insertedCount: points.length,
      duplicateCount: skippedTitles.length,
      skippedTitles,
    };
  }

  const db = await getDb();
  const tableNames = await db.tableNames();
  let existingRecords: any[] = [];
  let tableHasContentHash = false;

  if (tableNames.includes(TABLE_NAME)) {
    const table = await db.openTable(TABLE_NAME);
    existingRecords = await table.query().toArray();
    try {
      const tblSchema = await table.schema();
      tableHasContentHash = tblSchema.fields.some((f: any) => f.name === 'contentHash');
    } catch {
      tableHasContentHash = false;
    }
  }

  const existingHashes = new Set(
    existingRecords.map((r: any) => r.contentHash || getNormHash(r.content))
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

  const newRecords: GuidelineRecord[] = uniqueChunks.map((chunk, i) => {
    const rec: GuidelineRecord = {
      id: chunk.id,
      source: chunk.source,
      title: chunk.title,
      content: chunk.content,
      vector: vectors[i],
    };
    if (!tableNames.includes(TABLE_NAME) || tableHasContentHash) {
      rec.contentHash = getNormHash(chunk.content);
    }
    return rec;
  });

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

export async function searchRelevantGuidelines(
  query: string,
  limit: number = 5
): Promise<DocChunk[]> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      const points = await client.scroll(collection, { limit: 100, with_payload: true });
      if (points.points.length === 0) return [];

      const corpus = points.points.map((p: any) => `${p.payload?.title}\n${p.payload?.content}`);
      let queryVector: number[];

      if (config.provider === '9router' || config.embeddingModel === 'local') {
        const vectorizer = createTfIdfIndex(corpus);
        queryVector = vectorizer(query.slice(0, 4000));
      } else {
        const { client: aiClient } = await getActiveAIProvider();
        const embModel = config.embeddingModel || 'text-embedding-3-small';
        try {
          const { embedding } = await embed({
            model: aiClient.embedding(embModel),
            value: query.slice(0, 4000),
          });
          queryVector = embedding;
        } catch {
          const vectorizer = createTfIdfIndex(corpus);
          queryVector = vectorizer(query.slice(0, 4000));
        }
      }

      const searchResults = await client.query(collection, {
        query: queryVector,
        limit,
        score_threshold: 0.05,
        with_payload: true,
      });

      return searchResults.points.map((res: any) => ({
        id: String(res.id),
        source: res.payload?.source || 'remote_vps',
        title: res.payload?.title || 'Untitled',
        content: res.payload?.content || '',
      }));
    } catch {
      return [];
    }
  }

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
