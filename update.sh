#!/bin/sh
# update.sh — pull the latest Vault images and restart
#
# Run this on your Synology NAS (or any Docker host) whenever you want to
# pick up a new release:
#
#   cd /path/to/the-vault
#   ./update.sh            # normal update
#   ./update.sh rollback   # revert to previous version

set -e

COMPOSE="docker-compose"

# Use 'docker compose' (v2) if available, fall back to 'docker-compose' (v1)
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
fi

# Portable IP detection (Synology BusyBox hostname doesn't support -I)
get_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' && return
  hostname -i 2>/dev/null | awk '{print $1}' && return
  ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' && return
  echo "localhost"
}

# ── Rollback ─────────────────────────────────────────────────────────────────

if [ "$1" = "rollback" ]; then
  echo ""
  echo "┌─────────────────────────────────────┐"
  echo "│   The Vault — rollback              │"
  echo "└─────────────────────────────────────┘"
  echo ""

  # Check if rollback tags exist
  if ! docker image inspect ghcr.io/caseyi/stlvault-backend:rollback >/dev/null 2>&1 || \
     ! docker image inspect ghcr.io/caseyi/stlvault-frontend:rollback >/dev/null 2>&1; then
    echo "✗ No rollback images found. You need to run a normal update first"
    echo "  (rollback images are saved automatically before each update)."
    exit 1
  fi

  echo "▸ Restoring previous images..."
  docker tag ghcr.io/caseyi/stlvault-backend:rollback  ghcr.io/caseyi/stlvault-backend:latest
  docker tag ghcr.io/caseyi/stlvault-frontend:rollback ghcr.io/caseyi/stlvault-frontend:latest

  echo ""
  echo "▸ Restarting containers with previous version..."
  $COMPOSE up -d --remove-orphans

  echo ""
  echo "✓ Rolled back!  The Vault is running at http://$(get_ip):8484"
  echo ""
  exit 0
fi

# ── Normal update ────────────────────────────────────────────────────────────

echo ""
echo "┌─────────────────────────────────────┐"
echo "│   The Vault — update                │"
echo "└─────────────────────────────────────┘"
echo ""

# Save current images as rollback (if they exist)
echo "▸ Saving current images as rollback point..."
if docker tag ghcr.io/caseyi/stlvault-backend:latest ghcr.io/caseyi/stlvault-backend:rollback 2>/dev/null; then
  echo "  ✓ backend saved"
else
  echo "  · backend (no previous image)"
fi
if docker tag ghcr.io/caseyi/stlvault-frontend:latest ghcr.io/caseyi/stlvault-frontend:rollback 2>/dev/null; then
  echo "  ✓ frontend saved"
else
  echo "  · frontend (no previous image)"
fi

echo ""
echo "▸ Pulling latest images from GitHub..."
$COMPOSE pull

echo ""
echo "▸ Restarting containers..."
$COMPOSE up -d --remove-orphans

echo ""
echo "▸ Cleaning up dangling images (keeping rollback)..."
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/caseyi/The-Vault" 2>/dev/null || true

echo ""
echo "✓ Done!  The Vault is running at http://$(get_ip):8484"
echo "  To revert: ./update.sh rollback"
echo ""
