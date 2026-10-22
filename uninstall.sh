#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Uninstalling pr-rag ===${NC}\n"

# 1. Uninstall global package
echo -e "Menghapus package global via npm..."
npm uninstall -g rag-pr-reviewer 2>/dev/null || true

# 2. Opsional: Hapus database vector lokal
read -p "Hapus juga database vector lokal (~/.pr-rag)? [y/N]: " choice
case "$choice" in 
  y|Y ) 
    rm -rf ~/.pr-rag
    echo -e "${GREEN}✔ Vector database (~/.pr-rag) berhasil dihapus.${NC}"
    ;;
  * ) 
    echo -e "${CYAN}Vector database (~/.pr-rag) tetap disimpan.${NC}"
    ;;
esac

echo -e "\n${GREEN}✔ pr-rag berhasil di-uninstall sepenuhnya dari sistem!${NC}\n"
