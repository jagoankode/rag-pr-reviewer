# ✨ Lumio

> **AI-Powered Pull Request Reviewer & Centralized Team Knowledge Engine**

Lumio menerangi setiap celah kode Anda sebelum merge. Memadukan **Embedded Local RAG (LanceDB)** dan **Centralized Team Vector Database (Qdrant VPS)** untuk memastikan seluruh tim patuh pada satu standar konvensi arsitektur yang seragam.

---

## 🌟 Mengapa Lumio?

- **✨ Branding Elegan & Modern**: Perintah CLI yang estetik dan intuitif (`lumio`).
- **🛡️ Single Source of Truth**: Sinkronisasi aturan tim secara real-time via Qdrant VPS (`knowlage.jagoankode.site`), atau gunakan mode lokal offline (`~/.lumio/db`).
- **📍 Audit Baris-demi-Baris**: Menemukan pelanggaran kode presisi per file dan nomor baris (`payment.ts:20`) dengan actionable code fix.
- **💬 Dialog 2-Arah Berdasar Data**: Ngobrol dan berdiskusi dengan AI yang memiliki *strict grounding* (hanya menjawab dari aturan tim).
- **🧠 Codebase Reverse Engineering**: Pelajari pola arsitektur hulu-ke-hilir dari folder fitur lokal Anda secara otomatis.
- **🔒 Aman & Tertutup**: Source code backend diproteksi, hasil review berupa 100% Pure Markdown tanpa tag HTML.

---

## ⚡ Instalasi Cepat (1-Liner)

Jalankan perintah ini di terminal (Linux, macOS, WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/install.sh | bash
```

Setelah instalasi selesai, cukup ketik:
```bash
lumio
```

*Untuk uninstall kapan saja:*
```bash
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/uninstall.sh | bash
```

---

## 🚀 Panduan Penggunaan

### 1. Mode Interaktif TUI (Direkomendasikan)
Cukup ketik `lumio` dari repositori git mana pun:
```bash
lumio
```
Navigasi menu menggunakan tombol panah atas/bawah:
- **🔍 Review Git Changes**: Review perubahan lokal, staged, atau bandingkan branch PR (`origin/main <- origin/feature`).
- **💬 Chat / Dialog Interaktif RAG**: Tanya jawab mengenai aturan tim atau tambahkan aturan baru lewat chat.
- **🧠 Learn from Local Feature Code**: Arahkan ke folder fitur lokal untuk mengekstrak konvensi otomatis.
- **💾 Database Storage Mode**: Pilih antara **🌐 Remote VPS Qdrant** (`knowlage.jagoankode.site`) atau **💻 Local LanceDB**.
- **🤖 Configure AI Provider**: Konfigurasi 9router, OpenAI, OpenRouter, atau Ollama.

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
```

---

## 📄 Lisensi

ISC © [jagoankode](https://github.com/jagoankode)
