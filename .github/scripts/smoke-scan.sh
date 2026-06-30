#!/usr/bin/env bash
# Boots the backend with the runner's Node (same version we bundle) and runs a
# real scan against a tiny fixture library, asserting models get indexed.
# Catches: node:sqlite availability, backend boot crashes, scan-worker failures,
# missing deps, and "scan produced nothing" regressions — on macOS and Windows.
# (Note: it can't reproduce the macOS .app-bundle cwd issue, since CI runs the
# backend with a normal working directory.)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t vaultsmoke)"
LIB="$TMP/lib"
PORT=8585
BASE="http://127.0.0.1:$PORT"

mkdir -p "$LIB/Studio A/Dragon Bust" "$LIB/Studio A/Knight"
printf 'solid x\nendsolid x\n' > "$LIB/Studio A/Dragon Bust/dragon.stl"
printf 'solid x\nendsolid x\n' > "$LIB/Studio A/Knight/knight.stl"

export PORT DB_PATH="$TMP/data/vault.db" IMAGES_DIR="$TMP/data/images" LIBRARY_PATH="$LIB"

node --version
( cd "$ROOT/backend" && node --disable-warning=ExperimentalWarning server.js ) > "$TMP/be.log" 2>&1 &
BE=$!
cleanup() { kill "$BE" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $1"; echo "--- backend log ---"; cat "$TMP/be.log"; exit 1; }

# Wait for health (max ~30s)
up=0
for _ in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || fail "backend did not come up"
echo "health: $(curl -fsS "$BASE/api/health")"

# Kick a scan
curl -fsS -X POST "$BASE/api/scan" -H 'Content-Type: application/json' \
  -d "{\"path\":\"$LIBRARY_PATH\",\"force\":true}" >/dev/null || fail "scan request failed"

# Poll until done (max ~30s)
for _ in $(seq 1 30); do
  P="$(curl -fsS "$BASE/api/scan/progress" 2>/dev/null || echo '')"
  echo "progress: $P"
  case "$P" in *'"inProgress":false'*) break;; esac
  sleep 1
done

STATS="$(curl -fsS "$BASE/api/stats" 2>/dev/null || echo '')"
echo "stats: $STATS"
case "$STATS" in
  *'"total":0'*|'') fail "no models indexed (scan did not work)";;
esac
echo "SMOKE PASS"
