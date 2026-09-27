# The Vault - Handoff Note

_Last updated: 2026-09-27 (ops/deploy sections for review/2026-09-hardening). Snapshot of where things stand so work can resume cleanly._

## What this repo is
Self-hosted 3D-print library manager. **Docker/NAS** deployment is the primary path
(React frontend + Node backend + SQLite, served on a NAS). A **native desktop** build
(Tauri, macOS + Windows) was added this session and is additive - Docker stays.
Repo: `github.com/caseyi/The-Vault` (public). Published GHCR images keep the name
`stlvault-backend` / `stlvault-frontend` (intentionally - don't rename, it'd break the
NAS update path).

## Shipped this session (all on `main`)
- **DB driver → `node:sqlite`** (Node 22 image), `better-sqlite3` removed. Same on-disk
  SQLite file, so existing `vault.db` works unchanged.
- **Smart scan**: recursive pass-through classifier (creators no longer flattened),
  per-folder **role overrides** (Organize → Advanced → Folder Roles), and **AI folder
  classification** (suggest roles for ambiguous folders).
- **Scans run in a worker thread** (never block the server) + **app-wide background
  indicator** (sidebar shows live count), **Stop Scan**, and **Minimize** to keep browsing.
- **Deterministic thumbnail ranking** (best render becomes the thumbnail).
- **Duplicate cleanup workflow** (Health tab: pick keeper → merge tags/collections, hide rest).
- **AI cost clarity** ($-marked buttons, greyed without key, console.anthropic.com link),
  model selector + cost estimate, **vision tagging**, **tag manager** (rename/merge/delete),
  faceted tags.
- **Favorites ⭐**, collapsible+remembered sidebar sections, compact density, **light/dark
  toggle**, beefed-up Collections (pin/recolor/cover), better Print Queue (inline status,
  mark-printed, notes), **image lightbox** (click-to-zoom + arrow keys), large-render fit fix,
  brighter dark-mode text, first-run **onboarding**.
- **Native app (Tauri) M0–M5**: `native/` project, Node backend sidecar + Node-22 runtime
  bundled, fetch/SSE patch (frontend unmodified), native folder picker, CI matrix
  (`.github/workflows/native-build.yml`) building **unsigned** mac+win installers to a draft
  GitHub Release on `native-v*` tags. Ad-hoc signed (fixes "damaged"); see `native/README.md`.

## After merging review/2026-09-hardening (DRAFT - lead to finalize)

One-time, in this order:

1. **Lockfiles**: commit `backend/package-lock.json`, `frontend/package-lock.json`,
   `native/package-lock.json` and `native/src-tauri/Cargo.lock` (no longer gitignored;
   Docker + CI use `npm ci`, and `setup-node` caching needs them).
2. **Merge → watch CI**: `docker-publish.yml` must go green on the PR (tests, image
   build, container boot + scan smoke) before merge; on `main` it pushes `latest` and
   `sha-<7>`. No new secrets needed (uses `GITHUB_TOKEN`). Optional: enable Dependabot
   in repo settings (config is in `.github/dependabot.yml`).
3. **On Dagobah** (File Station, into the existing app folder - check which one first
   with `sudo docker volume ls | grep vault_data`: the folder name must match the volume
   prefix, e.g. `/volume1/docker/the-vault` ↔ `the-vault_vault_data`):
   - upload the new `docker-compose.yml` and `update.sh` (keep the existing `.env`;
     optionally add `TZ`, `BACKUP_KEEP`, `ORGANIZE_SSH_TARGET` from `.env.example`);
   - run `sudo sh update.sh`. First run: it snapshots the DB via the *old* container
     (copied out with `docker cp` since the old container has no `/backups` mount),
     checks the volume, pulls, restarts, and prints the new `gitSha`.
   - If it stops with "DIFFERENT data volume" / "NEW, EMPTY data volume": nothing was
     changed; set `COMPOSE_PROJECT_NAME=<prefix of the volume with your data>` in `.env`
     and re-run.
4. **Verify**: sidebar shows version + commit; `backups/` contains
   `vault-pre-update-*.db`; next day a `vault-YYYYMMDD.db` appears. Add
   `/volume1/docker/the-vault` to Hyper Backup.
5. **Cleanup (optional)**: `sudo docker rmi ghcr.io/caseyi/stlvault-backend:rollback
   ghcr.io/caseyi/stlvault-frontend:rollback` (old script's rollback tags).
6. **Optional**: DSM Task Scheduler weekly `sh /volume1/docker/the-vault/update.sh` as
   root (README → Updating).
7. **Force-rescan** only if the library still shows mis-grouped creators (it now
   snapshots the DB first).

## Pending / next
- **Native auto-update**: documented opt-in recipe in `native/README.md` (needs a one-time
  `tauri signer generate` key + CI secrets). Not wired, to keep the build green.
- **Notarization** (remove macOS/Windows Gatekeeper warnings): deferred - needs Apple
  Developer ID ($99/yr) + Windows cert wired into the workflow.
- **Improvement backlog (not started):** per-model AI in the detail view; browsing/keyboard
  shortcuts (gallery arrow-nav, status hotkeys, saved views); print-workflow depth
  (plates/print-time, queue grouping by printer/material).
- **Wiki**: usage guide drafted (was in outputs as `The-Vault-Wiki-Home.md`); needs the wiki
  initialized (create first page) before it can be pushed.

## How to work in this repo (operational gotchas)
- **Committing from the sandbox fails** (can't unlink `.git/*.lock` on the mount). Commit +
  push via the **Control-your-Mac connector** running git in the repo dir:
  `rm -f .git/*.lock && git add -A && git commit -m ... && git push https://x-access-token:<PAT>@github.com/caseyi/The-Vault.git main`
- **Lockfiles are committed**; Docker and CI use `npm ci`. Update the lockfile with every dependency change.
- **Verify before committing**: `node --check backend/*.js`; frontend `CI=true BUILD_PATH=/tmp/x npx react-scripts build` (the mounted `frontend/build` can't be overwritten in-sandbox - build to /tmp).
- **Native**: `cargo check`/`clippy` works in a Linux sandbox with WebKit dev packages (use a temp copy with a built frontend and a stub `icons/icon.png`; never commit stubs). Installers build in CI or on the Mac.
- **Ops validation** before committing ops files: `shellcheck -s sh *.sh native/scripts/*.sh`, `hadolint backend/Dockerfile frontend/Dockerfile`, `actionlint`, `docker compose config` with a sample `.env`.
