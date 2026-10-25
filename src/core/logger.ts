import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { getConfigDir } from './config.js';

let loggerInstance: pino.Logger | null = null;

export function getLogFilePath(): string {
  const dir = path.join(getConfigDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'lumio.log');
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    const logFile = getLogFilePath();
    const destination = pino.destination({
      dest: logFile,
      sync: false, // Async for performance
      mkdir: true,
    });

    loggerInstance = pino(
      {
        level: process.env.LUMIO_LOG_LEVEL || 'info',
        timestamp: pino.stdTimeFunctions.isoTime,
        base: { pid: process.pid },
      },
      destination
    );
  }
  return loggerInstance;
}

export function logError(context: string, error: unknown, extra?: Record<string, unknown>) {
  try {
    const logger = getLogger();
    const errObj = error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : { message: String(error) };

    logger.error({ context, err: errObj, ...extra });
  } catch {
    // Fail-safe: logger error never crashes the app
  }
}

export function logInfo(context: string, message: string, extra?: Record<string, unknown>) {
  try {
    const logger = getLogger();
    logger.info({ context, message, ...extra });
  } catch {}
}

export async function readRecentLogs(maxLines: number = 50): Promise<string[]> {
  const file = getLogFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const content = await fs.promises.readFile(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export async function clearAllLogs(): Promise<boolean> {
  const file = getLogFilePath();
  try {
    if (fs.existsSync(file)) {
      await fs.promises.truncate(file, 0);
    }
    return true;
  } catch {
    return false;
  }
}
