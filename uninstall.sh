#!/usr/bin/env bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Uninstalling Lumio ===${NC}\n"

# 1. Hapus binary launcher
if [ -f "/usr/local/bin/lumio" ]; then
    echo -e "Menghapus /usr/local/bin/lumio..."
    if [ -w "/usr/local/bin" ]; then
        rm -f "/usr/local/bin/lumio" "/usr/local/bin/pr-rag" 2>/dev/null || true
    else
        sudo rm -f "/usr/local/bin/lumio" "/usr/local/bin/pr-rag" 2>/dev/null || true
    fi
fi

if [ -f "$HOME/.local/bin/lumio" ]; then
    echo -e "Menghapus $HOME/.local/bin/lumio..."
    rm -f "$HOME/.local/bin/lumio"
fi

if [ -f "$HOME/.local/bin/pr-rag" ]; then
    rm -f "$HOME/.local/bin/pr-rag"
fi

# Hapus dari npm jika ada
npm uninstall -g lumio 2>/dev/null || true
npm uninstall -g rag-pr-reviewer 2>/dev/null || true

# 2. Hapus application directory
if [ -d "$HOME/.lumio/app" ]; then
    echo -e "Menghapus $HOME/.lumio/app..."
    rm -rf "$HOME/.lumio/app"
fi
if [ -d "$HOME/.pr-rag/app" ]; then
    rm -rf "$HOME/.pr-rag/app"
fi

# 3. Opsional: Hapus database vector lokal & config
read -p "Hapus juga database vector & config (~/.lumio)? [y/N]: " choice
case "$choice" in 
  y|Y ) 
    rm -rf "$HOME/.lumio" "$HOME/.pr-rag"
    echo -e "${GREEN}✔ Folder konfigurasi & database (~/.lumio) berhasil dihapus.${NC}"
    ;;
  * ) 
    echo -e "${CYAN}Folder database & config (~/.lumio) tetap disimpan.${NC}"
    ;;
esac

echo -e "\n${GREEN}✔ Lumio berhasil di-uninstall sepenuhnya dari sistem!${NC}\n"
