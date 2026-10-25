import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export interface DocChunk {
  id: string;
  source: string;
  title: string;
  content: string;
}

/**
 * Memotong dokumen markdown berdasarkan header (#, ##, ###)
 * agar konteks aturan/guideline tidak terputus di tengah kalimat.
 */
export function chunkMarkdown(content: string, sourcePath: string, sourceCategory?: string): DocChunk[] {
  const lines = content.split('\n');
  const chunks: DocChunk[] = [];
  
  let currentTitle = path.basename(sourcePath, path.extname(sourcePath));
  let currentBuffer: string[] = [];
  const seenIds = new Set<string>();

  // Tentukan kategori source sesuai taksonomi collection baru
  const resolvedSource = sourceCategory || (
    /fe(\.md|-code-convention)?$/i.test(sourcePath) || sourcePath.toLowerCase().includes('convention')
      ? 'code-convention'
      : /^https?:\/\//i.test(sourcePath)
      ? 'www-data'
      : 'code-convention'
  );

  const flush = () => {
    const text = currentBuffer.join('\n').trim();
    if (text.length > 0) {
      const id = `doc:${createHash('sha256').update(JSON.stringify([resolvedSource, path.basename(sourcePath), currentTitle, text])).digest('hex')}`;
      if (seenIds.has(id)) { currentBuffer = []; return; }
      seenIds.add(id);
      chunks.push({
        id,
        source: resolvedSource,
        title: currentTitle,
        content: text,
      });
    }
    currentBuffer = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      flush();
      currentTitle = `${path.basename(sourcePath)} > ${headerMatch[2].trim()}`;
      currentBuffer.push(line);
    } else {
      currentBuffer.push(line);
    }
  }

  flush();
  return chunks;
}

/**
 * Scan direktori secara rekursif untuk mencari file .md / .markdown / .txt
 */
export async function scanDocFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.markdown', '.txt'].includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) {
    results.push(dirPath);
  } else {
    await walk(dirPath);
  }

  return results.sort();
}
