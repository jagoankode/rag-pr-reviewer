import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { scanDocFiles, chunkMarkdown } from '../core/chunker.js';
import { insertChunks } from '../core/db.js';

export function resolveUserPath(inputPath: string): string {
  let cleaned = inputPath.trim();
  if (cleaned.startsWith('~/') || cleaned === '~') {
    cleaned = path.join(os.homedir(), cleaned.slice(1));
  }
  return path.resolve(process.cwd(), cleaned);
}

export async function ingestCommand(targetPath: string) {
  const resolvedPath = resolveUserPath(targetPath);
  const spinner = ora(chalk.blue(`Scanning files at: ${resolvedPath}...`)).start();

  try {
    const files = await scanDocFiles(resolvedPath);
    if (files.length === 0) {
      spinner.warn(chalk.yellow(`Tidak ditemukan file markdown/dokumen di: ${resolvedPath}`));
      return;
    }

    spinner.text = chalk.blue(`Membaca dan memotong dokumen dari ${files.length} file...`);
    
    let allChunks = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const chunks = chunkMarkdown(content, file);
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) {
      spinner.warn(chalk.yellow('File kosong atau teks tidak cukup panjang untuk di-chunk.'));
      return;
    }

    spinner.text = chalk.cyan(`Membuat embeddings & menyimpan ${allChunks.length} chunks ke LanceDB...`);
    const count = await insertChunks(allChunks);

    spinner.succeed(chalk.green(`Berhasil meng-ingest ${count} chunks ke vector database lokal!`));
  } catch (error: any) {
    spinner.fail(chalk.red(`Gagal meng-ingest dokumen: ${error.message}`));
    process.exit(1);
  }
}
