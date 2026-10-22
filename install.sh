#!/usr/bin/env bash
set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=== Installing pr-rag (Local RAG PR Reviewer) ===${NC}\n"

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}Error: Node.js belum terinstall. Silakan install Node.js (v18+) terlebih dahulu.${NC}"
    exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}Error: Membutuhkan Node.js versi 18 atau lebih baru. Versi saat ini: $(node -v)${NC}"
    exit 1
fi

# 2. Check npm
if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}Error: npm tidak ditemukan.${NC}"
    exit 1
fi

# 3. Install globally via GitHub direct
echo -e "${YELLOW}Menginstall pr-rag secara global via npm...${NC}"
npm install -g git+https://github.com/jagoankode/rag-pr-reviewer.git

echo -e "\n${GREEN}✔ Berhasil terinstall!${NC}"
echo -e "Ketik ${CYAN}pr-rag${NC} di terminal manapun untuk membuka mode TUI interaktif."
echo -e "Untuk uninstall kapan saja, cukup jalankan: ${YELLOW}npm uninstall -g rag-pr-reviewer${NC}\n"
