"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInteractiveKnowledgeDialog = runInteractiveKnowledgeDialog;
const chalk_1 = __importDefault(require("chalk"));
const ora_1 = __importDefault(require("ora"));
const nav_js_1 = require("../core/nav.js");
const ai_1 = require("ai");
const config_js_1 = require("../core/config.js");
const db_js_1 = require("../core/db.js");
/**
 * Interactive 2-Way Conversational Dialog with RAG Knowledge Base.
 * - STRICT GROUNDING: AI hanya menjawab berdasarkan apa yang ada di LanceDB.
 * - Jika ilmu belum ada di database, AI WAJIB menyatakan tidak tahu / belum terdaftar.
 * - User bisa mengobrol, bertanya isi aturan, atau mengajari aturan baru langsung di dalam chat.
 */
async function runInteractiveKnowledgeDialog() {
    const { client, config } = await (0, config_js_1.getActiveAIProvider)();
    const modelName = config.defaultModel || 'ag/gemini-3.8-flash';
    console.clear();
    console.log(chalk_1.default.bold.cyan('══════════════════════════════════════════════════════════════════════'));
    console.log(chalk_1.default.bold.yellow('💬 Mode Obrolan Interaktif RAG (Strict Grounded Knowledge)'));
    console.log(chalk_1.default.gray('• Tanyakan aturan tim (misal: "Apakah kamu punya aturan tentang type?")'));
    console.log(chalk_1.default.gray('• AI HANYA menjawab apa yang ada di database RAG lokal.'));
    console.log(chalk_1.default.gray('• Ajarkan aturan baru secara langsung di obrolan ini.'));
    console.log(chalk_1.default.gray('• Ketik "b", "back", atau "exit" untuk kembali ke Menu Utama.'));
    console.log(chalk_1.default.bold.cyan('══════════════════════════════════════════════════════════════════════\n'));
    // Riwayat obrolan dalam sesi ini
    const chatHistory = [];
    while (true) {
        const userPrompt = await (0, nav_js_1.input)({
            message: chalk_1.default.bold.green('Anda :'),
        });
        const cleaned = userPrompt.trim();
        if (!cleaned ||
            cleaned.toLowerCase() === 'exit' ||
            cleaned.toLowerCase() === 'b' ||
            cleaned.toLowerCase() === 'back') {
            console.log(chalk_1.default.gray('\nKeluar dari mode dialog.\n'));
            break;
        }
        const spinner = (0, ora_1.default)(chalk_1.default.blue('Mengecek database pengetahuan RAG...')).start();
        try {
            // 1. Ambil aturan yang paling relevan dari LanceDB
            const relevantChunks = await (0, db_js_1.searchRelevantGuidelines)(cleaned, 4);
            // Ambil seluruh daftar judul aturan untuk referensi ringkas AI jika ditanya hal umum
            const allGuidelines = await (0, db_js_1.listAllIndexedGuidelines)();
            const allTitlesSummary = allGuidelines.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
            const knowledgeContext = relevantChunks.length > 0
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
            const { text: answer } = await (0, ai_1.generateText)({
                model: client(modelName),
                system: systemPrompt,
                prompt: historyPrompt,
            });
            spinner.stop();
            console.log(`\n${chalk_1.default.bold.cyan('RAG  :')} ${chalk_1.default.white(answer)}\n`);
            // Simpan ke history sesi
            chatHistory.push({ role: 'user', text: cleaned });
            chatHistory.push({ role: 'assistant', text: answer });
            // Jika jawaban relevan berasal dari dokumen
            if (relevantChunks.length > 0) {
                console.log(chalk_1.default.gray(`📌 Terkait ${relevantChunks.length} aturan:`));
                relevantChunks.forEach((c) => console.log(chalk_1.default.gray(`   • ${c.title}`)));
                console.log('');
            }
            // Beri opsi interaktif cepat
            const quickAction = await (0, nav_js_1.select)({
                message: 'Langkah selanjutnya:',
                choices: [
                    { name: '💬 Lanjut mengobrol / bertanya', value: 'continue' },
                    { name: '💾 Simpan obrolan / pernyataan ini sebagai Aturan Baru ke RAG', value: 'save' },
                    { name: '🔙 Selesai & Kembali ke Menu Utama', value: 'back' },
                ],
            });
            if (quickAction === 'back') {
                break;
            }
            else if (quickAction === 'save') {
                const ruleTitle = await (0, nav_js_1.input)({
                    message: 'Beri judul aturan baru ini:',
                    default: cleaned.slice(0, 50),
                    validate: (v) => (v.trim().length > 0 ? true : 'Judul tidak boleh kosong'),
                });
                const ruleContent = await (0, nav_js_1.input)({
                    message: 'Isi spesifikasi aturan:',
                    default: cleaned,
                    validate: (v) => (v.trim().length > 0 ? true : 'Isi aturan tidak boleh kosong'),
                });
                const saveSpinner = (0, ora_1.default)(chalk_1.default.blue('Menyimpan aturan baru ke LanceDB...')).start();
                const chunk = {
                    id: `conv_${Date.now()}`,
                    source: 'interactive_dialog',
                    title: ruleTitle.trim(),
                    content: ruleContent.trim(),
                };
                const result = await (0, db_js_1.insertChunks)([chunk]);
                if (result.insertedCount > 0) {
                    saveSpinner.succeed(chalk_1.default.green(`Aturan "${ruleTitle}" berhasil disimpan ke RAG!`));
                }
                else {
                    saveSpinner.info(chalk_1.default.yellow(`Aturan ini sudah ada sebelumnya (ditolak duplikat).`));
                }
                console.log('');
            }
        }
        catch (err) {
            spinner.fail(chalk_1.default.red(`Error: ${err.message}`));
            console.log('');
        }
    }
}
