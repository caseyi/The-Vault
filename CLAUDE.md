# CLAUDE.md — Project Context for AI Assistants

## What is this?

**The Vault** is a self-hosted 3D print library manager. It runs on a Synology NAS ("Dagobah" at 192.168.1.140) via Docker Compose, indexing a folder tree of STL/3D print models and providing a dark-themed gallery UI.

**Owner:** Casey (caseyi@uw.edu)
**Repo:** github.com/caseyi/The-Vault
**Version:** 0.2.0 (build auto-incremented via pre-commit hook)
**Host:** Synology NAS "Dagobah" — library at `/volume1/STL Archive`

## Tech Stack

- **Backend:** Node.js 20, Express, better-sqlite3 (synchronous, WAL mode)
- **Frontend:** React 18 (CRA), no component library — custom dark theme
- **Deployment:** Docker Compose → 2 containers (backend + nginx/React frontend)
- **CI/CD:** GitHub Actions builds images to ghcr.io, `./update.sh` deploys on NAS
- **AI:** Claude API (Sonnet) for tagging, web search, and image finding

## Project Structure

```
the-vault/
├── backend/
│   ├── server.js        # Express API (~1300 lines) — all endpoints
│   ├── scanner.js       # Library indexer (~560 lines) — folder discovery, hashing, image extraction
│   ├── scraper.js       # Web scraper (~260 lines) — Printables, MMF, Thingiverse, Cults3D, Gumroad
│   ├── db.js            # Schema + migrations (ALTER TABLE pattern)
│   ├── version.json     # {"version": "0.2.0", "build": N}
│   ├── Dockerfile
│   └── tests/
│       ├── scanner.test.js   # 69 tests
│       ├── api.test.js
│       └── scraper.test.js
├── frontend/
│   ├── nginx.conf       # Reverse proxy — SSE endpoints need special config
│   ├── Dockerfile
│   └── src/
│       ├── App.js       # Root — state management, routing
│       ├── App.css      # All styles (~780 lines)
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
├── docker-compose.yml
├── update.sh            # Pull + restart on NAS (with rollback support)
└── setup-from-github.sh # First-time setup
```

## Key Architecture Decisions

### SSE Streaming
All long-running operations use Server-Sent Events (SSE) for real-time progress:
- Library scanning (`GET /api/scan/stream`)
- AI tag generation (`GET /api/ai/generate-tags`)
- AI image finding (`GET /api/ai/find-images`)
- Web scraping (`GET /api/models/:id/scrape-stream`)
- Creator re-extraction (`POST /api/creators/:id/reextract`)

**Critical:** SSE endpoints MUST be listed in `frontend/nginx.conf` with `proxy_buffering off` and `Connection ''` — otherwise nginx buffers them.

### Claude API Integration
All Claude API calls go through the shared `callClaudeAPI()` helper in `server.js`. This handles:
- HTTP status checking before JSON.parse (avoids "Unexpected token '<'" on HTML error pages)
- Human-readable error messages (401 → "Invalid API key", 429 → "Rate limited", etc.)
- Configurable timeouts (default 120s)
- Network error handling (ECONNRESET, ENOTFOUND)

API key is stored in browser localStorage and passed via `x-claude-key` header (POST endpoints) or `?key=` query param (SSE endpoints).

### Scanner: Pass-Through Directory Detection
The scanner auto-detects "pass-through" directories — top-level folders that contain ONLY subdirectories and no printable files (e.g., "STL Archive"). It treats their children as the real creators instead of attributing everything to the pass-through name.

### Scanner: Transaction Chunking
better-sqlite3 transactions are synchronous and block the event loop. The scanner processes models in chunks of 10 per transaction with `setImmediate()` yields between chunks, so SSE progress streams in real time.

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
# Frontend (47 tests)
cd frontend && npx react-scripts test --watchAll=false

# Backend syntax check (better-sqlite3 native binary may not build in dev VMs)
node -c backend/server.js && node -c backend/scanner.js
```

## How to Deploy

```bash
# 1. Commit changes (pre-commit hook auto-increments build number)
git add . && git commit -m "description"

# 2. Push to main (triggers GitHub Actions image build)
git push

# 3. On NAS (Dagobah), pull and restart
ssh casey@192.168.1.140
cd /path/to/the-vault
./update.sh
```

## Database Notes

- Schema changes use `try { db.exec('ALTER TABLE ...') } catch {}` pattern
- `CREATE TABLE IF NOT EXISTS` does NOT add new columns — every new column needs ALTER TABLE
- `folder_hash` enables skip optimization — force rescan clears all hashes
- Tags are stored as JSON arrays in TEXT column: `'["tag1","tag2"]'`
- The `tags` column defaults to `'[]'` — queries should check for `NULL`, `''`, and `'[]'`

## Common Pitfalls

1. **nginx SSE buffering:** New SSE endpoints must be added to the regex in `nginx.conf`
2. **better-sqlite3 sync blocking:** Long transactions block the event loop — chunk them
3. **GHCR images vs local code:** Changes to local files don't take effect until pushed and deployed
4. **Synology junk folders:** `#recycle`, `@eaDir` etc. are cleaned up on scan start
5. **API key format:** Must start with `sk-ant-` — the test endpoint validates this
6. **Pass-through dirs:** If library mount nests creators under a root folder, the scanner auto-detects this
