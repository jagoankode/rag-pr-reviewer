import chalk from 'chalk';
import ora from 'ora';
import {
  input,
  createProcessAbortController,
  clearActiveAbortController,
} from '../core/nav.js';
import { loadConfig } from '../core/config.js';
import { callLLM } from '../core/llm-client.js';
import { searchGuidelinesForDialog, listAllIndexedGuidelines } from '../core/db.js';
import { getDynamicDialogPromptTemplate } from '../core/prompt-manager.js';
import { getAppVersion } from '../core/version.js';
import { logError } from '../core/logger.js';

/**
 * Membersihkan syntax markdown agar tampil bersih dan rapi di terminal CLI.
 */
function formatForTerminal(text: string): string {
  if (!text) return '';
  let res = text;

  // 1. Ubah fenced code blocks (```lang ... ```) jadi baris teks berindentasi 2 spasi
  res = res.replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, (_, code) => {
    const lines = code.trim().split('\n').map((l: string) => `  ${l}`);
    return `\n${lines.join('\n')}\n`;
  });

  // 2. Hapus markdown bold & italic (**teks**, __teks__, *teks*, _teks_)
  res = res.replace(/\*\*([^*]+)\*\*/g, '$1');
  res = res.replace(/__([^_]+)__/g, '$1');
  res = res.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  res = res.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

  // 3. Hapus inline code backticks (`kode` -> kode)
  res = res.replace(/`([^`\n]+)`/g, '$1');

  // 4. Hapus markdown headers (#, ##, ###)
  res = res.replace(/^#+\s+/gm, '');

  // 5. Rapikan baris kosong berlebih
  res = res.replace(/\n{3,}/g, '\n\n');

  return res.trim();
}

export async function runInteractiveKnowledgeDialog(): Promise<void> {
  const config = await loadConfig();
  const modelName = config.defaultModel || 'ag/gemini-3.8-flash';
  const version = getAppVersion();
  const termW = Math.max(60, Math.min(90, process.stdout.columns || 80));

  console.clear();
  console.log(`${chalk.bold.hex('#F59E0B')('✨ Lumio')} ${chalk.gray(`v${version}`)} ${chalk.gray('›')} ${chalk.bold.cyan('Tanya Aturan Tim')}`);
  console.log(chalk.gray('Tanyakan apa saja seputar panduan atau aturan tim • Tekan Esc untuk kembali\n'));
  console.log(`${chalk.gray('─'.repeat(termW))}\n`);

  // Riwayat obrolan dalam sesi ini
  const chatHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];

  while (true) {
    const userPrompt = await input({
      message: `${chalk.bold.cyan('👤 Anda')} ${chalk.gray('›')}`,
      hideEscHint: true,
      theme: {
        prefix: '',
        style: {
          answer: (text: string) => chalk.white(text),
        },
      },
    });

    const cleaned = userPrompt.trim();
    if (
      !cleaned ||
      cleaned.toLowerCase() === 'exit' ||
      cleaned.toLowerCase() === 'b' ||
      cleaned.toLowerCase() === 'back'
    ) {
      console.log(chalk.gray('\nKembali ke menu utama.\n'));
      break;
    }

    const spinner = ora(chalk.gray('Mencari aturan terkait... (Ctrl+C untuk batalkan)')).start();
    const chatAbortController = createProcessAbortController();

    try {
      const relevantChunks = await searchGuidelinesForDialog(cleaned, 4);

      if (chatAbortController.signal.aborted) {
        spinner.info(chalk.yellow('\nProses dibatalkan.'));
        clearActiveAbortController();
        continue;
      }

      if (relevantChunks.length === 0) {
        spinner.stop();
        clearActiveAbortController();
        console.log(`\n${chalk.bold.hex('#F59E0B')('✨ Lumio')} ${chalk.gray('›')} ${chalk.white('Saya belum mempunyai informasi mengenai aturan itu.')}\n`);

        chatHistory.push({ role: 'user', text: cleaned });
        chatHistory.push({ role: 'assistant', text: 'Saya belum mempunyai informasi mengenai aturan itu.' });
        continue;
      }

      // Ambil seluruh daftar judul aturan untuk referensi ringkas AI jika ditanya hal umum
      const allGuidelines = await listAllIndexedGuidelines();
      const allTitlesSummary = allGuidelines.map((g, i) => `${i + 1}. ${g.title}`).join('\n');

      const knowledgeContext = relevantChunks
        .map((c) => `[Judul: ${c.title} | Source: ${c.source}]\n${c.content}`)
        .join('\n\n---\n\n');

      const dialogTemplate = await getDynamicDialogPromptTemplate();
      const systemPrompt = dialogTemplate
        .replace('{{ALL_TITLES_SUMMARY}}', allTitlesSummary || '(Belum ada aturan yang tersimpan)')
        .replace('{{KNOWLEDGE_CONTEXT}}', knowledgeContext);

      const historyPrompt = chatHistory.length > 0
        ? `Riwayat percakapan:\n${chatHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}\n\nPertanyaan baru:\n${cleaned}`
        : cleaned;

      const fullPrompt = `${systemPrompt}\n\n${historyPrompt}`;
      let answer = '';
      try {
        answer = await callLLM(fullPrompt, modelName, chatAbortController.signal);
      } catch (callErr: any) {
        if (chatAbortController.signal.aborted || callErr.name === 'AbortError') {
          spinner.info(chalk.yellow('\nPertanyaan dibatalkan.'));
          continue;
        }
        throw callErr;
      } finally {
        clearActiveAbortController();
      }

      spinner.stop();

      const cleanedAnswer = formatForTerminal(answer);
      console.log(`\n${chalk.bold.hex('#F59E0B')('✨ Lumio')} ${chalk.gray('›')} ${chalk.white(cleanedAnswer)}\n`);

      chatHistory.push({ role: 'user', text: cleaned });
      chatHistory.push({ role: 'assistant', text: cleanedAnswer });

      if (relevantChunks.length > 0) {
        const titles = relevantChunks.map((c) => c.title).join(', ');
        console.log(chalk.gray(`   └─ 📌 Sumber: ${titles}\n`));
      }
    } catch (err: any) {
      if (chatAbortController.signal.aborted || err.name === 'AbortError') {
        spinner.info(chalk.yellow('\nProses dibatalkan oleh pengguna.'));
      } else {
        spinner.fail(chalk.red(`Error: ${err.message}`));
        logError('InteractiveDialog', err, { userPrompt: cleaned });
      }
      console.log('');
    } finally {
      clearActiveAbortController();
    }
  }
}
