import * as lancedb from '@lancedb/lancedb';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createOpenAI } from '@ai-sdk/openai';
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

function wrapDbWriteError(err: any): Error {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || err?.data?.status?.error || err || '');
  if (status === 401 || status === 403 || /unauthorized|forbidden|permission denied/i.test(msg)) {
    return new Error('Anda tidak dapat menambah atau mengubah aturan tim.');
  }
  return err instanceof Error ? err : new Error(String(err));
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

  const parsedUrl = new URL(url);
  const defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
  const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;

  if (!qdrantInstance) {
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

async function resolveEmbeddingClient(config: AppConfig) {
  // 1. Cek apakah ada provider sumopod terdaftar untuk embedding
  const sumopod = config.providers?.sumopod;
  if (sumopod && sumopod.apiKey) {
    const rawBase = sumopod.baseUrl || 'https://ai.sumopod.com';
    const baseURL = rawBase.endsWith('/v1') ? rawBase : `${rawBase.replace(/\/+$/, '')}/v1`;
    const model = sumopod.models?.[0] || 'text-embedding-3-large';
    const client = createOpenAI({
      apiKey: sumopod.apiKey,
      baseURL,
    });
    return { client, model };
  }

  // 2. Cek embeddingApiKey & embeddingBaseUrl eksplisit
  if (config.embeddingApiKey) {
    const rawBase = config.embeddingBaseUrl || 'https://api.openai.com/v1';
    const baseURL = rawBase.endsWith('/v1') ? rawBase : `${rawBase.replace(/\/+$/, '')}/v1`;
    const model = config.embeddingModel && config.embeddingModel !== 'local'
      ? config.embeddingModel
      : 'text-embedding-3-large';
    const client = createOpenAI({
      apiKey: config.embeddingApiKey,
      baseURL,
    });
    return { client, model };
  }

  // 3. Fallback ke getActiveAIProvider
  const { embeddingClient, config: aiConfig } = await getActiveAIProvider();
  return {
    client: embeddingClient,
    model: aiConfig.embeddingModel || 'local',
  };
}

async function generateVectors(texts: string[], targetDimensions?: number): Promise<number[][]> {
  const config = await loadConfig();
  const dimensions = targetDimensions || getVectorSize(config);

  try {
    const { client, model } = await resolveEmbeddingClient(config);

    if (model && model !== 'local') {
      const embeddingPromise = embedMany({
        model: client.embedding(model),
        values: texts,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timeout memanggil endpoint embedding ${model} (12 detik)`));
        }, 12000);
      });

      const { embeddings } = await Promise.race([embeddingPromise, timeoutPromise]);
      return embeddings;
    }
  } catch (err: any) {
    console.warn(`\n⚠️  Model/Endpoint embedding tidak merespons: ${err.message}.`);
    console.warn('⚡ Mengalihkan ke local text vectorizer...');
  }

  // Local TF-IDF Fallback
  const vectorizer = createTfIdfIndex(texts, dimensions);
  return texts.map((t) => vectorizer(t));
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

    const collInfo = await client.getCollection(collection);
    const vectorParam = collInfo.config.params.vectors;
    const requiredDim =
      typeof vectorParam === 'object' && vectorParam !== null && 'size' in vectorParam
        ? (vectorParam as any).size
        : 3072;

    const texts = uniqueChunks.map((c) => `${c.title}\n${c.content}`);
    const vectors = await generateVectors(texts, requiredDim);

    const points = uniqueChunks.map((chunk, i) => {
      const nowIso = new Date().toISOString();
      return {
        id: typeof chunk.id === 'string' && /^[0-9a-fA-F-]+$/.test(chunk.id) ? chunk.id : Math.floor(Math.random() * 1000000000),
        vector: vectors[i],
        payload: {
          originalId: chunk.id,
          source: chunk.source,
          title: chunk.title,
          content: chunk.content,
          contentHash: getNormHash(chunk.content),
          status: 'ACTIVE',
          created_at: nowIso,
          updated_at: nowIso,
        },
      };
    });

    try {
      await client.upsert(collection, {
        wait: true,
        points,
      });
    } catch (err: any) {
      throw wrapDbWriteError(err);
    }

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

export async function updateGuideline(
  id: string,
  newTitle: string,
  newContent: string,
  source: string = 'manual_update'
): Promise<boolean> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    const { client, collection } = await getQdrantClient();
    const collInfo = await client.getCollection(collection);
    const vectorParam = collInfo.config.params.vectors;
    const requiredDim =
      typeof vectorParam === 'object' && vectorParam !== null && 'size' in vectorParam
        ? (vectorParam as any).size
        : 3072;

    const texts = [`${newTitle}\n${newContent}`];
    const vectors = await generateVectors(texts, requiredDim);

    const pointId = /^[0-9]+$/.test(id) ? Number(id) : id;

    try {
      await client.upsert(collection, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: vectors[0],
            payload: {
              originalId: id,
              source,
              title: newTitle,
              content: newContent,
              contentHash: getNormHash(newContent),
              status: 'ACTIVE',
              updated_at: new Date().toISOString(),
            },
          },
        ],
      });
    } catch (err: any) {
      throw wrapDbWriteError(err);
    }

    await syncGuidelinesRules({ force: true, quiet: true });
    return true;
  }

  // Local LanceDB Mode
  const db = await getDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return false;
  }

  const table = await db.openTable(TABLE_NAME);
  // Hapus lalu masukkan yang baru dengan ID yang sama
  await table.delete(`id = '${id}'`);

  const texts = [`${newTitle}\n${newContent}`];
  const vectors = await generateVectors(texts);

  await table.add([
    {
      id,
      source,
      title: newTitle,
      content: newContent,
      contentHash: getNormHash(newContent),
      vector: vectors[0],
    },
  ]);

  return true;
}

export async function deleteGuideline(id: string): Promise<boolean> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    const { client, collection } = await getQdrantClient();
    const pointId = /^[0-9]+$/.test(id) ? Number(id) : id;

    try {
      await client.delete(collection, {
        wait: true,
        points: [pointId],
      });
    } catch (err: any) {
      throw wrapDbWriteError(err);
    }

    await syncGuidelinesRules({ force: true, quiet: true });
    return true;
  }

  // Local LanceDB Mode
  const db = await getDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return false;
  }

  const table = await db.openTable(TABLE_NAME);
  await table.delete(`id = '${id}'`);
  return true;
}

/**
 * Pencarian khusus Chat Dialog menggunakan Semantic Vector Search Qdrant murni.
 * Memahami sinonim & bahasa alami (Indonesia/Inggris) tanpa perlu kamus manual.
 * Otomatis fallback ke cache lokal jika server Qdrant tidak terjangkau.
 */
export async function searchGuidelinesForDialog(
  query: string,
  limit: number = 4
): Promise<DocChunk[]> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      const collInfo = await client.getCollection(collection);
      const vectorParam = collInfo.config.params.vectors;
      const requiredDim =
        typeof vectorParam === 'object' && vectorParam !== null && 'size' in vectorParam
          ? (vectorParam as any).size
          : 3072;

      // Generate query embedding vector
      const vectors = await generateVectors([query], requiredDim);
      const queryVector = vectors[0];

      if (queryVector && queryVector.length > 0) {
        const searchResults = await client.query(collection, {
          query: queryVector,
          limit,
          with_payload: true,
        });

        if (searchResults.points && searchResults.points.length > 0) {
          return searchResults.points.map((p: any) => ({
            id: String(p.id),
            source: p.payload?.source || 'remote_vps',
            title: p.payload?.title || 'Untitled',
            content: p.payload?.content || '',
          }));
        }
      }
    } catch (err: any) {
      // Fallback ke local cache jika koneksi Qdrant gagal
    }
  }

  // Fallback standar ke cache lokal
  return searchRelevantGuidelines(query, limit);
}

/**
 * Cari guideline relevan untuk Review PR.
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
