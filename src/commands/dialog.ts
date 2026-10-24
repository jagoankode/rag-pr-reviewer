import chalk from 'chalk';
import ora from 'ora';
import {
  select,
  input,
  createProcessAbortController,
  clearActiveAbortController,
} from '../core/nav.js';
import { loadConfig } from '../core/config.js';
import { callLLM } from '../core/llm-client.js';
import { searchRelevantGuidelines, listAllIndexedGuidelines, insertChunks } from '../core/db.js';
import { DocChunk } from '../core/chunker.js';

/**
 * Interactive 2-Way Conversational Dialog with RAG Knowledge Base.
 * - STRICT GROUNDING: AI hanya menjawab berdasarkan apa yang ada di LanceDB.
 * - Jika ilmu belum ada di database, AI WAJIB menyatakan tidak tahu / belum terdaftar.
 * - User bisa mengobrol, bertanya isi aturan, atau mengajari aturan baru langsung di dalam chat.
 */
export async function runInteractiveKnowledgeDialog(): Promise<void> {
  const config = await loadConfig();
  const modelName = config.defaultModel || 'ag/gemini-3.8-flash';

  console.clear();
  console.log(chalk.bold.cyan('══════════════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.yellow('💬 Mode Obrolan Interaktif RAG (Strict Grounded Knowledge)'));
  console.log(chalk.gray('• Tanyakan aturan tim (misal: "Apakah kamu punya aturan tentang type?")'));
  console.log(chalk.gray('• AI HANYA menjawab apa yang ada di database RAG lokal.'));
  console.log(chalk.gray('• Ajarkan aturan baru secara langsung di obrolan ini.'));
  console.log(chalk.gray('• Tekan Esc kapan saja untuk kembali ke Menu Utama.'));
  console.log(chalk.bold.cyan('══════════════════════════════════════════════════════════════════════\n'));

  // Riwayat obrolan dalam sesi ini
  const chatHistory: Array<{ role: 'user' | 'assistant'; text: string }> = [];

  while (true) {
    const userPrompt = await input({
      message: chalk.bold.green('Anda :'),
    });

    const cleaned = userPrompt.trim();
    if (
      !cleaned ||
      cleaned.toLowerCase() === 'exit' ||
      cleaned.toLowerCase() === 'b' ||
      cleaned.toLowerCase() === 'back'
    ) {
      console.log(chalk.gray('\nKeluar dari mode dialog.\n'));
      break;
    }

    const spinner = ora(chalk.blue('Mengecek database pengetahuan RAG... (Ctrl+C untuk batalkan)')).start();
    const chatAbortController = createProcessAbortController();

    try {
      const relevantChunks = await searchRelevantGuidelines(cleaned, 4);

      if (chatAbortController.signal.aborted) {
        spinner.info(chalk.yellow('\nProses dibatalkan.'));
        clearActiveAbortController();
        continue;
      }

      if (relevantChunks.length === 0) {
        spinner.stop();
        clearActiveAbortController();
        console.log(`\n${chalk.bold.cyan('RAG  :')} ${chalk.white('Saya belum mempunyai pengetahuan itu.')}\n`);

        chatHistory.push({ role: 'user', text: cleaned });
        chatHistory.push({ role: 'assistant', text: 'Saya belum mempunyai pengetahuan itu.' });
        continue;
      }

      // Ambil seluruh daftar judul aturan untuk referensi ringkas AI jika ditanya hal umum
      const allGuidelines = await listAllIndexedGuidelines();
      const allTitlesSummary = allGuidelines.map((g, i) => `${i + 1}. ${g.title}`).join('\n');

      const knowledgeContext = relevantChunks
        .map((c) => `[Judul: ${c.title} | Source: ${c.source}]\n${c.content}`)
        .join('\n\n---\n\n');

      const systemPrompt = `You are the strict, honest Guardian of Internal Coding Conventions.
You are in a direct 2-way conversation with a software developer in a terminal TUI chat.

CRITICAL DIRECTIVES:
1. STRICT ZERO-ASSUMPTION GROUNDING: You ONLY answer based on the STORED CONVENTIONS provided below.
2. If the user asks about any topic, rule, syntax, or convention that is NOT explicitly found in the STORED CONVENTIONS below:
   - YOU MUST ANSWER EXACTLY: "Saya belum mempunyai pengetahuan itu."
   - DO NOT make up conventions. DO NOT guess. DO NOT give general internet/community knowledge.
3. If the user asks whether you have a rule about something (e.g. "Apakah kamu punya aturan tentang type?"):
   - Answer directly based on the stored conventions, explain the relevant rule, and reference the rule title.
4. CHAT STYLE & FORMATTING (TERMINAL FRIENDLY):
   - DO NOT use heavy markdown such as markdown headers (#, ##, ###), bold wrappers everywhere, or markdown tables.
   - Answer in natural, friendly, direct conversational Indonesian.
   - Use clean, simple bullet points (•) to summarize the specific points or rules asked.
   - Keep answers compact, concise, and easy to read in a CLI terminal.

=== DAFTAR ATURAN YANG SUDAH TERDAFTAR DI RAG ===
${allTitlesSummary || '(Belum ada aturan yang tersimpan)'}

=== ISI DETAIL ATURAN YANG RELEVAN DARI DATABASE (TRUTH) ===
${knowledgeContext}
============================================================
`;

      // Sertakan riwayat obrolan sesi singkat
      const historyPrompt = chatHistory.length > 0
        ? `Riwayat obrolan sebelumnya:\n${chatHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}\n\nPertanyaan user saat ini:\n${cleaned}`
        : cleaned;

      const fullPrompt = `${systemPrompt}\n\n${historyPrompt}`;
      let answer = '';
      try {
        answer = await callLLM(fullPrompt, modelName, chatAbortController.signal);
      } catch (callErr: any) {
        if (chatAbortController.signal.aborted || callErr.name === 'AbortError') {
          spinner.info(chalk.yellow('\nPertanyaan dibatalkan oleh pengguna.'));
          continue;
        }
        throw callErr;
      } finally {
        clearActiveAbortController();
      }

      spinner.stop();

      console.log(`\n${chalk.bold.cyan('RAG  :')} ${chalk.white(answer)}\n`);

      // Simpan ke history sesi
      chatHistory.push({ role: 'user', text: cleaned });
      chatHistory.push({ role: 'assistant', text: answer });

      // Jika jawaban relevan berasal dari dokumen
      if (relevantChunks.length > 0) {
        console.log(chalk.gray(`📌 Terkait ${relevantChunks.length} aturan:`));
        relevantChunks.forEach((c) => console.log(chalk.gray(`   • ${c.title}`)));
        console.log('');
      }
    } catch (err: any) {
      if (chatAbortController.signal.aborted || err.name === 'AbortError') {
        spinner.info(chalk.yellow('\nProses dibatalkan oleh pengguna.'));
      } else {
        spinner.fail(chalk.red(`Error: ${err.message}`));
      }
      console.log('');
    } finally {
      clearActiveAbortController();
    }
  }
}
