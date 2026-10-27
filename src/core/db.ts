import * as lancedb from '@lancedb/lancedb';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import chalk from 'chalk';
import { DocChunk } from './chunker.js';
import { AppConfig, getActiveAIProvider, loadConfig, getConfigDir } from './config.js';
import { connectionError } from './network.js';
import { createTfIdfIndex } from './local-embedder.js';
import { getNormHash, cosineSimilarity } from './dedup.js';
import { t } from './i18n.js';
import { syncGuidelinesRules, readCachedRules } from './updater.js';
import { rankGuidelinesByRelevance } from './matcher.js';
import { logError, logInfo } from './logger.js';

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
let qdrantInstance: { key: string; client: QdrantClient } | null = null;

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
    return new Error(t('dbNoWriteAccess'));
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
    throw new Error(t('qdrantNotConfigured'));
  }

  const url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : `https://${rawUrl}`;
  const apiKey = config.qdrantApiKey || undefined;

  const parsedUrl = new URL(url);
  const defaultPort = parsedUrl.protocol === 'https:' ? 443 : 80;
  const port = parsedUrl.port ? Number(parsedUrl.port) : defaultPort;

  // Keyed so URL/API key changes saved in the TUI take effect without a restart.
  const key = JSON.stringify([url, apiKey || '']);
  if (qdrantInstance?.key !== key) {
    qdrantInstance = { key, client: new QdrantClient({ url, port, apiKey, checkCompatibility: false }) };
  }
  const client = qdrantInstance.client;

  let collections: Awaited<ReturnType<QdrantClient['getCollections']>>;
  try {
    collections = await client.getCollections();
  } catch (err) {
    throw connectionError('Qdrant', parsedUrl.origin, err);
  }
  const exists = collections.collections.some((c) => c.name === collection);
  if (!exists) {
    const vectorSize = getVectorSize(config);
    await client.createCollection(collection, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    });
  }

  return { client, collection };
}

