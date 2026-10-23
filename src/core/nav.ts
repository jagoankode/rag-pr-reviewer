import { ExitPromptError, AbortPromptError } from '@inquirer/core';
import {
  select as inqSelect,
  input as inqInput,
  confirm as inqConfirm,
  password as inqPassword,
} from '@inquirer/prompts';
import chalk from 'chalk';
import * as readline from 'node:readline';

let activeAbortController: AbortController | null = null;
let sigintHandlerInstalled = false;

/**
 * Global SIGINT guard agar Ctrl+C TIDAK PERNAH mematikan aplikasi secara mendadak.
 * - Jika ada proses async/AI berjalan: batalkan (abort) proses tersebut dan kembali ke menu.
 * - Jika sedang di prompt input/select: batalkan prompt dan fallback ke 'back' (kembali ke menu).
 * - Aplikasi HANYA boleh keluar jika user secara eksplisit memilih opsi 'Keluar (Exit)'.
 */
export function initNavigationGuard() {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;

  process.on('SIGINT', () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      console.log(chalk.yellow('\n\n⚠️  [Membatalkan proses yang sedang berjalan... Kembali ke menu]'));
      activeAbortController.abort();
    }
  });
}

export function createProcessAbortController(): AbortController {
  const controller = new AbortController();
  activeAbortController = controller;
  return controller;
}

export function clearActiveAbortController() {
  activeAbortController = null;
}

export function setActiveAbortController(controller: AbortController | null) {
  activeAbortController = controller;
}

export function getActiveAbortSignal(): AbortSignal | undefined {
  return activeAbortController?.signal;
}

export function isAbortTriggered(): boolean {
  return !!activeAbortController?.signal.aborted;
}

function isPromptExitError(err: any): boolean {
  return (
    err instanceof ExitPromptError ||
    err instanceof AbortPromptError ||
    err?.name === 'ExitPromptError' ||
    err?.name === 'AbortPromptError' ||
    err?.message?.includes('force closed') ||
    err?.message?.includes('aborted') ||
    err?.message?.includes('SIGINT') ||
    err?.code === 'ERR_PROMPT_CLOSED'
  );
}

/**
 * Menjalankan prompt dengan deteksi tombol keyboard ESC.
 * Saat tombol Escape ditekan, prompt di-abort seketika dan kembali ke menu.
 */
async function withEscapeHandler<T>(
  promptFn: (signal: AbortSignal) => Promise<T>,
  fallbackValue: T
): Promise<T> {
  const ac = new AbortController();

  const onKeypress = (_ch: any, key: any) => {
    // Hanya tangkap tombol Escape murni (hindari menangkap arrow keys \u001b[A)
    if (
      key &&
      (key.name === 'escape' || (key.sequence === '\u001b' && key.sequence.length === 1))
    ) {
      ac.abort();
    }
  };

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', onKeypress);
  }

  try {
    return await promptFn(ac.signal);
  } catch (err: any) {
    if (isPromptExitError(err)) {
      console.log(chalk.gray('\n[Aksi dibatalkan via Esc, kembali]'));
      return fallbackValue;
    }
    throw err;
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.removeListener('keypress', onKeypress);
    }
  }
}

/**
 * Drop-in safe replacement untuk select() dengan keyboard ESC support
 */
export async function select<T>(
  options: Parameters<typeof inqSelect<T>>[0],
  fallbackValue: T = 'back' as unknown as T
): Promise<T> {
  return withEscapeHandler(
    (signal) => inqSelect<T>(options, { signal }),
    fallbackValue
  );
}

/**
 * Drop-in safe replacement untuk input() dengan keyboard ESC support
 * Tetap menangani ketikan 'b' atau 'back' sebagai sinyal kembali alternatif.
 */
export async function input(
  options: Parameters<typeof inqInput>[0],
  fallbackValue: string = 'back'
): Promise<string> {
  return withEscapeHandler(async (signal) => {
    const val = await inqInput(options, { signal });
    const trimmed = (val || '').trim().toLowerCase();
    if (trimmed === 'b' || trimmed === 'back') {
      return fallbackValue;
    }
    return val;
  }, fallbackValue);
}

/**
 * Drop-in safe replacement untuk confirm() dengan keyboard ESC support
 */
export async function confirm(
  options: Parameters<typeof inqConfirm>[0],
  fallbackValue: boolean = false
): Promise<boolean> {
  return withEscapeHandler(
    (signal) => inqConfirm(options, { signal }),
    fallbackValue
  );
}

/**
 * Drop-in safe replacement untuk password() dengan keyboard ESC support
 */
export async function password(
  options: Parameters<typeof inqPassword>[0],
  fallbackValue: string = 'back'
): Promise<string> {
  return withEscapeHandler(async (signal) => {
    const val = await inqPassword(options, { signal });
    const trimmed = (val || '').trim().toLowerCase();
    if (trimmed === 'b' || trimmed === 'back') {
      return fallbackValue;
    }
    return val;
  }, fallbackValue);
}
