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

### Hybrid review engine

`review` now reads all active, non-system rules once (paginated, read-only Qdrant or
local LanceDB), rather than selecting top-5/top-3 matches. A failed rule read aborts
the review; it never silently substitutes an empty rule set. Legacy rows without a
status remain active. The report includes the rule snapshot hash, per-rule/file
coverage and stable finding IDs (rule, path, line, column, check).

The local hybrid prompt is in `src/core/review-prompt.ts`; it does not modify or
seed database prompts. The existing legacy prompt editor remains available for
other/legacy consumers, but its audit template does not override this protocol.

Deterministic checks are deliberately narrow, enabled by explicit rule content:
TypeScript forbidden types, assertions, non-null assertions, empty object types,
explicit function parameter/return annotations; class/type/interface PascalCase;
`var` prohibition; documented required and conditional module scaffold files.
Scaffold checks require canonical component/container anchors in immediate
`src/modules/<Module>` folders. Both documented test extensions are accepted;
optional files aren't required unless the documented condition applies. A list of
scaffold examples is **not** treated as an exclusive filename allowlist. A
`Record<string, unknown>` restriction alone does not prohibit standalone `unknown`.

All rules still receive structured AI coverage for residual/unsupported clauses:
PASS, FAIL, NOT_APPLICABLE or UNCERTAIN. Missing/invalid/duplicate responses,
invalid locations, parser failures and provider errors cannot yield a clean
verdict. Full scope checks affected files in full; diff scope restricts findings
to added lines (including line 1 for scaffold findings). Deleted/binary-only files
continue to be excluded by the existing diff parser.

File content and sibling inventories are captured before AI calls, using the
index for staged reviews and resolved source commit for two-branch reviews.
Diff/content mismatches invalidate the input. Capture is not an atomic filesystem
or database transaction: concurrent modifications should be avoided. The selected
configuration is reused, temperature is set to zero, and all prompts use frozen
rule/file inputs. Providers may still be nondeterministic or reject temperature;
AI PASS is not a mathematical proof. Deterministic AST results are reproducible;
semantic AI findings and coverage are **not guaranteed identical across runs**.
No type checker/cross-file semantic analysis is used. JSDoc, contextual naming,
nonstandard module layouts and complex typing policies remain AI-assessed.

### Stable review core (local presentation increment)

The confirmed finding list and core verdict are computed independently of AI responses.
AI analysis is explicitly **unverified advisory** and may differ between runs; it cannot
approve residual semantics or add confirmed violations. This is not a claim of 100%
semantic correctness. Existing phrase-based AST checks cover only some clauses;
only an exact standalone `Never use \`var\`.` / `Do not use \`var\`.` rule currently has
complete deterministic PASS coverage. Other rules remain UNCERTAIN unless a violation
is confirmed, and must be verified by a human. No active rules never gives approval.

Reports include base/head/merge-base SHAs, rule and input digests, engine revision,
mode/scope, and a reproducibility fingerprint. Compare these before comparing findings.
Use committed PR mode (`review --source <head> --target <base>`) on both machines;
worktree/staged results depend on each machine's actual captured content. Deleted,
binary and metadata-only changes are explicitly incomplete rather than silently skipped.
Fingerprint is a comparison identifier, **not** an authenticity signature or a cache.
AI credentials/provider/model are intentionally outside the deterministic-core fingerprint.

New ingestion retains short rules and gives chunks content-addressed IDs independent of
checkout location and chunk ordering. Existing imported records are not migrated or
removed: legacy duplicates and stale active rules require explicit cleanup/re-ingestion.
Review uses all active rules (exhaustive retrieval); semantic top-K RAG optimization and
an approved structured checker registry remain future work. No CI integration is included.
