#!/bin/sh
# Stage the Node backend (source + production deps) as a Tauri resource so the
# desktop app can spawn it. Run before `tauri dev` / `tauri build`. Works on
# macOS, Linux, and Windows (via Git Bash).
#
# Copies the WHOLE backend folder (server.js, lib/, version.json, lockfile, …)
# except tests, local data and dev-only files, then installs production deps.
# Any copy failure aborts the script: a half-staged backend must never ship.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/backend"
DEST="$ROOT/native/src-tauri/resources/backend"

echo "▸ Staging backend → $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

cd "$SRC"
for item in *; do
  case "$item" in
    node_modules|tests|coverage|data|backups|Dockerfile|jest.config.js|*.db|*.db-*|*.log) continue ;;
  esac
  cp -R "$item" "$DEST/"
done

for required in server.js package.json version.json; do
  [ -f "$DEST/$required" ] || { echo "✗ $required missing from staged backend" >&2; exit 1; }
done

cd "$DEST"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  echo "  (no package-lock.json - falling back to npm install)"
  npm install --omit=dev --no-audit --no-fund
fi

echo "✓ Backend staged with production deps:"
ls "$DEST"
echo "  Node runtime: native/src-tauri/resources/node/<node|node.exe> (CI downloads"
echo "  it), or 'node' v22.13+ on PATH at runtime. node:sqlite needs Node 22.13+."
