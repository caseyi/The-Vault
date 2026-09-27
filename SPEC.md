# The Vault - Project Specification

**Version:** see `backend/version.json` (the running build also reports its git commit)
**Last Updated:** 2026-09-27 (deployment/ops sections)
**Maintainer:** Casey (caseyi@uw.edu)
**Repository:** github.com/caseyi/The-Vault
**Host:** Synology NAS "Dagobah"

---

## 1. Overview

The Vault is a self-hosted 3D print library manager designed to run on a Synology NAS (or any Docker host). It indexes a folder tree of STL/3D print model files organized by creator, extracts metadata and images, and provides a dark-themed gallery UI for browsing, tagging, and managing print status.

### Core Capabilities

- **Library scanning:** Recursively indexes a NAS folder tree with deep folder discovery - handles both flat `Creator/Model` and nested archive structures like `Creator/Category/Subcategory/Model`
- **Image extraction:** Pulls images from ZIP and RAR archives (render packs) and scrapes source websites for thumbnails
- **Gallery browsing:** Filterable/searchable grid of model cards with image cycling, bulk operations, hide/show
- **Model detail:** Full metadata view, thumbnail management, STL 3D preview, file listing by release
- **Print status tracking:** Per-model lifecycle (unprinted → sliced → printing → printed → painted → failed)
- **AI assistant:** Claude-powered tag suggestions, organization advice, print notes, and **web search** for finding model sources online
- **AI batch tagging:** Auto-generate up to 5 tags per model (creator name, franchise, category, FDM/resin) via Claude Sonnet, streamed per-batch via SSE
- **AI image finder:** Smart matchability scoring + trial mode - finds and scrapes images for models without thumbnails, skipping low-confidence candidates
- **Tag cloud:** Clickable tag chips in sidebar with AND-logic filtering
- **Render archive hints:** Creator-level and model-level wildcard patterns for identifying render archives (ZIP + RAR)
- **Junk file filtering:** Automatically skips Synology metadata (@SynoEAStream, @SynoResource), macOS (._*, .DS_Store), and Windows (Thumbs.db) junk files
- **Scan persistence:** Scan progress survives page reloads - reconnects to running scan via SSE
- **Version tracking:** `backend/version.json` plus the git commit (`GIT_SHA`) and build date baked into the Docker image, displayed in the sidebar and `/api/health`

---

## 2. Architecture

### Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 22 (>= 22.13) + Express |
| Database | SQLite via the built-in `node:sqlite` (synchronous, WAL mode) |
| Frontend | React 18 (Create React App) |
| Reverse proxy | nginx (inside frontend container) |
| Deployment | Docker Compose (2 containers) |
| CI/CD | GitHub Actions → ghcr.io |
| Host | Synology NAS (Docker package) |

### Container Topology

```
┌─ frontend (port 8484) ─────────────────┐
│  nginx serves React build              │
│  Proxies /api/* → backend:3001         │
│  SSE endpoints get special proxy rules  │
└────────────────────────────────────────┘
        │
┌─ backend (port 3001) ──────────────────┐
│  Express API                           │
│  /data/ = named volume (DB + images)   │
│  /library/ = read-only bind mount      │
└────────────────────────────────────────┘
```

### Docker Compose Volumes

| Mount | Container | Path | Mode |
|---|---|---|---|
| Named volume `vault_data` | backend | `/data` | read-write |
| NAS library folder | backend | `/library/STL Archive` | read-only |

### Key File Paths (on NAS)

- Database: `/data/vault.db` (inside named volume)
- Extracted images: `/data/images/{model_uuid}/` (inside named volume)
- Library root: `/library/STL Archive/` (read-only mount)

---

## 3. Database Schema

### `creators` Table

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| name | TEXT UNIQUE NOT NULL | Creator/artist name |
| folder_path | TEXT | Absolute path on NAS |
| notes | TEXT | Free-form notes |
| render_zip_hint | TEXT | Wildcard pattern for render ZIPs (e.g., `*render*`) |
| created_at | TEXT | ISO datetime |

