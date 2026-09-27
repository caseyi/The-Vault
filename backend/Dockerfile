# syntax=docker/dockerfile:1
#
# The Vault - backend image
#
# Node 22 for the built-in node:sqlite. node:sqlite is unflagged from 22.13, so
# we follow the 22 line (security patches included) and assert it at build time
# below instead of pinning a minor version.
FROM node:22-alpine

WORKDIR /app

# Production dependencies only, exactly as locked. Nothing here needs a
# compiler: node:sqlite is built into Node and node-unrar-js is WebAssembly.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && node -e "require('node:sqlite')"

COPY . .

# Build metadata, reported by GET /api/health and the sidebar.
ARG GIT_SHA=dev
ARG BUILD_DATE=
LABEL org.opencontainers.image.title="stlvault-backend" \
      org.opencontainers.image.description="The Vault - self-hosted 3D print library manager (API)" \
      org.opencontainers.image.source="https://github.com/caseyi/The-Vault" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DB_PATH=/data/vault.db \
    IMAGES_DIR=/data/images \
    BACKUP_DIR=/backups \
    LIBRARY_PATH=/library \
    GIT_SHA=${GIT_SHA} \
    BUILD_DATE=${BUILD_DATE}

# Runs as root ON PURPOSE. Existing installs keep their database in a named
# volume (`<project>_vault_data`) whose files were created by root in earlier
# images. Switching to the unprivileged `node` user would make that database
# read-only for the app (writes fail with SQLITE_READONLY / EACCES) until
# someone chowns the volume by hand. The library itself is mounted read-only.
# If this ever changes, add an entrypoint that chowns /data and /backups once,
# and test it against a copy of a real volume first.

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

# --disable-warning hushes the node:sqlite "experimental" notice (inherited by the scan worker too)
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
