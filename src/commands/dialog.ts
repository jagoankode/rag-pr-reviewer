import chalk from 'chalk';
import ora from 'ora';
import { select, input } from '../core/nav.js';
import { generateText } from 'ai';
import { getActiveAIProvider } from '../core/config.js';
import { searchRelevantGuidelines, listAllIndexedGuidelines, insertChunks } from '../core/db.js';
import { DocChunk } from '../core/chunker.js';

/**
 * Interactive 2-Way Conversational Dialog with RAG Knowledge Base.
 * - STRICT GROUNDING: AI hanya menjawab berdasarkan apa yang ada di LanceDB.
 * - Jika ilmu belum ada di database, AI WAJIB menyatakan tidak tahu / belum terdaftar.
 * - User bisa mengobrol, bertanya isi aturan, atau mengajari aturan baru langsung di dalam chat.
 */
export async function runInteractiveKnowledgeDialog(): Promise<void> {
  const { client, config } = await getActiveAIProvider();
  const modelName = config.defaultModel || 'ag/gemini-3.8-flash';

  console.clear();
  console.log(chalk.bold.cyan('══════════════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.yellow('💬 Mode Obrolan Interaktif RAG (Strict Grounded Knowledge)'));
  console.log(chalk.gray('• Tanyakan aturan tim (misal: "Apakah kamu punya aturan tentang type?")'));
  console.log(chalk.gray('• AI HANYA menjawab apa yang ada di database RAG lokal.'));
  console.log(chalk.gray('• Ajarkan aturan baru secara langsung di obrolan ini.'));
  console.log(chalk.gray('• Ketik "b", "back", atau "exit" untuk kembali ke Menu Utama.'));
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

    const spinner = ora(chalk.blue('Mengecek database pengetahuan RAG...')).start();

    try {
      // 1. Ambil aturan yang paling relevan dari LanceDB
      const relevantChunks = await searchRelevantGuidelines(cleaned, 4);

      // Ambil seluruh daftar judul aturan untuk referensi ringkas AI jika ditanya hal umum
      const allGuidelines = await listAllIndexedGuidelines();
      const allTitlesSummary = allGuidelines.map((g, i) => `${i + 1}. ${g.title}`).join('\n');

      const knowledgeContext =
        relevantChunks.length > 0
          ? relevantChunks.map((c) => `[Judul: ${c.title} | Source: ${c.source}]\n${c.content}`).join('\n\n---\n\n')
          : 'KOSONG / TIDAK DITEMUKAN';

      const systemPrompt = `You are the strict, honest Guardian of Internal Coding Conventions.
You are in a direct 2-way conversation with a software developer.

CRITICAL DIRECTIVES:
1. STRICT GROUNDING: You ONLY answer based on the STORED CONVENTIONS provided below.
2. If the user asks whether you know something, or asks about a convention that is NOT in the stored conventions:
   - YOU MUST EXPLICITLY STATE: "Maaf, saya belum memiliki pengetahuan atau aturan mengenai [topik] di database RAG saya."
   - DO NOT make up conventions. DO NOT guess. DO NOT give general internet knowledge as if it's the team's internal rule.
3. If the user tells you a new rule or convention (e.g. "Mulai sekarang semua interface harus diawali huruf I" or "Aturan baru: gunakan Zod untuk validasi"):
   - Acknowledge it clearly: "Baik, saya catat aturan baru ini: [...]"
   - Confirm what the rule states and say it is ready to be saved.
4. Keep answers concise, natural, direct, and polite in Indonesian.

=== DAFTAR SEMUA JUDUL ATURAN YANG SUDAH TERDAFTAR DI RAG ===
${allTitlesSummary || '(Belum ada aturan yang tersimpan)'}

=== ISI DETAIL ATURAN YANG RELEVAN DENGAN PERTANYAAN INI ===
${knowledgeContext}
============================================================
`;

      // Sertakan riwayat obrolan sesi singkat
      const historyPrompt = chatHistory.length > 0
        ? `Riwayat obrolan sebelumnya:\n${chatHistory.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}\n\nPertanyaan user saat ini:\n${cleaned}`
        : cleaned;

      const { text: answer } = await generateText({
        model: client(modelName),
        system: systemPrompt,
        prompt: historyPrompt,
      });

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

      // Beri opsi interaktif cepat
      const quickAction = await select({
        message: 'Langkah selanjutnya:',
        choices: [
          { name: '💬 Lanjut mengobrol / bertanya', value: 'continue' },
          { name: '💾 Simpan obrolan / pernyataan ini sebagai Aturan Baru ke RAG', value: 'save' },
          { name: '🔙 Selesai & Kembali ke Menu Utama', value: 'back' },
        ],
      });

      if (quickAction === 'back') {
        break;
      } else if (quickAction === 'save') {
        const ruleTitle = await input({
          message: 'Beri judul aturan baru ini:',
          default: cleaned.slice(0, 50),
          validate: (v) => (v.trim().length > 0 ? true : 'Judul tidak boleh kosong'),
        });

        const ruleContent = await input({
          message: 'Isi spesifikasi aturan:',
          default: cleaned,
          validate: (v) => (v.trim().length > 0 ? true : 'Isi aturan tidak boleh kosong'),
        });

        const saveSpinner = ora(chalk.blue('Menyimpan aturan baru ke LanceDB...')).start();
        const chunk: DocChunk = {
          id: `conv_${Date.now()}`,
          source: 'interactive_dialog',
          title: ruleTitle.trim(),
          content: ruleContent.trim(),
        };

        const result = await insertChunks([chunk]);
        if (result.insertedCount > 0) {
          saveSpinner.succeed(chalk.green(`Aturan "${ruleTitle}" berhasil disimpan ke RAG!`));
        } else {
          saveSpinner.info(chalk.yellow(`Aturan ini sudah ada sebelumnya (ditolak duplikat).`));
        }
        console.log('');
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Error: ${err.message}`));
      console.log('');
    }
  }
}