### `models` Table

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| uuid | TEXT UNIQUE NOT NULL | UUIDv4 for image storage paths |
| name | TEXT NOT NULL | Model display name (derived from folder name) |
| creator_id | INTEGER FK → creators(id) | ON DELETE SET NULL |
| folder_path | TEXT UNIQUE NOT NULL | Absolute path to model folder |
| source_site | TEXT | Detected source (Printables, MMF, Thingiverse, Cults3D, Gumroad) |
| source_url | TEXT | Full URL to source listing |
| description | TEXT | From scraping or manual entry |
| tags | TEXT | JSON array of strings, default `'[]'` |
| print_status | TEXT | Enum: unprinted, sliced, printing, printed, painted, failed |
| notes | TEXT | Free-form notes |
| file_count | INTEGER | Total files in model folder |
| has_stl | INTEGER | Boolean: contains .stl files |
| has_chitubox | INTEGER | Boolean: contains .chitubox files |
| has_lychee | INTEGER | Boolean: contains .lys/.lychee files |
| has_plate | INTEGER | Boolean: contains plate/pre-supported files |
| thumbnail_path | TEXT | Relative path to chosen thumbnail image |
| images | TEXT | JSON array of image paths, default `'[]'` |
| folder_hash | TEXT | SHA-1 of `filename:size:mtime` for skip optimization |
| render_zip_hint | TEXT | Model-level override for render ZIP pattern |
| hidden | INTEGER | 0 = visible (default), 1 = hidden from gallery |
| last_scanned | TEXT | ISO datetime of last scan |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | ISO datetime |

### `model_files` Table

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| model_id | INTEGER FK → models(id) | ON DELETE CASCADE |
| filename | TEXT NOT NULL | File name only |
| filepath | TEXT UNIQUE NOT NULL | Full path on disk (DEFAULT '' for V1 migration) |
| filetype | TEXT | Extension-based type |
| filesize | INTEGER | Bytes |
| release_name | TEXT | Inferred release/group name |
| created_at | TEXT | ISO datetime |

### `scan_log` Table

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| scan_path | TEXT | Path that was scanned |
| status | TEXT | running, completed, error |
| models_found | INTEGER | Total model folders found |
| models_added | INTEGER | New models indexed |
| models_updated | INTEGER | Existing models re-indexed |
| models_skipped | INTEGER | Models skipped (hash match) |
| error | TEXT | Error message if failed |
| started_at | TEXT | ISO datetime |
| finished_at | TEXT | ISO datetime |

### Indexes

- `idx_models_folder_path` on models(folder_path)
- `idx_models_creator` on models(creator_id)
- `idx_models_status` on models(print_status)
- `idx_models_name` on models(name)
- `idx_models_source_site` on models(source_site)
- `idx_files_model` on model_files(model_id)
- `idx_files_filepath` on model_files(filepath)
- `idx_creators_name` on creators(name)
- `idx_files_release` on model_files(release_name)

### Migration Strategy

All schema changes use the try/catch ALTER TABLE pattern for backwards compatibility:

```javascript
try { db.exec(`ALTER TABLE tablename ADD COLUMN col_name TYPE DEFAULT val`); } catch {}
```

`CREATE TABLE IF NOT EXISTS` is a **no-op for existing tables** - it does NOT add new columns. Every new column MUST have a corresponding ALTER TABLE migration line in `db.js`.

---

## 4. API Endpoints

### Library Scanning

| Method | Path | Description |
|---|---|---|
| GET | `/api/scan/status` | Current scan status and latest log entry |
| POST | `/api/scan` | Start a scan. Body: `{ path?: string, force?: boolean }`. Force nulls all folder_hash values first. |
| GET | `/api/scan/stream` | **SSE** - Real-time scan progress events |

### Models

| Method | Path | Description |
|---|---|---|
| GET | `/api/models` | List models (hidden excluded by default). Query params: `status`, `creator`, `search`, `tags`, `page`, `limit`, `show_hidden=1` |
| GET | `/api/models/:id` | Single model with its files |
| PATCH | `/api/models/:id` | Update model fields: `print_status`, `tags`, `notes`, `source_url`, `name`, `thumbnail_path`, `hidden` |
| POST | `/api/models/bulk` | Bulk update: `{ ids: number[], print_status?, tags_add?, tags_remove?, hidden? }` |
| GET | `/api/models/:id/scrape-stream` | **SSE** - Scrape source website for images and metadata |

### Files

