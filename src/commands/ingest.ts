import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { scanDocFiles, chunkMarkdown, DocChunk } from '../core/chunker.js';
import { insertChunks, InsertResult } from '../core/db.js';
import { createProcessAbortController, clearActiveAbortController } from '../core/nav.js';
import { t } from '../core/i18n.js';
import { logError } from '../core/logger.js';

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
    const spinner = ora(chalk.blue(t('ingestFetchingUrl', { url: trimmed }))).start();
    try {
      const { title, content } = await fetchUrlContent(trimmed, abortController.signal);
      const chunks = chunkMarkdown(content, trimmed);

      if (abortController.signal.aborted) {
        spinner.info(chalk.yellow(`\n${t('ingestUrlCancelled')}`));
        return false;
      }

      if (chunks.length === 0) {
        spinner.warn(chalk.yellow(t('ingestUrlEmpty')));
        return false;
      }

      spinner.text = chalk.cyan(t('ingestSavingChunks'));
      const result: InsertResult = await insertChunks(chunks);

      if (result.insertedCount === 0 && result.duplicateCount > 0) {
        spinner.info(
          chalk.yellow(t('ingestUrlAllDuplicate', { count: result.duplicateCount }))
        );
      } else {
        spinner.succeed(
          chalk.green(
            t('ingestUrlSaved', { count: result.insertedCount }) +
              (result.duplicateCount > 0
                ? chalk.gray(t('ingestDuplicatesRejected', { count: result.duplicateCount }))
                : '')
          )
        );
      }
      return true;
    } catch (error: any) {
      if (abortController.signal.aborted || error.name === 'AbortError') {
        spinner.info(chalk.yellow(`\n${t('ingestUrlCancelledByUser')}`));
        return false;
      }
      logError('IngestUrl', error, { url: trimmed });
      spinner.fail(chalk.red(t('ingestUrlFailed', { message: error.message })));
      return false;
    } finally {
      clearActiveAbortController();
    }
  }

  const resolvedPath = resolveUserPath(targetPath);
  const spinner = ora(chalk.blue(t('ingestScanning', { path: resolvedPath }))).start();

  try {
    const files = await scanDocFiles(resolvedPath);
    if (abortController.signal.aborted) {
      spinner.info(chalk.yellow(`\n${t('ingestScanCancelled')}`));
      return false;
    }

    if (files.length === 0) {
      spinner.warn(chalk.yellow(t('ingestNoFiles', { path: resolvedPath })));
      return false;
    }

    spinner.text = chalk.blue(t('ingestReading', { count: files.length }));

    let allChunks: DocChunk[] = [];
    for (const file of files) {
      if (abortController.signal.aborted) {
        spinner.info(chalk.yellow(`\n${t('ingestReadCancelled')}`));
        return false;
      }
      const content = await fs.readFile(file, 'utf-8');
      const chunks = chunkMarkdown(content, file);
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) {
      spinner.warn(chalk.yellow(t('ingestEmpty')));
      return false;
    }

    spinner.text = chalk.cyan(t('ingestSavingChunks'));
    const result: InsertResult = await insertChunks(allChunks);

    if (result.insertedCount === 0 && result.duplicateCount > 0) {
      spinner.info(
        chalk.yellow(t('ingestAllDuplicate', { count: result.duplicateCount }))
      );
    } else {
      spinner.succeed(
        chalk.green(
          t('ingestSaved', { count: result.insertedCount }) +
            (result.duplicateCount > 0
              ? chalk.gray(t('ingestDuplicatesRejected', { count: result.duplicateCount }))
              : '')
        )
      );
    }
    return true;
  } catch (error: any) {
    if (abortController.signal.aborted || error.name === 'AbortError') {
      spinner.info(chalk.yellow(`\n${t('ingestCancelledByUser')}`));
      return false;
    }
    logError('IngestFiles', error, { path: resolvedPath });
    spinner.fail(chalk.red(t('ingestFailed', { message: error.message })));
    return false;
  } finally {
    clearActiveAbortController();
  }
}

/**
 * Ingest aturan langsung lewat percakapan/input teks bebas
 */
export async function ingestDirectRuleCommand(title: string, content: string): Promise<boolean> {
  const spinner = ora(chalk.blue(t('ingestRuleSaving'))).start();

  try {
    const chunk: DocChunk = {
      id: `rule_${Date.now()}`,
      source: 'addon-knowledge',
      title: title.trim(),
      content: content.trim(),
    };

    const result = await insertChunks([chunk]);

    if (result.insertedCount === 0) {
      spinner.info(chalk.yellow(t('ingestRuleDuplicate')));
    } else {
      spinner.succeed(chalk.green(t('ingestRuleSaved', { title })));
    }
    return true;
  } catch (error: any) {
    logError('IngestRule', error, { title });
    spinner.fail(chalk.red(t('ingestRuleFailed', { message: error.message })));
    return false;
  }
}
