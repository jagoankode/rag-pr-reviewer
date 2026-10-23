import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { scanDocFiles, chunkMarkdown, DocChunk } from '../core/chunker.js';
import { insertChunks, InsertResult } from '../core/db.js';

export function resolveUserPath(inputPath: string): string {
  let cleaned = inputPath.trim();
  if (cleaned.startsWith('~/') || cleaned === '~') {
    cleaned = path.join(os.homedir(), cleaned.slice(1));
  }
  return path.resolve(process.cwd(), cleaned);
}

export async function ingestCommand(targetPath: string): Promise<boolean> {
  const resolvedPath = resolveUserPath(targetPath);
  const spinner = ora(chalk.blue(`Scanning files at: ${resolvedPath}...`)).start();

  try {
    const files = await scanDocFiles(resolvedPath);
    if (files.length === 0) {
      spinner.warn(chalk.yellow(`Tidak ditemukan file dokumen (.md, .txt) di: ${resolvedPath}`));
      return false;
    }

    spinner.text = chalk.blue(`Membaca dan memotong dokumen dari ${files.length} file...`);

    let allChunks: DocChunk[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const chunks = chunkMarkdown(content, file);
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) {
      spinner.warn(chalk.yellow('File kosong atau teks tidak cukup panjang untuk di-chunk.'));
      return false;
    }

    spinner.text = chalk.cyan(`Memeriksa duplikasi & menyimpan chunks baru ke LanceDB...`);
    const result: InsertResult = await insertChunks(allChunks);

    if (result.insertedCount === 0 && result.duplicateCount > 0) {
      spinner.info(
        chalk.yellow(`Semua (${result.duplicateCount}) aturan sudah ada di LanceDB (ditolak agar tidak duplikat).`)
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
    spinner.fail(chalk.red(`Gagal meng-ingest dokumen: ${error.message}`));
    return false;
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