| Method | Path | Description |
|---|---|---|
| GET | `/api/files/:fileId/zip-contents` | List images inside a ZIP archive |
| POST | `/api/files/:fileId/extract-images` | Extract selected images from ZIP. Body: `{ entries: string[] }` |
| GET | `/api/files/:fileId/stl` | Stream raw STL file for 3D viewer |

### Creators

| Method | Path | Description |
|---|---|---|
| GET | `/api/creators` | List all creators with model counts |
| PATCH | `/api/creators/:id` | Update creator. Body: `{ render_zip_hint?, notes? }` |
| POST | `/api/creators/:id/reextract` | **SSE** - Re-extract render images for all models by this creator |

### Stats

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats` | Aggregate counts: total models, by status, by source site |

### AI

| Method | Path | Description |
|---|---|---|
| POST | `/api/ai/assist` | Proxy to Claude API. Body: `{ modelId, action?, userMessage?, history[] }`. Requires `x-claude-key` header. |
| POST | `/api/ai/search` | Web search via Claude with `web_search` tool. Body: `{ modelId?, query? }`. Returns `{ text, results[], citations[] }`. Requires `x-claude-key` header. |
| GET | `/api/ai/generate-tags` | **SSE** - Batch AI tagging. Query: `key` (API key). Batches models in groups of 50, streams per-batch progress with token usage, example tags, hit rate. Auto-retries rate limits, stops on auth errors. |
| GET | `/api/ai/find-images` | **SSE** - AI image finder. Query: `key`, `trial` (default `1`). Scores models by matchability, skips poor candidates (<20 pts), processes trial batch of 10 first. Streams per-model progress with confidence indicators. |
| POST | `/api/ai/test-key` | Quick API key validation. Requires `x-claude-key` header. Returns `{ ok, model, usage, message }`. |

### Tags

| Method | Path | Description |
|---|---|---|
| GET | `/api/tags` | List all tags with counts, sorted by frequency. Excludes NULL, empty, and `'[]'` entries. |

### Health & Version

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Server health check. Returns `{ ok, libraryPath, version, build }` |

### Static Files

| Method | Path | Description |
|---|---|---|
| GET | `/images/*` | Serve extracted/scraped images from `/data/images/` |

---

## 5. Scanner Behavior

### Folder Structure

The scanner supports both flat and deeply nested folder structures:

**Flat (2-level):**
```
/library/STL Archive/
  CreatorName/
    ModelName/
      file1.stl
      file2.zip
      renders/image1.png
```

**Nested archive (N-level):**
```
/library/STL Archive/
  Wicked Archive/
    Star Wars/           ← category (no printable files, recurses)
      Vehicles/          ← category
        X-wing/          ← model (has STL/ZIP files)
          x-wing.stl
      Characters/        ← category
        Luke/            ← model
          luke.stl
    Fantasy/             ← category
      Dragons/           ← model
        dragon.stl
```

**Pass-through detection:** If a top-level folder contains ONLY subdirectories (no printable files), it's treated as a library root (e.g., "STL Archive") and its children become the creators. This handles the Docker mount pattern `/volume1/STL Archive:/library/STL Archive:ro` where scanning `/library` would otherwise attribute everything to "STL Archive".

Below the creator level, the `discoverModelFolders()` function recursively walks directories until it finds folders containing printable files (STL, ZIP, RAR, slicer files, gcode). Folders that only contain subdirectories are treated as categories and traversed further. Maximum recursion depth: 5 levels.

**Transaction chunking:** Models are processed in transaction batches of 10 with `setImmediate()` yields between batches, allowing SSE progress to stream in real time (SQLite transactions are synchronous and block the event loop; full scans also run in a worker thread).

Nested models get breadcrumb-style names: `"Star Wars / Vehicles / X-wing"`.

### Ignored Folders

The scanner skips these system/junk folders at all traversal levels (creator, model, category, and file analysis):

```
@eaDir, @tmp, @appstore, @autoupdate, @database, @S2S,
#recycle, #snapshot,
.DS_Store, .Spotlight-V100, .Trashes, .fseventsd,
__MACOSX, Thumbs.db, .synology_cache,
$RECYCLE.BIN, System Volume Information
```

### Junk File Filtering

The `isJunkFile()` function skips individual files matching these patterns at every code path (directory listing, image extraction, folder hashing):

- `@SynoEAStream` - Synology extended attribute streams
- `@SynoResource` - Synology resource forks
- `._*` prefix - macOS resource forks
- `.DS_Store` - macOS folder metadata
- `Thumbs.db` - Windows thumbnail cache

### Scan Optimization (folder_hash)

For each model folder, the scanner computes a SHA-1 hash of all `filename:size:mtime` entries. If the hash matches the stored `folder_hash`, the model is skipped (only `last_scanned` is touched). This makes re-scans of large libraries fast.

**Force rescan** sets all `folder_hash` values to NULL before scanning, causing every model to be re-indexed. This is needed after V1→V2 migration to populate empty `filepath` values.

### Source URL Detection

The scanner infers source URLs from folder names using regex patterns:

| Pattern | Site | URL Template |
|---|---|---|
| `PR-(\d+)` or `printables-(\d+)` | Printables | `https://www.printables.com/model/{id}` |
| `TV-(\d+)` or `thingiverse-(\d+)` | Thingiverse | `https://www.thingiverse.com/thing:{id}` |
| `MMF-(\d+)` | MyMiniFactory | `https://www.myminifactory.com/object/3d-print-{id}` |
| `Cults-` prefix | Cults3D | (marked, no URL) |
| `Gumroad-` prefix | Gumroad | (marked, no URL) |

### Release Name Inference

Files are grouped into "releases" by detecting common prefixes/suffixes in filenames. The `inferReleaseName()` function strips file extensions and groups files that share path segments.

### Render Archive Detection

The `pickRenderArchives()` function identifies ZIP and RAR files containing render images using:

1. Model-level `render_zip_hint` override (highest priority)
2. Creator-level `render_zip_hint` pattern
3. Auto-detection: archives matching keyword patterns: `render`, `preview`, `thumb`, `photo`, `pic`, `image`, `presentation`, and plurals

Supported archive formats: `.zip` (via adm-zip), `.rar` (via node-unrar-js, pure WASM)

`matchesHint(filename, pattern)` supports `*` wildcards converted to regex.

---

## 6. Frontend Components

### App.js (Root)

- Manages global state: view (gallery/detail), selected model, filters, stats, creators
- Fetches `/api/stats`, `/api/creators`, `/api/models` on mount
- Fetches version from `/api/health` and passes to Sidebar
- Auto-opens scan modal if a scan is already in progress on page load
- Passes callbacks for navigation, filtering, and data refresh

### Gallery.js

- Responsive grid of `ModelCard` components
- Each card shows thumbnail with image cycling (hover ‹/› arrows, counter badge)
- Toolbar: search, sort dropdown, tag filter
- `BulkActionBar` for multi-select operations (change status, add tags)
- Filter state from sidebar (status, creator, source site)

### ModelDetail.js

- Full model view with tabbed sections
- Thumbnail strip with ★ set-as-thumbnail button
- Web scraping UI with SSE progress display
- ZIP image picker trigger
- STL file 3D viewer
- Release-grouped file list
- Render hint panel
- Claude AI assistant panel
- Editable fields: name, status, tags, notes, source URL

### Sidebar.js

- Library stats display (total models, status breakdown)
- Status filter buttons
- Show Hidden toggle (appears when hidden models exist)
- Has Thumbnail filter toggle with count
- **Tag cloud:** Clickable chips sorted by frequency (first 30, expandable), AND-logic filtering, CLEAR button
- Creator list with model counts
- Render hint ⚙ config button per creator
- Scan library button
- Version display at bottom (from `/api/health`)

### ScanModal.js

- Path input (defaults to library path)
- Force full rescan checkbox
- **API key input** with show/hide toggle, saved to localStorage, "Test" button for validation
- SSE-connected progress display via TaskLog
- **Scan persistence:** On mount, checks `/api/scan/status` and auto-reconnects to running scan
- **Generate Tags** button - SSE-streamed AI batch tagging with per-batch progress
- **Find Images (trial 10)** button - AI image finder with matchability scoring, trial mode, "Continue All" after trial
- Shows "Checking scan status…" loading state while detecting state
- Start/close controls

### ZipImagePicker.js

- Lists ZIP files for a model via `/api/files/:fileId/zip-contents`
- Shows image entries as checkboxes
- Extract selected images via `/api/files/:fileId/extract-images`
- **Known issue:** ZIP files with empty `filepath` (V1 models) show "File not found on disk" - requires force rescan

### StlViewer.js

- Three.js-based 3D model viewer
- Loads STL files via `/api/files/:fileId/stl`
- Orbit controls (rotate, zoom, pan)
- Wireframe toggle
- Dynamic CDN loading of Three.js, STLLoader, OrbitControls

### ClaudeAssistant.js

- Chat interface for Claude AI integration
- Quick actions: **Find Online** (web search), Suggest Tags, Organize, Print Notes
- "Find Online" uses `/api/ai/search` with Claude's `web_search` tool to find model sources on Printables, MMF, Thingiverse, Cults3D, Patreon, Gumroad
- Search results render as clickable cards with FREE/PAID badges and "SET AS SOURCE URL" button
- Free-text messages with search-like keywords auto-route to the search endpoint
- User-provided Anthropic API key (stored in browser localStorage)
- Sends model context to backend `/api/ai/assist` or `/api/ai/search` endpoints

### TaskLog.js

- Terminal-style scrolling log display
- Used by ScanModal, scrape UI, reextract UI
- Color-coded by message type (info, success, warn, error)

### ReleaseFileList.js

- Groups model files by release name
- Role detection badges (Renders, Supported, FDM, Resin, Pre-supported, etc.)
- File size display

### RenderHintPanel.js

- Creator-level render ZIP hint configuration
- Model-level override
- ZIP file suggestions from existing files
- "Re-extract all" button with SSE progress

---

## 7. Nginx Configuration

`frontend/nginx.conf` is the source of truth. Key rules:

- Every streaming (SSE) route is listed in the regex location (`scan/stream`,
  `models/:id/scrape-stream`, `models/:id/scrape`, `creators/:id/reextract`,
  `ai/generate-tags`, `ai/find-images`, `ai/vision-tags`,
  `organize/auto-annotate`) with `proxy_buffering off`, `Connection ''`,
  HTTP/1.1 and a 1-hour read timeout. The backend also sends
  `X-Accel-Buffering: no` and a `:` heartbeat every 15 s, so streams survive
  extra reverse proxies (e.g. Synology's).
- The access log uses `$uri`, not `$request`, so `?key=` API keys never reach
  `docker logs`.
- The backend is resolved through Docker DNS at request time
  (`resolver 127.0.0.11`), so recreating only the backend never leaves nginx on
  a stale IP.
- `/static/` (hashed assets) is cached for a year; `index.html` is `no-cache`.
- `client_max_body_size 10m` matches the backend's JSON body limit.

---

## 8. Deployment

### CI/CD Pipeline

`.github/workflows/docker-publish.yml`: on every PR and push to `main`, run the
backend (Jest) and frontend tests plus a scan smoke test, build both images,
boot them together and scan a fixture library. Only pushes to `main` (tag
`latest` + `sha-<7 chars>`) and `v*` tags (`X.Y.Z`, `X.Y`) are published to
`ghcr.io/caseyi/stlvault-{backend,frontend}`. Images carry OCI labels and
`GIT_SHA`/`BUILD_DATE`.

### Update Script (`update.sh`)

Run as `sudo sh update.sh [tag]` next to `docker-compose.yml`. It records the
data volume of the running backend, refuses to switch to a different volume
(project-name trap), snapshots the DB into `./backups`
(`vault-pre-update-<timestamp>.db`, newest 5 kept), keeps the running images
as `:pre-update`, pulls, `up -d --wait`, re-checks the volume (restoring the
previous version if it changed), prints version/commit from `/api/health` and
removes old unused Vault images. A tag argument (`sha-1a2b3c4`, `latest`,
`pre-update`) is written to `VAULT_TAG` in `.env`.

### Version Tracking

`backend/version.json` holds `{"version", "build"}`; the image adds `GIT_SHA`
and `BUILD_DATE`. All are shown in the sidebar footer, returned by
`/api/health`, and logged at server startup.

### Backups

The backend writes a daily `vault-YYYYMMDD.db` snapshot (`VACUUM INTO`,
`BACKUP_KEEP` kept) and one before every forced rescan into `BACKUP_DIR`
(`/backups`, bind-mounted from `./backups`). Restore procedure: README →
"Backups and restore".

---

## 9. Design Tokens

### Colors

| Token | Value | Usage |
|---|---|---|
| --bg1 | #0d0d0f | Page background |
| --bg2 | #141418 | Card/panel background |
| --bg3 | #1c1c21 | Elevated surfaces |
| --bg4 | #24242b | Input backgrounds |
| --accent | #c17f3a | Primary accent (warm gold) |
| --text | #e8e8ed | Primary text |
| --text-muted | #7a7a8c | Secondary text |
| --text-faint | #4a4a5a | Tertiary/hint text |
| --border | #2e2e36 | Default borders |
| --border-bright | #3f3f4d | Elevated borders |
| --success | #5cb85c | Success states |
| --warning | #c17f3a | Warning (same as accent) |
| --error | #cf7272 | Error states |

### Fonts

| Token | Font | Usage |
|---|---|---|
| --font-display | 'Bebas Neue' | Headings, buttons, labels |
| --font-body | 'DM Sans' | Body text |
| --font-mono | 'JetBrains Mono' | Code, technical text, counters |

---

## 10. Known Issues & Technical Debt

1. **V1 empty filepath:** Models indexed before the `filepath` column was added have empty strings. Force rescan fixes this but must be run manually after upgrade.

2. **No authentication:** The Vault has no login system. It relies on network isolation (LAN-only access on NAS).

3. **No pagination:** Gallery loads all models at once. Will need pagination or virtual scrolling for very large libraries (1000+ models).

4. **Scraper fragility:** Web scrapers use CSS selectors and page structure that can break when source sites update their HTML.

5. **Single-user:** No concurrent scan protection. Starting a scan while one is running will cause issues.

6. **localStorage for API key:** The Claude API key is stored in browser localStorage - lost on browser data clear.

7. **update.sh is not self-updating:** a new `update.sh` must be copied to the NAS (File Station) before it is run.

---

## 11. File Inventory

```
the-vault/
├── .gitignore
├── CLAUDE.md                # AI assistant context file
├── SPEC.md                  # This file
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── version.json         # Auto-incremented build number
│   ├── db.js                # Schema + migrations
│   ├── server.js            # Express API
│   ├── scanner.js           # Library indexer
│   ├── scraper.js           # Web scraper
│   ├── lib/                 # Shared helpers (SSE, backups, paths, …)
│   └── tests/
│       ├── scanner.test.js
│       ├── api.test.js
│       └── scraper.test.js
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── nginx.conf
│   └── src/
│       ├── App.js
│       ├── App.test.js
│       ├── App.css           # All styles
│       ├── index.js
│       ├── pages/
│       │   ├── Gallery.js
│       │   ├── Gallery.test.js
│       │   ├── ModelDetail.js
│       │   └── ModelDetail.test.js
│       └── components/
│           ├── Sidebar.js
│           ├── Sidebar.test.js
│           ├── ScanModal.js
│           ├── ZipImagePicker.js
│           ├── StlViewer.js
│           ├── ClaudeAssistant.js
│           ├── TaskLog.js
│           ├── ReleaseFileList.js
│           └── RenderHintPanel.js
├── docker-compose.yml
├── update.sh                 # NAS update/rollback (sudo sh update.sh [tag])
├── add-library.sh            # Extra library folders (compose override)
├── native/                   # Tauri desktop app (macOS + Windows)
└── .github/                  # CI workflows, smoke-scan.js, dependabot
```

---

## 12. Test Suite

Counts change often, so they are not listed here; run the suites:

- Backend (Jest): `cd backend && npm test` - scanner, API and scraper tests.
- Frontend (React Testing Library): `cd frontend && CI=true npm test`.
- Scan smoke test (boots the real backend, scans a fixture):
  `node .github/scripts/smoke-scan.js`.

CI runs all three on every PR, plus a container boot/scan test of the built
images.

---

## 13. Dependencies

### Backend (package.json)

`backend/package.json` is authoritative; at the time of writing:

| Package | Purpose |
|---|---|
| express | HTTP server + routing |
| node:sqlite (built into Node 22) | Synchronous SQLite driver - no native addon |
| adm-zip | ZIP file reading/extraction |
| node-unrar-js | RAR file extraction (pure WASM, no native deps) |

No dependency needs a compiler, so the Docker image has no build toolchain.

### Frontend (package.json)

| Package | Purpose |
|---|---|
| react | UI framework |
| react-dom | DOM rendering |
| react-scripts | CRA build toolchain |
| three | STL preview (StlViewer.js), bundled from npm - no CDN scripts |
