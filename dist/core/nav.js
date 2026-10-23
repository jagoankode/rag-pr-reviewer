"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
const readline = __importStar(require("node:readline"));
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
        err instanceof core_1.AbortPromptError ||
        err?.name === 'ExitPromptError' ||
        err?.name === 'AbortPromptError' ||
        err?.message?.includes('force closed') ||
        err?.message?.includes('aborted') ||
        err?.message?.includes('SIGINT') ||
        err?.code === 'ERR_PROMPT_CLOSED');
}
/**
 * Menjalankan prompt dengan deteksi tombol keyboard ESC.
 * Saat tombol Escape ditekan, prompt di-abort seketika dan kembali ke menu.
 */
async function withEscapeHandler(promptFn, fallbackValue) {
    const ac = new AbortController();
    const onKeypress = (_ch, key) => {
        // Hanya tangkap tombol Escape murni (hindari menangkap arrow keys \u001b[A)
        if (key &&
            (key.name === 'escape' || (key.sequence === '\u001b' && key.sequence.length === 1))) {
            ac.abort();
        }
    };
    if (process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.on('keypress', onKeypress);
    }
    try {
        return await promptFn(ac.signal);
    }
    catch (err) {
        if (isPromptExitError(err)) {
            console.log(chalk_1.default.gray('\n[Aksi dibatalkan via Esc, kembali]'));
            return fallbackValue;
        }
        throw err;
    }
    finally {
        if (process.stdin.isTTY) {
            process.stdin.removeListener('keypress', onKeypress);
        }
    }
}
/**
 * Drop-in safe replacement untuk select() dengan keyboard ESC support
 */
async function select(options, fallbackValue = 'back') {
    return withEscapeHandler((signal) => (0, prompts_1.select)(options, { signal }), fallbackValue);
}
/**
 * Drop-in safe replacement untuk input() dengan keyboard ESC support
 * Tetap menangani ketikan 'b' atau 'back' sebagai sinyal kembali alternatif.
 */
async function input(options, fallbackValue = 'back') {
    return withEscapeHandler(async (signal) => {
        const val = await (0, prompts_1.input)(options, { signal });
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
async function confirm(options, fallbackValue = false) {
    return withEscapeHandler((signal) => (0, prompts_1.confirm)(options, { signal }), fallbackValue);
}
/**
 * Drop-in safe replacement untuk password() dengan keyboard ESC support
 */
async function password(options, fallbackValue = 'back') {
    return withEscapeHandler(async (signal) => {
        const val = await (0, prompts_1.password)(options, { signal });
        const trimmed = (val || '').trim().toLowerCase();
        if (trimmed === 'b' || trimmed === 'back') {
            return fallbackValue;
        }
        return val;
    }, fallbackValue);
}
