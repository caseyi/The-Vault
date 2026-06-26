#!/bin/sh
# Stage the Node backend (source + production deps) as a Tauri resource so the
# desktop app can spawn it. Run before `tauri dev` / `tauri build`. Works on
# macOS, Linux, and Windows (via Git Bash).
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/native/src-tauri/resources/backend"

echo "▸ Staging backend → $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
# Copy backend source (excluding node_modules/tests — deps reinstalled fresh below)
( cd "$ROOT/backend" && cp -R ./*.js ./package.json "$DEST/" 2>/dev/null || true )

cd "$DEST"
npm install --omit=dev --no-audit --no-fund

echo "✓ Backend staged with production deps."
echo "  NOTE (M2 TODO): also provide a Node 22 runtime at"
echo "    native/src-tauri/resources/node/<node|node.exe>"
echo "  or ensure 'node' (v22+) is on PATH at runtime. node:sqlite needs Node 22+."
