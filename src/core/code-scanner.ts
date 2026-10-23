import { promises as fs } from 'fs';
import path from 'path';

export interface CodeFileContext {
  relativePath: string;
  absolutePath: string;
  ext: string;
  content: string;
}

const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.java', '.kt', '.rs', '.php',
  '.cs', '.rb', '.sql'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  '.rag-reviews', '.openclaw', '.cache', 'coverage',
  'vendor', '__pycache__', '.venv', '.idea', '.vscode'
]);

/**
 * Scan folder fitur/layer lokal dan baca isi source code (dibatasi agar efisien & hemat token)
 */
export async function scanFeatureCodeFiles(
  targetPath: string,
  maxFiles: number = 20,
  maxBytesPerFile: number = 30000
): Promise<CodeFileContext[]> {
  const files: CodeFileContext[] = [];

  async function walk(currentDir: string) {
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > 0 && stat.size <= maxBytesPerFile) {
              const content = await fs.readFile(fullPath, 'utf-8');
              const relPath = path.relative(targetPath, fullPath);
              files.push({
                relativePath: relPath || entry.name,
                absolutePath: fullPath,
                ext,
                content,
              });
            }
          } catch {
            // Abaikan file yang gagal dibaca
          }
        }
      }
    }
  }

  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    const content = await fs.readFile(targetPath, 'utf-8');
    files.push({
      relativePath: path.basename(targetPath),
      absolutePath: targetPath,
      ext: path.extname(targetPath).toLowerCase(),
      content,
    });
  } else {
    await walk(targetPath);
  }

  return files;
}
