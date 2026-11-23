#!/usr/bin/env bash
set -euo pipefail
UUID='mac-ringlight@satria.local'
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
gnome-extensions disable "$UUID" 2>/dev/null || true
mkdir -p "$DEST"
cp -a "$SOURCE_DIR"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"
gnome-extensions enable "$UUID"
echo 'Mac Ringlight v15 berhasil diperbarui.'
