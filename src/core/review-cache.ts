import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { getConfigDir } from './config.js';
import { FileAudit, AIScope } from './review-engine.js';
import { ReviewInput } from './review-input.js';
import { RuleSnapshot } from './review-rules.js';
import { REVIEW_ENGINE_VERSION } from './review-snapshot.js';
import { HYBRID_AUDIT_PROMPT } from './review-prompt.js';
import { LineViolationSchema } from './schema.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const AuditSchema = z.object({
  file: z.string(), complete: z.literal(true), notes: z.array(z.string()).optional(),
  violations: z.array(LineViolationSchema.extend({ id: z.string(), ruleId: z.string(), column: z.number().int().positive(),
    check: z.string(), engine: z.enum(['ast', 'filesystem', 'ai']) })),
  coverage: z.array(z.object({ ruleId: z.string(), file: z.string(), status: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']), reason: z.string() })),
});
const EntrySchema = z.object({ version: z.literal(1), key: z.string(), createdAt: z.number(), audit: AuditSchema });

export interface CacheContext { model: string; provider: string; baseUrl: string; language: string; aiScope: AIScope; }

export function reviewCacheKey(input: ReviewInput, rules: RuleSnapshot, context: CacheContext): string {
  return createHash('sha256').update(JSON.stringify({
    engine: REVIEW_ENGINE_VERSION, prompt: HYBRID_AUDIT_PROMPT, rules: rules.hash, ...context,
    file: input.file, content: input.content, folderFiles: [...input.folderFiles].sort(),
    addedLines: [...input.addedLines].sort((a,b) => a-b), diff: input.diff, scope: input.scope,
    error: input.error, skipped: input.skipped,
  })).digest('hex');
}

/** Cache failures are misses. Only fully verified file audits are persisted, without source/config credentials. */
export class ReviewCache {
  hits = 0;
  misses = 0;
  private writes: Promise<void> = Promise.resolve();
  // Bytes/entries on disk as of the last scan plus this run's writes; undefined until the first scan.
  private usage?: { bytes: number; entries: number };
  constructor(private directory = path.join(getConfigDir(), 'cache', 'reviews'),
    private maxAgeMs = 7 * DAY, private maxBytes = 50 * 1024 * 1024, private now = Date.now) {}

  async get(key: string): Promise<FileAudit | undefined> {
    try {
      const file = path.join(this.directory, `${key}.json`);
      const size = (await fs.stat(file)).size;
      if (size > MAX_ENTRY_BYTES) throw new Error('Oversized cache entry');
      const entry = EntrySchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      const age = this.now() - entry.createdAt;
      if (entry.key !== key || age < 0 || age > this.maxAgeMs) throw new Error('Expired cache entry');
      this.hits++;
      return entry.audit;
    } catch { this.misses++; return undefined; }
  }

  async put(key: string, audit: FileAudit): Promise<void> {
    if (audit.skipped || !AuditSchema.safeParse(audit).success) return;
    const data = JSON.stringify({ version: 1, key, createdAt: this.now(), audit });
    if (Buffer.byteLength(data) > Math.min(MAX_ENTRY_BYTES, this.maxBytes)) return;
    // Serialize writes/pruning in this process; atomic rename also protects concurrent CLI readers.
    const write = async () => {
      const temp = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
      try {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, path.join(this.directory, `${key}.json`));
        // Scan the directory once per run, then again only when tracked usage passes a limit.
        if (this.usage) { this.usage.bytes += Buffer.byteLength(data); this.usage.entries++; }
        if (!this.usage || this.usage.bytes > this.maxBytes || this.usage.entries > MAX_ENTRIES) this.usage = await this.prune();
      } catch { await fs.unlink(temp).catch(() => {}); }
    };
    this.writes = this.writes.then(write, write);
    await this.writes;
  }

  private async prune(): Promise<{ bytes: number; entries: number }> {
    const entries = await Promise.all((await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const file = path.join(this.directory, name);
      try { const stat = await fs.stat(file); return { file, size: stat.size, modified: stat.mtimeMs }; }
      catch { return undefined; }
    }));
    const sorted = entries.filter(e => e !== undefined).sort((a,b) => b.modified - a.modified);
    let bytes = 0, kept = 0;
    for (const entry of sorted) {
      if (this.now() - entry.modified > this.maxAgeMs || bytes + entry.size > this.maxBytes || kept >= MAX_ENTRIES) {
        await fs.unlink(entry.file).catch(() => {});
      } else { bytes += entry.size; kept++; }
    }
    return { bytes, entries: kept };
  }
}
