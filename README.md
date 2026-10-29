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

*Untuk uninstall* (menghapus aplikasi, config, database lokal, cache, log, dan baris PATH dari installer):
```bash
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/uninstall.sh | bash
# Simpan config & database lokal:
curl -fsSL https://raw.githubusercontent.com/jagoankode/rag-pr-reviewer/main/uninstall.sh | bash -s -- --keep-data
```

*Jaringan kantor dengan SSL inspection:* perintah `lumio` menyiapkan bundle CA sebelum Node berjalan (berlaku di
semua versi Node): CA sistem Linux, Root CA Windows bila berjalan di WSL, Keychain sistem di macOS, dan isi
`NODE_EXTRA_CA_CERTS` milik Anda. Bila tetap muncul error sertifikat, jalankan `lumio doctor`.

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
# Cepat & deterministik (tanpa AI), cocok untuk git hook
lumio review --staged --core-only

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

# Susun checks deterministik dari teks rule dengan AI (admin)
lumio rules compile --try ./src --out drafts.json

# Paksa sinkronisasi rules dari Qdrant VPS
lumio sync

# Diagnosa instalasi & koneksi: versi, Node/CA, git, config, sertifikat, database rule, model AI
lumio doctor
lumio doctor --no-ai   # tanpa memanggil model

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

### Cara kerja review

Lumio adalah **buku contekan kosong**: kode tidak berisi konvensi tim mana pun. Standar review adalah
**rule aktif di database** (collection Qdrant tim atau LanceDB lokal). Tim baru cukup memasukkan rule-nya.
Lumio membaca semua rule aktif (paginated, read-only), lalu memeriksa setiap file yang berubah dalam dua lapis:

1. **Checks deterministik (AST TypeScript).** Rule boleh membawa field payload `checks`: daftar primitif
   generik yang dijalankan engine. Rule tanpa `checks` hanya dinilai AI, begitu pula file selain
   JS/TS (`.go`, `.py`, `.java`, dst.) karena parser-nya TypeScript. Semua yang spesifik tim (glob file,
   nama hook, pola nama, tipe terlarang, pesan, severity) adalah data di rule, bukan kode.

   ```json
   {
     "checks": [
       { "type": "forbid-call", "names": ["use*"], "files": ["*.view.tsx"], "severity": "error",
         "message": "Hook `{name}` tidak boleh dipanggil di view.", "fix": "Pindahkan ke store." },
       { "type": "branch-name", "pattern": "^(feat|fix)/[A-Z]+-\\d+-[a-z0-9-]+$", "allow": ["develop", "release/*"],
         "severity": "error", "message": "Nama branch `{name}` tidak sesuai format." }
     ],
     "checksComplete": false
   }
   ```

   | Primitif | Parameter utama |
   | --- | --- |
   | `forbid-syntax` | `syntax`: `var`, `non-null-assertion`, `type-assertion`, `empty-object-type`, `index-signature`, `function-declaration`, `optional-parameter-before-required`, `inline-object-type-in-signature`, `jsx`, `jsx-and-number`, `jsx-nested-ternary`, `jsx-ternary-null`, `jsx-inline-handler-wrapper`, `runtime-logic`, `non-export-statement`, `misplaced-directive`, `non-async-server-export`, `fallback`, `or-fallback`, `magic-number`, `magic-string`, `block-comment`, `commented-out-code`, `todo-without-ticket`, `hook-name-without-hook-call` |
   | `forbid-type` | `types` (teks tipe, mis. `any`, `Record<string, unknown>`) |
   | `forbid-call` | `names` (glob nama callee, mis. `use*`, `window.fetch`), `argument` (regex argumen pertama) |
   | `forbid-import` | `from` (glob module), `names` (glob nama import), `allowTypeOnly`, `allowOwnTest` |
   | `forbid-directive` / `require-directive` | `directives` / `directive` + `ifCalls` |
   | `naming` | `target` (`identifier`, `variable`, `boolean`, `type`, `schema`, `test-title`), `pattern`, `forbidden`, `forbiddenPattern` |
   | `explicit-types` / `require-jsdoc` | `returns`, `parameters`, `callbacks` (`each`/`summary`/`ignore`), `tagFormat`, `ignoreInsideCalls` |
   | `format` | `rule`: `eof-newline`, `semicolon`, `curly`, `blank-line-before` (+ `keywords`) |
   | `require-files` | `anchors` (mis. `{name}.view.tsx`), `required` (`file`, `if`) |
   | `branch-name` / `commit-message` | `pattern` (regex), `allow` (glob branch yang dikecualikan) |

   Semua check menerima `files`/`exclude` (glob; default `targetFiles` rule), `severity` (`error`/`warning`),
   `message` dan `fix` dengan placeholder `{name}` `{Name}` `{text}` `{value}` `{file}` `{count}` `{lines}`,
   serta `messages`/`fixes`/`severities` per kasus untuk primitif yang melaporkan beberapa kasus. Entri yang tidak valid
   dilewati dan dilaporkan di catatan review, tidak pernah ditebak. `checksComplete: true` berarti rule
   sudah dicek penuh sehingga tidak dikirim lagi ke AI.

   **Menyusun `checks` dengan AI (admin):** `lumio rules compile` membaca teks rule, meminta AI menyusun
   `checks` dari primitif di atas, memvalidasinya dengan skema (satu kali retry bila ditolak), lalu menampilkan
   hasilnya. Rule yang butuh penilaian dibiarkan kosong dan tetap dinilai AI. Tidak ada yang tersimpan tanpa
   persetujuan admin.

   ```bash
   # Draf untuk semua rule non-meta yang belum punya checks, diuji pada kode di src/, disimpan ke file untuk ditinjau
   lumio rules compile --try ./src --out drafts.json
   # Draf rule tertentu (id atau potongan judul), pesan dalam Bahasa Indonesia, konfirmasi per rule sebelum disimpan
   lumio rules compile -r "Naming" --lang id --try ./src
   # Simpan draf yang sudah ditinjau/diedit (tanpa memanggil AI)
   lumio rules compile --from drafts.json
   ```

   AI hanya melihat satu rule. Informasi dari rule lain (mis. daftar branch inti yang ada di rule terpisah)
   ditambahkan admin saat meninjau draf.

