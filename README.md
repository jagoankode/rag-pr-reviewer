# rag-pr-reviewer

CLI tool for AI-powered Pull Request review with **embedded local RAG** using [LanceDB](https://lancedb.com/) & [Vercel AI SDK](https://sdk.vercel.ai/).

## ✨ Features

- **Embedded Vector Database**: Runs LanceDB locally with zero external server or Docker dependencies.
- **Smart Markdown Chunker**: Chunks guidelines based on headings (`#`, `##`, `###`) so rule contexts remain intact.
- **Git Native Integration**: Reads staged diffs, branch comparisons, or uncommitted changes directly via native git CLI.
- **RAG-Enhanced Code Review**: Queries your team's indexed architecture/coding guidelines and injects relevant rules into the LLM prompt.
- **Flexible Models**: Powered by Vercel AI SDK (default: `gpt-4o`, interchangeable via `--model`).
- **Terminal Markdown Output**: Pretty prints rich markdown reviews right in your terminal.

---

## 🚀 Installation & Setup

1. **Clone & install dependencies:**
   ```bash
   git clone git@github.com:jagoankode/rag-pr-reviewer.git
   cd rag-pr-reviewer
   npm install
   ```

2. **Configure API Keys:**
   Create a `.env` file in the root folder:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. **Build TypeScript:**
   ```bash
   npm run build
   ```

---

## 🛠️ Usage

### 1. Ingest Guidelines / Architecture Rules into Vector DB
Index your team's coding conventions, security guidelines, or documentation:
```bash
# Ingest single file or entire docs directory
npx tsx src/index.ts ingest ./docs
# or
npx tsx src/index.ts ingest path/to/coding-standards.md
```

### 2. Run Review on Git Changes
```bash
# Review uncommitted changes
npx tsx src/index.ts review

# Review staged changes only
npx tsx src/index.ts review --staged

# Review changes against a specific branch
npx tsx src/index.ts review --branch main

# Specify a different model or limit relevant context chunks
npx tsx src/index.ts review --model gpt-4o --limit 5
```

---

## 📁 Project Architecture

```text
rag-pr-reviewer/
├── src/
│   ├── commands/
│   │   ├── ingest.ts       # Parses docs -> chunks by heading -> embeds -> stores in LanceDB
│   │   └── review.ts       # Fetches git diff -> vector searches rules -> LLM review -> CLI output
│   ├── core/
│   │   ├── chunker.ts      # Markdown section chunking engine
│   │   ├── db.ts           # LanceDB connection & vector search helpers
│   │   ├── git.ts          # Git diff runner
│   │   └── prompt.ts       # Senior code review prompt builder
│   ├── types/
│   │   └── marked-terminal.d.ts
│   └── index.ts            # Commander CLI entrypoint
├── tsconfig.json
└── package.json
```
