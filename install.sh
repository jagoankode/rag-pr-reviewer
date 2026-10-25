#!/usr/bin/env bash
set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}═════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    ✨ Installing / Updating Lumio                          ${NC}"
echo -e "${CYAN}    AI-Powered PR Reviewer & Centralized Knowledge Engine    ${NC}"
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

LUMIO_DIR="$HOME/.lumio"
INSTALL_DIR="$LUMIO_DIR/app"
BIN_DIR="$HOME/.local/bin"
BIN_TARGET="$BIN_DIR/lumio"
LEGACY_BIN_TARGET="$BIN_DIR/pr-rag"

# Migrasi data config & database lama jika ada dari .pr-rag ke .lumio
if [ -d "$HOME/.pr-rag" ] && [ ! -d "$LUMIO_DIR" ]; then
    echo -e "${CYAN}Memindahkan data & konfigurasi dari ~/.pr-rag ke ~/.lumio...${NC}"
    mkdir -p "$LUMIO_DIR"
    cp -r "$HOME/.pr-rag/db" "$LUMIO_DIR/" 2>/dev/null || true
    cp "$HOME/.pr-rag/config.json" "$LUMIO_DIR/" 2>/dev/null || true
fi

echo -e "${YELLOW}1. Mengunduh package Lumio...${NC}"
mkdir -p "$LUMIO_DIR"
mkdir -p "$BIN_DIR"

# Download langsung via tarball (100% TANPA butuh git di laptop user)
TMP_DOWNLOAD=$(mktemp -d)
TMP_STAGING=$(mktemp -d)
trap 'rm -rf "$TMP_DOWNLOAD" "$TMP_STAGING"' EXIT INT TERM

curl -fsSL https://github.com/jagoankode/rag-pr-reviewer/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP_DOWNLOAD" --strip-components=1

# Siapkan di direktori staging dulu agar instalasi bersifat ATOMIC (tidak korup jika di-abort/Ctrl+C)
mkdir -p "$TMP_STAGING/dist"
cp -r "$TMP_DOWNLOAD/dist/"* "$TMP_STAGING/dist/"
cp "$TMP_DOWNLOAD/package.json" "$TMP_STAGING/"
# Tidak menyertakan package-lock internal cloud provider yang berisi internal mirror domain
rm -rf "$TMP_DOWNLOAD"

echo -e "${YELLOW}2. Menginstall runtime dependencies lokal...${NC}"
(
    cd "$TMP_STAGING"
    npm install --omit=dev --loglevel=error --no-audit --no-fund --registry=https://registry.npmjs.org
)

# Atomic swap: Ganti instalasi lama hanya ketika dependencies sudah 100% terinstall sukses
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$TMP_STAGING/"* "$INSTALL_DIR/"
rm -rf "$TMP_STAGING"
trap - EXIT INT TERM

echo -e "${YELLOW}3. Menyiapkan executable binary 'lumio' di ${BIN_TARGET}...${NC}"
rm -f "$BIN_TARGET"
rm -f "$LEGACY_BIN_TARGET"

cat << 'EOF' > "$BIN_TARGET"
#!/usr/bin/env bash
NODE_EXEC=$(command -v node)
if [ -z "$NODE_EXEC" ]; then
    echo "Error: Node.js runtime not found." >&2
    exit 1
fi

APP_DIR="$HOME/.lumio/app"

# Self-healing: jika node_modules hilang atau tidak lengkap akibat abort/Ctrl+C
if [ ! -d "$APP_DIR/node_modules/commander" ]; then
    echo -e "\033[1;33m[Lumio] Memulihkan dependencies yang terputus...\033[0m" >&2
    (cd "$APP_DIR" && npm install --omit=dev --loglevel=error --no-audit --no-fund --registry=https://registry.npmjs.org)
fi

exec "$NODE_EXEC" "$APP_DIR/dist/index.js" "$@"
EOF

chmod +x "$BIN_TARGET"

# Buat juga alias symlink pr-rag -> lumio untuk backward compatibility
ln -sf "$BIN_TARGET" "$LEGACY_BIN_TARGET"

# 4. Pastikan ~/.local/bin masuk ke shell config (.zshrc / .bashrc) jika belum ada
detect_and_add_path() {
    local rc_file="$1"
    if [ -f "$rc_file" ]; then
        if ! grep -q '\.local/bin' "$rc_file"; then
            echo -e "\n# Added by Lumio installer\nexport PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$rc_file"
            echo -e "${CYAN}Menambahkan ~/.local/bin ke ${rc_file}${NC}"
        fi
    fi
}

detect_and_add_path "$HOME/.zshrc"
detect_and_add_path "$HOME/.bashrc"

echo -e "\n${GREEN}✔ Lumio berhasil terinstall!${NC}"
INSTALLED_VER=$(node -e "try { console.log(require('$INSTALL_DIR/package.json').version); } catch(e) { console.log(''); }")
if [ -n "$INSTALLED_VER" ]; then
    echo -e "Versi aktif: ${CYAN}v${INSTALLED_VER}${NC}"
fi
if [ -d "$LUMIO_DIR/db" ]; then
    echo -e "${GREEN}🔒 Data Database & Konfigurasi tetap aman dan terjaga.${NC}"
fi
echo -e "Binary terpasang di: ${CYAN}$BIN_TARGET${NC}"
echo -e "Ketik ${GREEN}lumio${NC} di terminal untuk langsung membuka TUI.\n"
