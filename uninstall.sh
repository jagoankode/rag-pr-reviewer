#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Uninstalling pr-rag ===${NC}\n"

# 1. Hapus binary launcher
if [ -f "/usr/local/bin/pr-rag" ]; then
    echo -e "Menghapus /usr/local/bin/pr-rag..."
    if [ -w "/usr/local/bin" ]; then
        rm -f "/usr/local/bin/pr-rag"
    else
        sudo rm -f "/usr/local/bin/pr-rag"
    fi
fi

if [ -f "$HOME/.local/bin/pr-rag" ]; then
    echo -e "Menghapus $HOME/.local/bin/pr-rag..."
    rm -f "$HOME/.local/bin/pr-rag"
fi

# Hapus dari npm jika sebelumnya pernah install via npm
npm uninstall -g rag-pr-reviewer 2>/dev/null || true

# 2. Hapus application directory
if [ -d "$HOME/.pr-rag/app" ]; then
    echo -e "Menghapus $HOME/.pr-rag/app..."
    rm -rf "$HOME/.pr-rag/app"
fi

# 3. Opsional: Hapus database vector lokal
read -p "Hapus juga database vector & config (~/.pr-rag)? [y/N]: " choice
case "$choice" in 
  y|Y ) 
    rm -rf "$HOME/.pr-rag"
    echo -e "${GREEN}✔ Folder konfigurasi & database (~/.pr-rag) berhasil dihapus.${NC}"
    ;;
  * ) 
    echo -e "${CYAN}Folder database & config (~/.pr-rag) tetap disimpan.${NC}"
    ;;
esac

echo -e "\n${GREEN}✔ pr-rag berhasil di-uninstall sepenuhnya dari sistem!${NC}\n"
