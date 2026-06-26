# The Vault — Native App Workplan (macOS + Windows)

Goal: ship The Vault as a real desktop app for **macOS** and **Windows**, *built from the
existing codebase*, with Windows planned from day one so we never build the same thing
twice. The Docker/NAS version stays — native is **additive**, aimed at single-machine
users who don't want to run Docker.

---

## 1. Approach & key decision

**Wrap the existing app with [Tauri](https://tauri.app), don't rewrite it.**

- The React frontend ships **as-is** (it already builds to static files).
- The Node/Express backend runs as a bundled **sidecar** process the Tauri shell starts
  and stops. No port-8484-in-Docker; the shell talks to `localhost` on a random free port.
- The Tauri shell (Rust) is **one codebase that compiles to both macOS and Windows**.

Why Tauri over Electron: ~10 MB vs ~100 MB, uses the OS webview, and has first-class
cross-platform packaging + updater. Electron is the fallback if a blocker appears.

**What is shared vs platform-specific** (this is how we avoid double work):

| Shared across both OSes (build once) | Platform-specific (isolate + CI matrix) |
|---|---|
| React frontend | `better-sqlite3` native binary per OS/arch |
| Node backend, scanner, AI, DB schema | Code signing / notarization config |
| Tauri shell (Rust) logic | Installer artifacts (.dmg vs .msi) |
| Folder picker, config, paths (Tauri APIs) | Auto-update signing keys |

The only real per-platform work is **native-module bundling + signing/installers** —
everything else is one build. We set up a **GitHub Actions matrix (macos + windows)**
from the very first CI run so Windows is never an afterthought.

---

## 2. The technical risks (call them out now)

1. **`better-sqlite3` is a native addon** — the single biggest risk. Bundling it into a
   shippable binary per OS/arch (mac arm64, mac x64, win x64) is fiddly.
   - **Recommended de-risk:** migrate DB access from `better-sqlite3` to Node's built-in
     **`node:sqlite`** (synchronous, similar API, no native addon to bundle). This removes
     the hardest packaging problem *and* simplifies the Docker image. It's a contained
     refactor of `db.js` + the prepared-statement call sites. Do this **first**, before any
     Tauri work — it benefits both the Docker and native builds.
2. **Signing costs / friction:** Apple Developer Program ($99/yr) for notarization;
   a Windows code-signing certificate (or users see SmartScreen warnings). Plan a
   mac-first **unsigned dev build** so we get a working app before paying for signing.
3. **Scan performance** is already handled (worker thread) and carries straight over.

---

## 3. Architecture changes (Docker → native)

- **Library folders:** replace Docker volume mounts with a native **folder picker**
  (Tauri dialog) that sets `LIBRARY_PATH` and persists it. *Bonus:* remote NAS shares are
  simpler natively — the user mounts the SMB share in Finder/Explorer and just picks the
  mounted path; no CIFS-in-container plumbing.
- **Data location:** `vault.db` + extracted images move to the per-OS app-data dir
  (Tauri path API) instead of a Docker named volume.
- **Config:** the `.env`/compose model becomes an in-app **Settings** screen (library
  folders, Claude API key, model choice) — most of the UI already exists in the Scan modal.
- **Backend lifecycle:** Tauri spawns the Node sidecar on launch, waits for health, opens
  the window; shuts it down on quit.

---

## 4. Milestones

- **M0 — Spike (mac, unsigned):** Tauri shell loading the built frontend, talking to a
  locally-run backend. Proves the wrapper works end-to-end. *(~days)*
- **M1 — DB de-risk:** migrate `db.js` to `node:sqlite` (or confirm a prebuilt-binary
  pipeline for `better-sqlite3`). Backend runs with no native-addon headaches.
- **M2 — Sidecar bundling:** package the Node backend so Tauri ships and runs it; app
  launches with no external deps (mac arm64 first).
- **M3 — Native config:** folder picker + Settings + app-data paths; remove Docker
  assumptions. Now a usable mac app.
- **M4 — Windows parity:** add Windows to the CI matrix from the same source; fix path/OS
  differences; produce a Windows build. *(Because everything's shared, this should be small.)*
- **M5 — Signing & installers:** Apple notarization + `.dmg`; Windows code-sign + `.msi`/NSIS.
- **M6 — Polish:** Tauri auto-updater, app icon, first-run onboarding, native menus.

Keep the Docker images building the whole time — native and server tracks live side by side.

---

## 5. Open questions for Casey

1. OK to migrate off `better-sqlite3` to `node:sqlite` (recommended) — it touches `db.js`
   and DB calls but removes the worst packaging pain and helps Docker too?
2. Mac-only first, or Windows in lockstep from M0? (Plan supports either; lockstep costs a
   little more up front, saves rework later.)
3. Willing to pay for signing (Apple $99/yr + a Windows cert), or is an unsigned/"allow
   anyway" build acceptable for v1?
4. Distribution: GitHub Releases (.dmg/.msi) to start, or also a Homebrew cask / winget later?
