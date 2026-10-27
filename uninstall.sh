#!/usr/bin/env bash
# Menghapus Lumio beserta seluruh config, database lokal, cache dan log-nya.
# Simpan config & database lokal: curl -fsSL .../uninstall.sh | bash -s -- --keep-data
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

KEEP_DATA=0
for arg in "$@"; do
    case "$arg" in
        --keep-data) KEEP_DATA=1 ;;
    esac
done

LUMIO_DIR="$HOME/.lumio"
LEGACY_DIR="$HOME/.pr-rag"
BIN_DIR="$HOME/.local/bin"

removed() { echo -e "  ${GREEN}✔${NC} $1"; }

echo -e "${YELLOW}=== Uninstalling Lumio ===${NC}\n"

# 1. Binary launcher (lokasi sekarang dan lama)
for bin in "$BIN_DIR/lumio" "$BIN_DIR/pr-rag"; do
    if [ -e "$bin" ] || [ -L "$bin" ]; then rm -f "$bin" && removed "$bin"; fi
done
for bin in /usr/local/bin/lumio /usr/local/bin/pr-rag; do
    if [ -e "$bin" ] || [ -L "$bin" ]; then
        if [ -w /usr/local/bin ]; then rm -f "$bin"; else sudo rm -f "$bin"; fi
        removed "$bin"
    fi
done

# 2. Instalasi lama via npm global
if command -v npm >/dev/null 2>&1; then
    for pkg in lumio rag-pr-reviewer; do
        if npm ls -g --depth=0 "$pkg" >/dev/null 2>&1; then npm uninstall -g "$pkg" >/dev/null 2>&1 && removed "npm global: $pkg"; fi
    done
fi

# 3. Aplikasi, config, database lokal, cache, log (~/.lumio) dan folder lama ~/.pr-rag
if [ "$KEEP_DATA" -eq 1 ]; then
    for dir in "$LUMIO_DIR" "$LEGACY_DIR"; do
        [ -d "$dir" ] || continue
        for item in app cache logs; do
            if [ -e "$dir/$item" ]; then rm -rf "$dir/$item" && removed "$dir/$item"; fi
        done
        # Sisa swap installer yang terputus
        for item in "$dir"/app.new.* "$dir"/app.old.*; do
            if [ -e "$item" ]; then rm -rf "$item" && removed "$item"; fi
        done
    done
    echo -e "  ${CYAN}Config & database lokal disimpan di $LUMIO_DIR${NC}"
else
    for dir in "$LUMIO_DIR" "$LEGACY_DIR"; do
        if [ -d "$dir" ]; then rm -rf "$dir" && removed "$dir (app, config, database, cache, log)"; fi
    done
fi

# 4. Baris PATH yang ditambahkan installer, hanya bila ~/.local/bin tidak dipakai program lain
if [ ! -d "$BIN_DIR" ] || [ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]; then
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        [ -f "$rc" ] || continue
        if grep -q '^# Added by Lumio installer$' "$rc"; then
            tmp="$(mktemp)"
            awk '
                /^# Added by Lumio installer$/ { marker = 1; next }
                marker && /^export PATH="\$HOME\/\.local\/bin:\$PATH"$/ { marker = 0; next }
                { if (marker) print "# Added by Lumio installer"; marker = 0; print }
            ' "$rc" > "$tmp" && cat "$tmp" > "$rc" && rm -f "$tmp"
            removed "baris PATH Lumio di $rc"
        fi
    done
fi

echo -e "\n${GREEN}✔ Lumio berhasil di-uninstall.${NC}"
echo -e "${CYAN}Catatan: file per-repo (.lumiorc.json, .lumio.json, folder laporan .lumio-reviews/) tidak dihapus;${NC}"
echo -e "${CYAN}hapus manual di repo yang memakainya bila tidak diperlukan.${NC}\n"
