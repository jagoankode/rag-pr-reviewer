import { ExitPromptError } from '@inquirer/core';
import {
  select as inqSelect,
  input as inqInput,
  confirm as inqConfirm,
  password as inqPassword,
} from '@inquirer/prompts';
import chalk from 'chalk';

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
    err?.name === 'ExitPromptError' ||
    err?.message?.includes('force closed') ||
    err?.message?.includes('SIGINT') ||
    err?.code === 'ERR_PROMPT_CLOSED'
  );
}

/**
 * Drop-in safe replacement untuk select()
 */
export async function select<T>(
  options: Parameters<typeof inqSelect<T>>[0],
  fallbackValue: T = 'back' as unknown as T
): Promise<T> {
  try {
    return await inqSelect<T>(options);
  } catch (err: any) {
    if (isPromptExitError(err)) {
      console.log(chalk.gray('\n[Aksi dibatalkan, kembali]'));
      return fallbackValue;
    }
    throw err;
  }
}

/**
 * Drop-in safe replacement untuk input()
 * Menangani ketikan 'b' atau 'back' sebagai sinyal kembali,
 * serta menangkap Ctrl+C secara elegan.
 */
export async function input(
  options: Parameters<typeof inqInput>[0],
  fallbackValue: string = 'back'
): Promise<string> {
  try {
    const val = await inqInput(options);
    const trimmed = (val || '').trim().toLowerCase();
    if (trimmed === 'b' || trimmed === 'back') {
      return fallbackValue;
    }
    return val;
  } catch (err: any) {
    if (isPromptExitError(err)) {
      console.log(chalk.gray('\n[Aksi dibatalkan, kembali]'));
      return fallbackValue;
    }
    throw err;
  }
}

/**
 * Drop-in safe replacement untuk confirm()
 */
export async function confirm(
  options: Parameters<typeof inqConfirm>[0],
  fallbackValue: boolean = false
): Promise<boolean> {
  try {
    return await inqConfirm(options);
  } catch (err: any) {
    if (isPromptExitError(err)) {
      console.log(chalk.gray('\n[Aksi dibatalkan, kembali]'));
      return fallbackValue;
    }
    throw err;
  }
}

/**
 * Drop-in safe replacement untuk password()
 */
export async function password(
  options: Parameters<typeof inqPassword>[0],
  fallbackValue: string = 'back'
): Promise<string> {
  try {
    const val = await inqPassword(options);
    const trimmed = (val || '').trim().toLowerCase();
    if (trimmed === 'b' || trimmed === 'back') {
      return fallbackValue;
    }
    return val;
  } catch (err: any) {
    if (isPromptExitError(err)) {
      console.log(chalk.gray('\n[Aksi dibatalkan, kembali]'));
      return fallbackValue;
    }
    throw err;
  }
}