2. **AI** memeriksa klausul semantik yang tidak bisa diputuskan parser, hanya untuk rule yang `targetFiles`-nya
   cocok dengan file. Rule dengan `checksComplete: true` tidak dikirim ke AI. Temuan AI divalidasi (rule ID,
   file, baris, scope diff) dan **ikut menentukan verdict**; temuan yang invalid dibuang.
   Jawaban yang kehilangan rule atau memiliki coverage tidak valid mendapat maksimal satu panggilan susulan,
   hanya untuk rule tersebut. Susulan memakai slot concurrency dan perlindungan blokir akun yang sama.

**Coverage:** `PASS` dan `FAIL` berarti pasangan file-rule telah terverifikasi dalam scope review.
`NOT_APPLICABLE` (N/A) berarti rule tidak berlaku; `UNVERIFIED` berarti pemeriksaan belum lengkap.
Jawaban AI yang hilang/tidak valid serta file yang belum diaudit karena batas temuan tidak dihitung PASS.
Checks parsial saja juga belum membuktikan seluruh isi rule, tetapi pelanggaran yang ditemukannya langsung `FAIL`.
Dalam `--ai-scope changed`, temuan AI di baris lama dibuang tanpa membuat rule UNVERIFIED.
Laporan menampilkan judul rule dan jumlah terverifikasi/total, N/A, serta belum terverifikasi secara terpisah.
Karena itu, `--core-only` dapat menghasilkan `COMMENT` tanpa temuan jika masih ada rule semantik.

**Bahasa:** komentar AI selalu dalam bahasa Inggris. Pesan temuan deterministik berasal dari `checks` di
database, jadi bahasanya ditentukan tim; `rules compile` menyusunnya dalam bahasa Inggris kecuali diberi `--lang id`.

**Verdict:** ada `error` → `REQUEST_CHANGES`; hanya `warning` atau coverage belum lengkap → `COMMENT`;
tanpa temuan dan coverage lengkap → `APPROVE`.
Severity temuan deterministik berasal dari `checks`; AI memakai `error` untuk klausul MUST/never/forbidden/mandatory.
Jika AI gagal/timeout pada sebuah file, temuan deterministik tetap dilaporkan dan review ditandai belum
lengkap (tidak pernah `APPROVE`). File yang dihapus atau biner dilewati tanpa memblokir verdict.

**Kode lama:** seluruh file tetap menjadi konteks AI. Default `--ai-scope changed` membatasi temuan AI
ke baris yang ditambah atau diubah. Checks deterministik tetap memeriksa file utuh dengan `--scope full`
(default). Gunakan `--ai-scope full` untuk turut meminta temuan AI pada kode lama.
Hanya temuan di baris yang ditambah perubahan ini yang menentukan verdict. Temuan di baris lama ditampilkan terpisah (terminal: bagian redup di akhir;
markdown: "Temuan di Kode Lama"; `--json`: `existingViolations`) dan tidak dihitung ke `--max-violations`.
`--scope diff` tidak melaporkan kode lama sama sekali.

