# CLAUDE.md - Project Context for AI Assistants

## What is this?

**The Vault** is a self-hosted 3D print library manager. It runs on a Synology NAS ("Dagobah" at 192.168.1.140) via Docker Compose, indexing a folder tree of STL/3D print models and providing a dark-themed gallery UI.

**Owner:** Casey (caseyi@uw.edu)
**Repo:** github.com/caseyi/The-Vault
**Version:** `backend/version.json` (bump `version` by hand for releases) + the git commit baked into each Docker image (`GIT_SHA`); both show in the sidebar and `/api/health`
**Host:** Synology NAS "Dagobah" - library at `/volume1/STL Archive`

## Tech Stack

- **Backend:** Node.js 22 (>= 22.13), Express, built-in `node:sqlite` (synchronous, WAL mode; no native addon)
- **Frontend:** React 18 (CRA), no component library - custom dark theme
- **Deployment:** Docker Compose → 2 containers (backend + nginx/React frontend)
- **CI/CD:** GitHub Actions tests, builds, smoke-tests and pushes images to ghcr.io (`stlvault-backend` / `stlvault-frontend`, never rename); `sudo sh update.sh` deploys on the NAS
- **Native:** Tauri desktop app in `native/` (bundles Node 22 + the backend as a sidecar)
- **AI:** Claude API (Sonnet) for tagging, web search, and image finding

## Project Structure

```
the-vault/
├── backend/
│   ├── server.js        # Express API - most endpoints
│   ├── organize.js      # /api/organize/* router (health, dedupe, AI annotate, scripts)
│   ├── scanner.js       # Library indexer - folder discovery, hashing, image extraction
│   ├── scan-worker.js   # Runs scans in a worker thread
│   ├── scraper.js       # Web scraper - Printables, MMF, Thingiverse, Cults3D, Gumroad
│   ├── lib/             # Shared helpers (sse.js, backup.js, paths.js, …)
│   ├── db.js            # Schema + migrations (ALTER TABLE pattern)
│   ├── version.json     # {"version": "0.2.0", "build": N}
│   ├── Dockerfile
│   └── tests/
│       ├── scanner.test.js
│       ├── api.test.js
│       └── scraper.test.js
├── frontend/
│   ├── nginx.conf       # Reverse proxy - SSE endpoints need special config
│   ├── Dockerfile
│   └── src/
│       ├── App.js       # Root - state management, routing
│       ├── App.css      # All styles
│       ├── pages/
│       │   ├── Gallery.js        # Model card grid, bulk ops, search
│       │   └── ModelDetail.js    # Full model view, thumbnails, STL viewer
│       └── components/
│           ├── Sidebar.js           # Stats, filters, tag cloud, creators
│           ├── ScanModal.js         # Scan + AI tools (tag gen, image finder)
│           ├── ClaudeAssistant.js   # Per-model AI chat panel
│           ├── TaskLog.js           # Terminal-style SSE log viewer
│           ├── StlViewer.js         # Three.js STL preview
│           ├── ZipImagePicker.js    # Extract images from ZIPs
│           ├── ReleaseFileList.js   # Grouped file listing
│           └── RenderHintPanel.js   # Configure render archive detection
├── native/              # Tauri desktop app (see native/README.md)
├── docker-compose.yml
├── .env.example         # Every setting, documented
├── update.sh            # NAS update / rollback: sudo sh update.sh [tag]
└── add-library.sh       # Extra library folders via docker-compose.override.yml
```

## Key Architecture Decisions

### SSE Streaming
All long-running operations use Server-Sent Events (SSE) for real-time progress:
- Library scanning (`GET /api/scan/stream`)
- AI tag generation (`GET /api/ai/generate-tags`)
- AI image finding (`GET /api/ai/find-images`)
- Web scraping (`GET /api/models/:id/scrape-stream`)
- Creator re-extraction (`GET`/`POST /api/creators/:id/reextract`)
- Vision tagging (`GET /api/ai/vision-tags`), web scrape (`POST /api/models/:id/scrape` with `Accept: text/event-stream`), AI annotate (`POST /api/organize/auto-annotate`)

Every stream goes through `backend/lib/sse.js` (`openSSE`): it sets `X-Accel-Buffering: no`, sends a `:` heartbeat every 15 s and flags client disconnects so work stops.

**Critical:** new SSE endpoints must also be added to the regex location in `frontend/nginx.conf` (long timeouts, `proxy_buffering off`, `Connection ''`).

