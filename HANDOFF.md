# The Vault — Handoff Note

_Last updated: 2026-06-29. Snapshot of where things stand so work can resume cleanly._

## What this repo is
Self-hosted 3D-print library manager. **Docker/NAS** deployment is the primary path
(React frontend + Node backend + SQLite, served on a NAS). A **native desktop** build
(Tauri, macOS + Windows) was added this session and is additive — Docker stays.
Repo: `github.com/caseyi/The-Vault` (public). Published GHCR images keep the name
`stlvault-backend` / `stlvault-frontend` (intentionally — don't rename, it'd break the
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

## Pending / next
- **Server-side action (Casey):** on the NAS, `sudo docker compose pull && up -d`, then
  **force-rescan** so the library re-groups under correct creators (Stage-1 classifier).
- **Native auto-update**: documented opt-in recipe in `native/README.md` (needs a one-time
  `tauri signer generate` key + CI secrets). Not wired, to keep the build green.
- **Notarization** (remove macOS/Windows Gatekeeper warnings): deferred — needs Apple
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
- **Lockfiles are gitignored**, so CI uses `npm install` (not `npm ci`).
- **Verify before committing**: `node --check backend/*.js`; frontend `CI=true BUILD_PATH=/tmp/x npx react-scripts build` (the mounted `frontend/build` can't be overwritten in-sandbox — build to /tmp).
- **Native builds can't be compiled in the sandbox** (no Rust/Tauri) — they build in CI or on the Mac.