**Kecepatan:** `--concurrency` (default 8) mengatur jumlah file yang diaudit AI bersamaan. Provider yang sibuk
(429/5xx) dicoba ulang otomatis hingga 3 kali dengan jeda bertahap; akun atau key yang ditolak (401/403) tidak
dicoba ulang, dan file sisanya berhenti mengirim request. Turunkan, mis. `--concurrency 2`, bila provider membatasi.
Concurrency adaptif aktif secara default: slot dikurangi separuh setelah dua respons 429 beruntun (minimum 1),
lalu bertambah satu setelah lima respons sukses, hingga batas `--concurrency`. `--no-adaptive-concurrency` mematikannya.
File terbesar diaudit lebih dulu agar file lambat tidak menjadi ekor run; urutan laporan tetap urutan path.
Dengan `--ai-scope changed`, file yang tidak menambah baris tidak dikirim ke AI, dan rule yang seluruhnya
ditegakkan checks tidak pernah masuk prompt.

**Cache:** hasil lengkap per file disimpan di `~/.lumio/cache/reviews/` selama maksimal 7 hari,
dengan batas 50 MiB total, 5 MiB per entri, dan 2.000 entri. Kunci mencakup isi/path file, daftar file satu folder,
diff/baris berubah, hash rule, versi engine/prompt, model/provider/endpoint, bahasa, serta scope deterministik dan AI.
Hasil incomplete, error, skipped, atau UNVERIFIED tidak disimpan. Entri rusak/kedaluwarsa dianggap cache miss;
direktori dipindai sekali per run, dan dipindai ulang hanya bila batas ukuran/jumlah terlewati. `--no-cache` melewati pembacaan dan penulisan.
Cache menyimpan komentar/temuan review, bukan credential koneksi; perlakukan direktori ini sebagai data lokal privat.

Untuk menguji checkout pengembangan gunakan `lumio-dev` (environment `dev` secara default); `lumio` menjalankan versi production:

```bash
lumio-dev review --source origin/feature-example --target origin/main --no-cache
lumio-dev review --source origin/feature-example --target origin/main --ai-scope full
lumio-dev review --source origin/feature-example --target origin/main --no-adaptive-concurrency
```

**Environment.** Config, `.env`, cache rule, cache review, log, dan database lokal bisa dipisah per environment,
misalnya collection rule development di samping production. Aplikasi dan CA bundle tetap dipakai bersama.

```bash
lumio env create dev --collection team-rules-dev   # salin config default, ganti collection
lumio env list                                     # daftar environment, collection, dan model
lumio --env dev review --source origin/feature-example --target origin/main
LUMIO_ENV=dev lumio                                # sama, lewat variabel environment
```

| Environment | Lokasi |
| --- | --- |
| `default` | `~/.lumio` |
| `<nama>` | `~/.lumio/envs/<nama>` |

Urutan prioritas: `--env`, `LUMIO_ENV`, lalu `LUMIO_CONFIG_DIR` (direktori bebas). Selain `default`, setiap perintah
mencetak environment aktif ke stderr; environment yang belum dibuat ditolak alih-alih memakai config kosong.

Output `--json` menyertakan `coverageSummary`, `cache` (hit/miss saat aktif), serta `metrics`:
`elapsedMs` (sampai hasil audit dirangkum), `aiCalls` (pemanggilan awal/susulan), `aiRequests`
(respons HTTP, termasuk retry), dan `incompleteFiles`. Snapshot Jest (`__snapshots__/`) dikecualikan dari review dan tercantum di `excludedFiles`.
Waktu proses CLI dapat lebih besar daripada `elapsedMs` karena startup/build dan pencetakan laporan.

**Exit code** (`--fail-on error|warning|never`, default `error`): `1` bila verdict mencapai level tersebut,
`2` bila review gagal dijalankan. Contoh git hook `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
lumio review --staged --core-only --no-save
```

Setiap laporan menyimpan base/head/merge-base SHA, digest rule & input, versi engine dan fingerprint,
sehingga dua mesin bisa membandingkan hasil review untuk commit yang sama. Hasil checks deterministik
selalu identik; hasil AI bisa berbeda antar run.
