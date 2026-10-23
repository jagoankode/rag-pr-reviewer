"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initNavigationGuard = initNavigationGuard;
exports.createProcessAbortController = createProcessAbortController;
exports.clearActiveAbortController = clearActiveAbortController;
exports.setActiveAbortController = setActiveAbortController;
exports.getActiveAbortSignal = getActiveAbortSignal;
exports.isAbortTriggered = isAbortTriggered;
exports.select = select;
exports.input = input;
exports.confirm = confirm;
exports.password = password;
const core_1 = require("@inquirer/core");
const prompts_1 = require("@inquirer/prompts");
const chalk_1 = __importDefault(require("chalk"));
let activeAbortController = null;
let sigintHandlerInstalled = false;
/**
 * Global SIGINT guard agar Ctrl+C TIDAK PERNAH mematikan aplikasi secara mendadak.
 * - Jika ada proses async/AI berjalan: batalkan (abort) proses tersebut dan kembali ke menu.
 * - Jika sedang di prompt input/select: batalkan prompt dan fallback ke 'back' (kembali ke menu).
 * - Aplikasi HANYA boleh keluar jika user secara eksplisit memilih opsi 'Keluar (Exit)'.
 */
function initNavigationGuard() {
    if (sigintHandlerInstalled)
        return;
    sigintHandlerInstalled = true;
    process.on('SIGINT', () => {
        if (activeAbortController && !activeAbortController.signal.aborted) {
            console.log(chalk_1.default.yellow('\n\n⚠️  [Membatalkan proses yang sedang berjalan... Kembali ke menu]'));
            activeAbortController.abort();
        }
    });
}
function createProcessAbortController() {
    const controller = new AbortController();
    activeAbortController = controller;
    return controller;
}
function clearActiveAbortController() {
    activeAbortController = null;
}
function setActiveAbortController(controller) {
    activeAbortController = controller;
}
function getActiveAbortSignal() {
    return activeAbortController?.signal;
}
function isAbortTriggered() {
    return !!activeAbortController?.signal.aborted;
}
function isPromptExitError(err) {
    return (err instanceof core_1.ExitPromptError ||
        err?.name === 'ExitPromptError' ||
        err?.message?.includes('force closed') ||
        err?.message?.includes('SIGINT') ||
        err?.code === 'ERR_PROMPT_CLOSED');
}
/**
 * Drop-in safe replacement untuk select()
 */
async function select(options, fallbackValue = 'back') {
    try {
        return await (0, prompts_1.select)(options);
    }
    catch (err) {
        if (isPromptExitError(err)) {
            console.log(chalk_1.default.gray('\n[Aksi dibatalkan, kembali]'));
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
async function input(options, fallbackValue = 'back') {
    try {
        const val = await (0, prompts_1.input)(options);
        const trimmed = (val || '').trim().toLowerCase();
        if (trimmed === 'b' || trimmed === 'back') {
            return fallbackValue;
        }
        return val;
    }
    catch (err) {
        if (isPromptExitError(err)) {
            console.log(chalk_1.default.gray('\n[Aksi dibatalkan, kembali]'));
            return fallbackValue;
        }
        throw err;
    }
}
/**
 * Drop-in safe replacement untuk confirm()
 */
async function confirm(options, fallbackValue = false) {
    try {
        return await (0, prompts_1.confirm)(options);
    }
    catch (err) {
        if (isPromptExitError(err)) {
            console.log(chalk_1.default.gray('\n[Aksi dibatalkan, kembali]'));
            return fallbackValue;
        }
        throw err;
    }
}
/**
 * Drop-in safe replacement untuk password()
 */
async function password(options, fallbackValue = 'back') {
    try {
        const val = await (0, prompts_1.password)(options);
        const trimmed = (val || '').trim().toLowerCase();
        if (trimmed === 'b' || trimmed === 'back') {
            return fallbackValue;
        }
        return val;
    }
    catch (err) {
        if (isPromptExitError(err)) {
            console.log(chalk_1.default.gray('\n[Aksi dibatalkan, kembali]'));
            return fallbackValue;
        }
        throw err;
    }
}