### Claude API Integration
All Claude API calls go through the shared `callClaudeAPI()` helper in `backend/lib/claude.js`. This handles:
- HTTP status checking before JSON.parse (avoids "Unexpected token '<'" on HTML error pages)
- Human-readable error messages (401 → "Invalid API key", 429 → "Rate limited", etc.)
- Configurable timeouts (default 120s)
- Network error handling (ECONNRESET, ENOTFOUND)

API key is stored in browser localStorage and passed via `x-claude-key` header (POST endpoints) or `?key=` query param (SSE endpoints). nginx logs `$uri` (no query string) so keys don't land in `docker logs`.

### Scanner: Pass-Through Directory Detection
The scanner auto-detects "pass-through" directories - top-level folders that contain ONLY subdirectories and no printable files (e.g., "STL Archive"). It treats their children as the real creators instead of attributing everything to the pass-through name.

### Scanner: Transaction Chunking
SQLite (`node:sqlite`) transactions are synchronous and block the event loop. The scanner processes models in chunks of 10 per transaction with `setImmediate()` yields between chunks, so SSE progress streams in real time.

### Image Finder: Matchability Scoring
Before burning API credits, each model gets a matchability score:
- 50 pts: already has a source URL
- 40 pts: folder name matches a known site pattern (Thingiverse ID, etc.)
- 15 pts: has a creator name
- 15 pts: has a descriptive model name (not generic)
- 5 pts: name contains proper nouns

Models scoring <20 are skipped. Trial mode (default) processes only the top 10 candidates first.

## How to Run Tests

```bash
cd backend && npm ci && npm test              # Jest (unit + API)
cd frontend && npm ci && CI=true npm test      # React Testing Library
node .github/scripts/smoke-scan.js             # boots the backend, scans a fixture
```

Test counts change; don't hard-code them in docs. CI (`docker-publish.yml`)
runs all of the above on every PR, then builds the images and boots/scans them.
Validate ops files with `shellcheck -s sh *.sh`, `hadolint */Dockerfile`,
`actionlint`, and `docker compose config`.

## How to Deploy

```bash
# 1. Push to main (or merge a PR) → GitHub Actions tests, builds and publishes
#    ghcr.io/caseyi/stlvault-{backend,frontend}:latest and :sha-<7 chars>
git push

# 2. On the NAS (Dagobah): the folder with docker-compose.yml, .env, update.sh
ssh casey@192.168.1.140
sudo sh /volume1/docker/the-vault/update.sh           # latest
sudo sh /volume1/docker/the-vault/update.sh sha-1a2b3c4   # pin / roll back
```

`update.sh` snapshots the DB into `./backups`, refuses to switch data volumes,
and prints the deployed commit. The NAS gets files via File Station, not git.

## Database Notes

- Schema changes use `try { db.exec('ALTER TABLE ...') } catch {}` pattern
- `CREATE TABLE IF NOT EXISTS` does NOT add new columns - every new column needs ALTER TABLE
- `folder_hash` enables skip optimization - force rescan clears all hashes
- Tags are stored as JSON arrays in TEXT column: `'["tag1","tag2"]'`
- The `tags` column defaults to `'[]'` - queries should check for `NULL`, `''`, and `'[]'`

## Common Pitfalls

1. **nginx SSE buffering:** New SSE endpoints must be added to the regex in `nginx.conf`
2. **SQLite sync blocking:** Long transactions block the event loop - chunk them (scans run in a worker thread)
3. **GHCR images vs local code:** Changes to local files don't take effect until pushed and deployed
4. **Synology junk folders:** `#recycle`, `@eaDir` etc. are cleaned up on scan start
5. **API key format:** Must start with `sk-ant-` - the test endpoint validates this
6. **Pass-through dirs:** If library mount nests creators under a root folder, the scanner auto-detects this
7. **Data volume name:** `vault_data` is project-scoped (`<folder>_vault_data`). Never add `name:` to it or rename the NAS folder without setting `COMPOSE_PROJECT_NAME`; update.sh guards against switching volumes
8. **Library is read-only in Docker:** Organize actions that move files generate a shell script instead (`LIBRARY_HOST_PATH`/`LIBRARY_NAME` map container paths back to the NAS)
9. **Lockfiles are committed:** Docker and CI use `npm ci`; update `package-lock.json` with every dependency change
