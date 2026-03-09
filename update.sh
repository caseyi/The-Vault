#!/bin/sh
# update.sh — pull the latest Vault images and restart
#
# Run this on your Synology NAS (or any Docker host) whenever you want to
# pick up a new release:
#
#   cd /path/to/stlvault
#   ./update.sh

set -e

COMPOSE="docker-compose"

# Use 'docker compose' (v2) if available, fall back to 'docker-compose' (v1)
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
fi

echo ""
echo "┌─────────────────────────────────────┐"
echo "│   The Vault — update                │"
echo "└─────────────────────────────────────┘"
echo ""

echo "▸ Pulling latest images from GitHub..."
$COMPOSE pull

echo ""
echo "▸ Restarting containers..."
$COMPOSE up -d --remove-orphans

echo ""
echo "▸ Cleaning up old images..."
docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/caseyi/stlvault" 2>/dev/null || true

echo ""
echo "✓ Done!  The Vault is running at http://$(hostname -I | awk '{print $1}'):8484"
echo ""
