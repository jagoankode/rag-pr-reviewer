#!/usr/bin/env bash
set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}═════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    🧪 Installing pr-rag (Local RAG PR Reviewer)            ${NC}"
echo -e "${CYAN}═════════════════════════════════════════════════════════════${NC}\n"

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}Error: Node.js belum terpasang. Harap install Node.js (v18+) terlebih dahulu.${NC}"
    exit 1
fi

NODE_PATH=$(command -v node)
NODE_MAJOR=$("$NODE_PATH" -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}Error: Membutuhkan Node.js versi 18+. Versi saat ini: $("$NODE_PATH" -v)${NC}"
    exit 1
fi

# 2. Check npm / git
if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}Error: npm tidak ditemukan.${NC}"
    exit 1
fi

INSTALL_DIR="$HOME/.pr-rag/app"
BIN_TARGET="/usr/local/bin/pr-rag"

echo -e "${YELLOW}1. Mengunduh & menyiapkan app di ${INSTALL_DIR}...${NC}"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

if command -v git >/dev/null 2>&1; then
    git clone --depth=1 https://github.com/jagoankode/rag-pr-reviewer.git "$INSTALL_DIR" --quiet
else
    curl -fsSL https://github.com/jagoankode/rag-pr-reviewer/archive/refs/heads/main.tar.gz | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

echo -e "${YELLOW}2. Menginstall runtime dependencies lokal...${NC}"
(
    cd "$INSTALL_DIR"
    # Pastikan pakai official npmjs registry, bukan internal mirror
    npm install --omit=dev --loglevel=error --no-audit --no-fund --registry=https://registry.npmjs.org
)

echo -e "${YELLOW}3. Membuat executable launcher di /usr/local/bin/pr-rag...${NC}"

# Buat script launcher
LAUNCHER_CONTENT="#!/usr/bin/env bash
exec \"$NODE_PATH\" \"$INSTALL_DIR/dist/index.js\" \"\$@\""

TMP_LAUNCHER=$(mktemp)
echo "$LAUNCHER_CONTENT" > "$TMP_LAUNCHER"
chmod +x "$TMP_LAUNCHER"

# Coba pasang di /usr/local/bin (standar $PATH semua Linux/macOS/WSL)
if [ -w "/usr/local/bin" ]; then
    mv "$TMP_LAUNCHER" "$BIN_TARGET"
elif command -v sudo >/dev/null 2>&1; then
    echo -e "${CYAN}Membutuhkan izin sudo untuk memasang ke /usr/local/bin agar langsung aktif di PATH...${NC}"
    sudo mv "$TMP_LAUNCHER" "$BIN_TARGET"
    sudo chmod +x "$BIN_TARGET"
else
    # Fallback ke ~/.local/bin jika tidak ada akses sudo
    mkdir -p "$HOME/.local/bin"
    mv "$TMP_LAUNCHER" "$HOME/.local/bin/pr-rag"
    chmod +x "$HOME/.local/bin/pr-rag"
    BIN_TARGET="$HOME/.local/bin/pr-rag"
fi

echo -e "\n${GREEN}✔ Instalasi berhasil selesai!${NC}"
echo -e "Binary terpasang di: ${CYAN}$BIN_TARGET${NC}"
echo -e "Cukup ketik ${GREEN}pr-rag${NC} di terminal manapun untuk langsung membuka TUI.\n"
