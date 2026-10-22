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

# 2. Check npm
if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}Error: npm tidak ditemukan.${NC}"
    exit 1
fi

INSTALL_DIR="$HOME/.pr-rag/app"
BIN_DIR="$HOME/.local/bin"
BIN_TARGET="$BIN_DIR/pr-rag"

echo -e "${YELLOW}1. Menyiapkan direktori di ${INSTALL_DIR}...${NC}"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

if command -v git >/dev/null 2>&1; then
    git clone --depth=1 https://github.com/jagoankode/rag-pr-reviewer.git "$INSTALL_DIR" --quiet
else
    curl -fsSL https://github.com/jagoankode/rag-pr-reviewer/archive/refs/heads/main.tar.gz | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

echo -e "${YELLOW}2. Menginstall runtime dependencies lokal...${NC}"
(
    cd "$INSTALL_DIR"
    npm install --omit=dev --loglevel=error --no-audit --no-fund --registry=https://registry.npmjs.org
)

echo -e "${YELLOW}3. Memasang binary pr-rag ke ${BIN_TARGET}...${NC}"
cat << 'EOF' > "$BIN_TARGET"
#!/usr/bin/env bash
NODE_EXEC=$(command -v node)
if [ -z "$NODE_EXEC" ]; then
    echo "Error: Node.js runtime not found." >&2
    exit 1
fi
exec "$NODE_EXEC" "$HOME/.pr-rag/app/dist/index.js" "$@"
EOF

chmod +x "$BIN_TARGET"

# 4. Pastikan ~/.local/bin masuk ke shell config (.zshrc / .bashrc) jika belum ada
detect_and_add_path() {
    local rc_file="$1"
    if [ -f "$rc_file" ]; then
        if ! grep -q '\.local/bin' "$rc_file"; then
            echo -e "\n# Added by pr-rag installer\nexport PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$rc_file"
            echo -e "${CYAN}Menambahkan ~/.local/bin ke ${rc_file}${NC}"
        fi
    fi
}

detect_and_add_path "$HOME/.zshrc"
detect_and_add_path "$HOME/.bashrc"

echo -e "\n${GREEN}✔ Instalasi selesai tanpa sudo!${NC}"
echo -e "Binary terpasang di: ${CYAN}$BIN_TARGET${NC}"
echo -e "Jalankan: ${YELLOW}source ~/.zshrc${NC} (atau buka tab baru), lalu ketik: ${GREEN}pr-rag${NC}\n"