/** Scrolls every point of a collection; a single scroll only returns one page. */
export async function scrollAllPoints(client: QdrantClient, collection: string): Promise<any[]> {
  const all: any[] = [];
  let offset: string | number | undefined;
  do {
    const page = await client.scroll(collection, { limit: 256, offset, with_payload: true, with_vector: false });
    all.push(...(page.points || []));
    const next = page.next_page_offset;
    offset = typeof next === 'string' || typeof next === 'number' ? next : undefined;
  } while (offset !== undefined);
  return all;
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
    logError('Embedding', err, { model: config.embeddingModel, textsCount: texts.length });
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
      const points = await scrollAllPoints(client, collection);
      return points
        .filter((p: any) => p.payload?.source !== 'system-prompt')
        .map((p: any) => {
          const payload = p.payload as any;
          return {
            id: String(p.id),
            source: payload?.source || 'remote_vps',
            title: payload?.title || 'Untitled',
            content: payload?.content || '',
          };
        });
    } catch (err: any) {
      throw new Error(t('qdrantReadFailed', { message: err.message }));
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

    const existingPoints = await scrollAllPoints(client, collection);
    // Recomputed from content: stored contentHash may come from an older normalization.
    const existingHashes = new Set(existingPoints.map((p: any) => getNormHash(p.payload?.content || '')));

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
      const pointId = typeof chunk.id === 'string' && /^[0-9a-fA-F-]+$/.test(chunk.id)
        ? chunk.id
        : crypto.randomUUID();

      return {
        id: pointId,
        vector: vectors[i],
        payload: {
          originalId: chunk.id || pointId,
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

  const existingHashes = new Set(existingRecords.map((r: any) => getNormHash(r.content || '')));

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
    id: crypto.randomUUID(),
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

    // Only the edited fields change; the rest of the payload (originalId, targetFiles, category, checks, ...) is kept.
    try {
      await client.updateVectors(collection, { wait: true, points: [{ id: pointId, vector: vectors[0] }] });
      await client.setPayload(collection, {
        wait: true,
        points: [pointId],
        payload: {
          source,
          title: newTitle,
          content: newContent,
          contentHash: getNormHash(newContent),
          updated_at: new Date().toISOString(),
        },
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
  const filter = `id = '${id.replace(/'/g, "''")}'`;
  const [row] = await table.query().where(filter).toArray();
  const existing = row?.toJSON?.() ?? row;
  if (!existing) return false;

  const texts = [`${newTitle}\n${newContent}`];
  const vectors = await generateVectors(texts);

  // Hapus lalu masukkan yang baru dengan ID yang sama; kolom lain (mis. checks) dipertahankan.
  await table.delete(filter);
  await table.add([
    {
      ...existing,
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

/**
 * Stores a rule's machine-checkable part (`checks`, `checksComplete`) without touching its text, vector or other fields.
 * `id` is the rule id used in review snapshots: a `doc:` originalId or the point/row id.
 */
export async function setRuleChecks(id: string, checks: unknown[], checksComplete: boolean): Promise<void> {
  const config = await loadConfig();

  if (config.dbType === 'qdrant') {
    const { client, collection } = await getQdrantClient();
    const target = id.startsWith('doc:')
      ? { filter: { must: [{ key: 'originalId', match: { value: id } }] } }
      : { points: [/^[0-9]+$/.test(id) ? Number(id) : id] };
    try {
      await client.setPayload(collection, { wait: true, ...target, payload: { checks, checksComplete, updated_at: new Date().toISOString() } });
    } catch (err: any) {
      throw wrapDbWriteError(err);
    }
    await syncGuidelinesRules({ force: true, quiet: true });
    return;
  }

  // Local LanceDB Mode: checks are kept as a JSON string column.
  const db = await getDb();
  if (!(await db.tableNames()).includes(TABLE_NAME)) throw new Error(t('dbNoTable'));
  const table = await db.openTable(TABLE_NAME);
  const columns = (await table.schema()).fields.map(f => f.name);
  const missing = [
    ...(columns.includes('checks') ? [] : [{ name: 'checks', valueSql: "''" }]),
    ...(columns.includes('checksComplete') ? [] : [{ name: 'checksComplete', valueSql: 'false' }]),
  ];
  if (missing.length) await table.addColumns(missing);
  const where = `id = '${id.replace(/'/g, "''")}'`;
  if (!(await table.countRows(where))) throw new Error(t('ruleNotFound', { id }));
  await table.update({ where, values: { checks: JSON.stringify(checks), checksComplete } });
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
  await table.delete(`id = '${id.replace(/'/g, "''")}'`);
  return true;
}

/**
 * Pencarian khusus Chat Dialog menggunakan Hybrid Matching:
 * Menggabungkan Semantic Vector Search (jika model aktif) dengan Lexical & Synonym Matching,
 * agar pertanyaan bahasa Indonesia seperti "aturan Penamaan fungsi" selalu tepat sasaran 100%.
 */
export async function searchGuidelinesForDialog(
  query: string,
  limit: number = 6
): Promise<DocChunk[]> {
  const config = await loadConfig();

  // 1. Ambil rules dari cache lokal / server Qdrant
  let allRules: DocChunk[] = [];
  const cached = readCachedRules();
  if (cached && cached.rules && cached.rules.length > 0) {
    allRules = cached.rules;
  } else {
    allRules = await syncGuidelinesRules({ quiet: true });
  }

  // 2. Jalankan Lexical & Technical Synonym Matching terlebih dahulu
  const lexicalMatches = rankGuidelinesByRelevance(query, allRules, limit);

  // Jika Qdrant aktif dan ada embedding model terkonfigurasi, coba kombinasikan dengan semantic vector
  if (config.dbType === 'qdrant') {
    try {
      const { client, collection } = await getQdrantClient();
      const collInfo = await client.getCollection(collection);
      const vectorParam = collInfo.config.params.vectors;
      const requiredDim =
        typeof vectorParam === 'object' && vectorParam !== null && 'size' in vectorParam
          ? (vectorParam as any).size
          : 3072;

      // Hanya panggil Qdrant vector search jika BUKAN local dummy vectorizer
      if (config.embeddingModel && config.embeddingModel !== 'local') {
        const vectors = await generateVectors([query], requiredDim);
        const queryVector = vectors[0];

        if (queryVector && queryVector.length > 0) {
          const searchResults = await client.query(collection, {
            query: queryVector,
            limit,
            with_payload: true,
          });

          if (searchResults.points && searchResults.points.length > 0) {
            const vectorMatches = searchResults.points.map((p: any) => ({
              id: String(p.id),
              source: p.payload?.source || 'remote_vps',
              title: p.payload?.title || 'Untitled',
              content: p.payload?.content || '',
            }));

            // Gabungkan kedua hasil (dedup berdasarkan ID) dengan memprioritaskan lexical match yang relevan
            const seen = new Set<string>();
            const combined: DocChunk[] = [];

            for (const r of [...lexicalMatches, ...vectorMatches]) {
              if (!seen.has(r.id)) {
                seen.add(r.id);
                combined.push(r);
              }
            }

            return combined.slice(0, limit);
          }
        }
      }
    } catch (err: any) {
      logError('QdrantDialogSearch', err, { query, limit });
    }
  }

  return lexicalMatches.slice(0, limit);
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
      logError('GuidelinesRules', err, { query, limit });
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

  const toChunk = (row: any): DocChunk => ({ id: row.id, source: row.source, title: row.title, content: row.content });
  const q = query.slice(0, 4000);

  // Stored TF-IDF vectors come from per-ingest vocabularies and are not comparable across ingests,
  // so local mode ranks with one index built over the whole corpus at query time.
  const rankLocally = (): DocChunk[] => {
    const vectorizer = createTfIdfIndex(rows.map((r: any) => `${r.title}\n${r.content}`));
    const qv = vectorizer(q);
    return rows
      .map((r: any) => ({ r, score: cosineSimilarity(qv, vectorizer(`${r.title}\n${r.content}`)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => toChunk(r));
  };

  if (config.provider === '9router' || config.embeddingModel === 'local') return rankLocally();

  let queryVector: number[];
  try {
    const { client, config: aiConfig } = await getActiveAIProvider();
    const { embedding } = await embed({
      model: client.embedding(aiConfig.embeddingModel || 'text-embedding-3-small'),
      value: q,
    });
    queryVector = embedding;
  } catch (err: any) {
    logError('LocalSearchEmbedding', err, { limit });
    return rankLocally();
  }

  const results = await table
    .vectorSearch(queryVector)
    .limit(limit)
    .toArray();

  return results.map(toChunk);
}
