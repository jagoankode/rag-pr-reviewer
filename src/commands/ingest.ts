import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { scanDocFiles, chunkMarkdown, DocChunk } from '../core/chunker.js';
import { insertChunks, InsertResult } from '../core/db.js';
import { createProcessAbortController, clearActiveAbortController } from '../core/nav.js';

export function resolveUserPath(inputPath: string): string {
  let cleaned = inputPath.trim();
  if (cleaned.startsWith('~/') || cleaned === '~') {
    cleaned = path.join(os.homedir(), cleaned.slice(1));
  }
  return path.resolve(process.cwd(), cleaned);
}

export function isWebUrl(input: string): boolean {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed);
}

export async function fetchUrlContent(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LumioBot/2.0; +https://github.com/jagoankode/rag-pr-reviewer)',
      'Accept': 'text/plain, text/markdown, text/html, application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const text = await res.text();
  const parsedUrl = new URL(url);
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const title = pathParts.length > 0 ? pathParts[pathParts.length - 1] : parsedUrl.hostname;

  return { title, content: text };
}

export async function ingestCommand(targetPath: string): Promise<boolean> {
  const trimmed = targetPath.trim();
  const isUrl = isWebUrl(trimmed);
  const abortController = createProcessAbortController();

  if (isUrl) {
    const spinner = ora(chalk.blue(`Mengambil konten dokumen dari URL: ${trimmed}... (Ctrl+C untuk batalkan)`)).start();
    try {
      const { title, content } = await fetchUrlContent(trimmed, abortController.signal);
      const chunks = chunkMarkdown(content, trimmed);

      if (abortController.signal.aborted) {
        spinner.info(chalk.yellow('\nProses ingest URL dibatalkan.'));
        return false;
      }

      if (chunks.length === 0) {
        spinner.warn(chalk.yellow('Konten dari URL kosong atau teks tidak cukup panjang untuk diproses.'));
        return false;
      }

      spinner.text = chalk.cyan(`Memeriksa duplikasi & menyimpan chunks baru...`);
      const result: InsertResult = await insertChunks(chunks);

      if (result.insertedCount === 0 && result.duplicateCount > 0) {
        spinner.info(
          chalk.yellow(`Semua (${result.duplicateCount}) aturan dari URL sudah ada di database (ditolak agar tidak duplikat).`)
        );
      } else {
        spinner.succeed(
          chalk.green(
            `Berhasil meng-ingest ${result.insertedCount} aturan baru dari URL!` +
              (result.duplicateCount > 0
                ? chalk.gray(` (${result.duplicateCount} aturan duplikat ditolak/dilewati)`)
                : '')
          )
        );
      }
      return true;
    } catch (error: any) {
      if (abortController.signal.aborted || error.name === 'AbortError') {
        spinner.info(chalk.yellow('\nProses ingest URL dibatalkan oleh pengguna.'));
        return false;
      }
      spinner.fail(chalk.red(`Gagal meng-ingest dokumen dari URL: ${error.message}`));
      return false;
    } finally {
      clearActiveAbortController();
    }
  }

  const resolvedPath = resolveUserPath(targetPath);
  const spinner = ora(chalk.blue(`Scanning files at: ${resolvedPath}... (Ctrl+C untuk batalkan)`)).start();

  try {
    const files = await scanDocFiles(resolvedPath);
    if (abortController.signal.aborted) {
      spinner.info(chalk.yellow('\nProses scanning dokumen dibatalkan.'));
      return false;
    }

    if (files.length === 0) {
      spinner.warn(chalk.yellow(`Tidak ditemukan file dokumen (.md, .txt) di: ${resolvedPath}`));
      return false;
    }

    spinner.text = chalk.blue(`Membaca dan memotong dokumen dari ${files.length} file...`);

    let allChunks: DocChunk[] = [];
    for (const file of files) {
      if (abortController.signal.aborted) {
        spinner.info(chalk.yellow('\nProses membaca dokumen dibatalkan.'));
        return false;
      }
      const content = await fs.readFile(file, 'utf-8');
      const chunks = chunkMarkdown(content, file);
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) {
      spinner.warn(chalk.yellow('File kosong atau teks tidak cukup panjang untuk di-chunk.'));
      return false;
    }

    spinner.text = chalk.cyan(`Memeriksa duplikasi & menyimpan chunks baru...`);
    const result: InsertResult = await insertChunks(allChunks);

    if (result.insertedCount === 0 && result.duplicateCount > 0) {
      spinner.info(
        chalk.yellow(`Semua (${result.duplicateCount}) aturan sudah ada di database (ditolak agar tidak duplikat).`)
      );
    } else {
      spinner.succeed(
        chalk.green(
          `Berhasil menyimpan ${result.insertedCount} aturan baru!` +
            (result.duplicateCount > 0
              ? chalk.gray(` (${result.duplicateCount} aturan duplikat ditolak/dilewati)`)
              : '')
        )
      );
    }
    return true;
  } catch (error: any) {
    if (abortController.signal.aborted || error.name === 'AbortError') {
      spinner.info(chalk.yellow('\nProses ingest dibatalkan oleh pengguna.'));
      return false;
    }
    spinner.fail(chalk.red(`Gagal meng-ingest dokumen: ${error.message}`));
    return false;
  } finally {
    clearActiveAbortController();
  }
}

/**
 * Ingest aturan langsung lewat percakapan/input teks bebas
 */
export async function ingestDirectRuleCommand(title: string, content: string): Promise<boolean> {
  const spinner = ora(chalk.blue('Memeriksa duplikasi & menyimpan aturan baru ke LanceDB...')).start();

  try {
    const chunk: DocChunk = {
      id: `rule_${Date.now()}`,
      source: 'manual_conversation',
      title: title.trim(),
      content: content.trim(),
    };

    const result = await insertChunks([chunk]);

    if (result.insertedCount === 0) {
      spinner.info(chalk.yellow(`Aturan serupa sudah tersimpan sebelumnya (ditolak agar tidak duplikat).`));
    } else {
      spinner.succeed(chalk.green(`Aturan "${title}" berhasil disimpan ke knowledge RAG!`));
    }
    return true;
  } catch (error: any) {
    spinner.fail(chalk.red(`Gagal menyimpan aturan: ${error.message}`));
    return false;
  }
}
