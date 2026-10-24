# ✨ Lumio

> **AI-Powered Pull Request Reviewer & Centralized Team Knowledge Engine**

Lumio menerangi setiap celah kode Anda sebelum merge. Memadukan **Embedded Local RAG (LanceDB)** dan **Centralized Team Vector Database (Qdrant VPS)** untuk memastikan seluruh tim patuh pada satu standar konvensi arsitektur yang seragam.

---

## 🌟 Mengapa Lumio?

- **✨ UI/UX Minimalist & Estetik**: Tampilan terminal modern bergaya OpenCode dengan single-line status chip, badge context aktif, dan navigasi keyboard terstandarisasi (`esc back • ↑↓ navigate • ⏎ select`).
- **🌐 Bilingual Support (i18n)**: Mendukung penuh Bahasa Indonesia (`id`) dan English (`en`) yang dapat diganti kapan saja via menu Pengaturan.
- **🛡️ 2-Tier Auto-Patch & Zero-Embedding for Members**: Anggota tim hanya butuh credential LLM chat biasa. Knowledge rules otomatis tersinkronisasi dan di-cache lokal dengan deterministic vectorizer tanpa perlu biaya/kuota API embedding.
- **🤖 Multi-Provider & Dynamic Model Mapping**: Dukungan multi-profile untuk 9router, OpenAI Official, OpenRouter, Ollama, dan Custom Provider (Sumopod, LiteLLM, Groq, dll.) dengan auto-switching Base URL dan API Key per model.
- **📍 Audit Baris-demi-Baris**: Menemukan pelanggaran kode presisi per file dan nomor baris (`payment.ts:20`) lengkap dengan actionable code fix.
- **💬 Dialog Tanya-Jawab RAG**: Mode obrolan interaktif 2-arah yang *strict grounded* (hanya menjawab dari aturan tim tanpa halusinasi).
- **🧠 Codebase Reverse Engineering**: Pelajari pola arsitektur hulu-ke-hilir dari folder fitur lokal Anda secara otomatis (`lumio learn`).
- **🛑 Zero-Hang & Abort-Ready**: Seluruh proses async dilindungi timeout safeguard, deterministic TF-IDF fallback, dan `AbortController` (aman dibatalkan via Ctrl+C / Esc kapan saja).

---

## ⚡ Instalasi Cepat (1-Liner)

Jalankan perintah ini di terminal (Linux, macOS, WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/install.sh | bash
```

Setelah instalasi selesai, jalankan:
```bash
lumio
```

*Untuk uninstall:*
```bash
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/uninstall.sh | bash
```

---

## 🚀 Panduan Penggunaan

### 1. Terminal User Interface (TUI Mode)
Cukup ketik `lumio` dari repositori git mana pun:
```bash
lumio
```

Menu dikelompokkan secara rapi dan modular:
- **🔍 Review Changes**: Review uncommitted changes, staged changes, atau bandingkan cabang PR (`origin/main ⟵ origin/feature`).
- **📚 Knowledge Base**:
  - `💬 Tanya Jawab Aturan (Chat Dialog)`: Diskusi interaktif tanya aturan coding tim.
  - `📖 Inspect Active Rules`: Cek seluruh aturan aktif yang tersimpan di Vector DB.
  - `🧠 Learn Feature Code`: Bedah source code folder fitur untuk ekstraksi konvensi baru.
  - `📥 Ingest Knowledge Baru`: Tambah dokumen (.md, .txt, URL) atau via form manual.
- **⚡ Ganti Model Cepat**: Switch model aktif dengan auto-sync provider profile.
- **🤖 Configure AI Provider**: Kelola profil AI provider, Base URL, dan API Key.
- **📜 Review History**: Buka, baca kembali, atau kelola laporan audit PR yang tersimpan.
- **⚙️ Pengaturan (Settings)**:
  - `📊 Status Configuration`: Ringkasan status sistem, branch git, dan environment.
  - `🌐 Language / Bahasa`: Switch bahasa tampilan antara ID dan EN.
  - `💾 Database Storage Mode`: Beralih antara **🌐 Remote VPS Qdrant** atau **💻 Local LanceDB**.

---

### 2. Command Line Langsung (CLI Fast Mode)

```bash
# Review perubahan uncommitted
lumio review

# Review staged changes
lumio review --staged

# Review PR branch terhadap remote origin
lumio review --source origin/feature-payment --target origin/main --fetch

# Belajar konvensi dari folder fitur lokal
lumio learn ./src/features/payment

# Ingest dokumen panduan markdown
lumio ingest ./docs/coding-standards.md

# Buka riwayat review
lumio history

# Paksa sinkronisasi rules dari Qdrant VPS
lumio sync

# Periksa dan upgrade Lumio ke versi rilis terbaru
lumio upgrade
```

---

## 🧪 Testing

Proyek ini dilengkapi native unit test runner:

```bash
npm test
```

---

## 📄 Lisensi

ISC © [jagoankode](https://github.com/jagoankode)
