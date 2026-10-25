import { createHash } from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { AppConfig } from './config.js';
import { getDb } from './db.js';

export interface ReviewRule { id: string; source: string; title: string; content: string; status?: string; }
export interface RuleSnapshot { readonly rules: readonly Readonly<ReviewRule>[]; readonly hash: string; }
export function snapshotRules(rows: ReviewRule[]): RuleSnapshot {
  const rules = rows.filter(r => r.source !== 'system-prompt' && (!r.status || r.status === 'ACTIVE'))
    .map(r => ({ id: String(r.id), source: r.source, title: r.title, content: r.content }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (rules.some(r => !r.id || !r.title || !r.content) || new Set(rules.map(r => r.id)).size !== rules.length)
    throw new Error('Invalid or duplicate rule identity in snapshot');
  return Object.freeze({ rules: Object.freeze(rules.map(r => Object.freeze(r))), hash: createHash('sha256').update(JSON.stringify(rules)).digest('hex') });
}
/** Read-only and exhaustive. No collection creation, sync writes or silently stale cache fallback. */
export async function loadReviewRules(config: AppConfig): Promise<RuleSnapshot> {
  if (config.dbType !== 'qdrant') {
    const db = await getDb();
    if (!(await db.tableNames()).includes('guidelines')) return snapshotRules([]);
    return snapshotRules(await (await db.openTable('guidelines')).query().toArray());
  }
  if (!config.qdrantUrl || !config.qdrantCollection) throw new Error('Rule database is not configured');
  const url = new URL(/^https?:/.test(config.qdrantUrl) ? config.qdrantUrl : `https://${config.qdrantUrl}`);
  const client = new QdrantClient({ url: url.toString(), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), apiKey: config.qdrantApiKey || undefined, checkCompatibility: false });
  const rows: ReviewRule[] = [];
  let offset: string | number | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.scroll(config.qdrantCollection, { limit: 256, offset, with_payload: true, with_vector: false });
    for (const p of page.points) {
      // New content-addressed ingestion IDs survive independent DB imports. Legacy backend IDs remain compatible.
      const originalId = p.payload?.originalId;
      const id = typeof originalId === 'string' && originalId.startsWith('doc:') ? originalId : String(p.id);
      rows.push({ ...p.payload, id } as unknown as ReviewRule);
    }
    const next = page.next_page_offset;
    if (next != null && typeof next !== 'string' && typeof next !== 'number') throw new Error('Unsupported pagination cursor');
    offset = next ?? undefined;
    if (offset !== undefined) {
      if (seen.has(String(offset))) throw new Error('Repeated rule pagination cursor');
      seen.add(String(offset));
    }
  } while (offset !== undefined);
  return snapshotRules(rows);
}
