#!/bin/sh
# setup-from-github.sh
#
# Run this on Dagobah (SSH in first: ssh casey@dagobah)
#
# What it does:
#   1. Stops any running Vault containers
#   2. Finds and removes duplicate / old copies of the app files
#   3. Clones a clean copy from GitHub into ~/The-Vault
#   4. Pulls the pre-built Docker images
#   5. Starts the app
#
# Your DATABASE and IMAGES are safe — they live in a named Docker volume
# (vault_data) that is never touched by this script.
#
# Usage:
#   chmod +x setup-from-github.sh
#   ./setup-from-github.sh

set -e

REPO_URL="https://github.com/caseyi/The-Vault.git"
INSTALL_DIR="$HOME/The-Vault"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   The Vault — first-time GitHub setup    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Stop running containers ────────────────────────────────────────────────
echo "▸ Stopping any running Vault containers..."

# Try all the places docker-compose might be running from
for dir in "$HOME/The-Vault" "$HOME/the-vault" "$HOME/STLVault" "$HOME/Documents/The-Vault"; do
  if [ -f "$dir/docker-compose.yml" ]; then
    echo "  Found compose file at $dir — stopping..."
    cd "$dir"
    sudo docker-compose down 2>/dev/null || sudo docker compose down 2>/dev/null || true
    cd "$HOME"
  fi
done

echo ""

# ── 2. Find and list duplicate copies ────────────────────────────────────────
echo "▸ Looking for existing copies of the app files..."
echo "  (Searching your home directory — this may take a moment)"
echo ""

# Find any folder containing docker-compose.yml that references the-vault/vault
FOUND=$(find "$HOME" -maxdepth 4 -name "docker-compose.yml" 2>/dev/null | xargs grep -l "the-vault\|vault_data\|the-vault" 2>/dev/null || true)

if [ -n "$FOUND" ]; then
  echo "  Found these existing copies:"
  for f in $FOUND; do
    echo "    $(dirname $f)"
  done
  echo ""
  echo "  These will be REMOVED (only the app code is deleted — your DB is safe)."
  echo "  Press Ctrl+C now to abort, or wait 5 seconds to continue..."
  sleep 5
  echo ""
  for f in $FOUND; do
    DIR=$(dirname "$f")
    echo "  Removing $DIR ..."
    rm -rf "$DIR"
  done
else
  echo "  No existing copies found — clean install."
fi

echo ""

# ── 3. Clone fresh from GitHub ────────────────────────────────────────────────
echo "▸ Cloning from GitHub into $INSTALL_DIR ..."
git clone "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
echo ""

# ── 4. Pull pre-built images ──────────────────────────────────────────────────
echo "▸ Pulling pre-built Docker images from GitHub Container Registry..."
echo "  (First pull is ~200MB — subsequent updates are just the changed layers)"
echo ""
sudo docker-compose pull
echo ""

# ── 5. Start the app ─────────────────────────────────────────────────────────
echo "▸ Starting The Vault..."
sudo docker-compose up -d
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')
echo "╔══════════════════════════════════════════╗"
echo "║   ✓ Done!                                ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  App is running at:  http://${IP}:8484"
echo ""
echo "  App files live at:  $INSTALL_DIR"
echo "  Your DB is safe in Docker volume: vault_data"
echo ""
echo "  To update in the future, just run:"
echo "    cd $INSTALL_DIR && ./update.sh"
echo ""
