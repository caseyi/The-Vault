# The Vault — Native App (Tauri, macOS + Windows)

This wraps the **existing** React frontend + Node backend in a [Tauri](https://tauri.app)
desktop shell. No app logic is rewritten: the frontend ships as-is, and the Node backend
runs as a bundled sidecar the shell starts/stops. macOS and Windows build from the same
source via one CI matrix.

> ⚠️ **Must be built on a real machine with the toolchain** (Rust + Tauri CLI). It cannot
> be compiled in the cloud sandbox, so treat this as a working scaffold to run + iterate
> locally, not a pre-verified binary.

## Prerequisites (one-time, on your Mac)

```sh
# Rust + Tauri CLI
curl https://sh.rustup.rs -sSf | sh
cargo install tauri-cli --version "^2"
# Node 22 (matches the backend's node:sqlite requirement)
```

## Run in dev

```sh
# 1. Build the frontend once (Tauri loads its static output)
cd frontend && npm install && npm run build && cd ..
# 2. Stage the backend as a bundled resource (installs prod deps for THIS OS)
native/scripts/bundle-backend.sh
# 3. Generate the app icons from the committed logo (once, or when the logo changes)
cd native && npm install && npx tauri icon src-tauri/icon-source.png
# 4. Launch the desktop app
npm run tauri dev
```

## Build installers

```sh
cd native && npm run tauri build
# → macOS: src-tauri/target/release/bundle/dmg/*.dmg
# → Windows: ...\bundle\nsis\*-setup.exe   (run on Windows)
```

## How it fits together

- **Frontend**: `tauri.conf.json` → `build.frontendDist` points at `../../frontend/build`.
  The frontend's API calls are relative (`/api/...`); `main.rs` injects a tiny init script
  that rewrites `/api` and `/images` to `http://127.0.0.1:<port>` so **no frontend code
  changes are needed**.
- **Backend**: staged into `src-tauri/resources/backend` (source + prod `node_modules`) by
  `scripts/bundle-backend.sh`, plus a Node runtime. `main.rs` spawns it on launch with
  `DB_PATH`/`IMAGES_DIR` pointed at the OS app-data dir, and kills it on quit.
- **Library folder**: chosen via the native folder picker (tauri-plugin-dialog) and saved
  to app config → passed to the backend as `LIBRARY_PATH`. (On a NAS, mount the SMB share
  in Finder/Explorer first, then pick the mounted path — no CIFS-in-container needed.)

## Milestone status

- **M0 — shell + spawn**: done — `main.rs` spawns the backend + injects the fetch/SSE patch. Run `tauri dev` to verify locally.
- **M1 — DB de-risk**: done — backend uses `node:sqlite` (Node 22), no native `better-sqlite3`.
- **M2 — backend + Node bundling**: done — `scripts/bundle-backend.sh` stages the backend + prod deps; CI downloads a pinned Node 22 binary into `resources/node/` per OS; `main.rs` spawns it (falls back to a `node` on PATH).
- **M3 — native config**: done — `set_library_path`/`get_library_path` commands persist the folder to `config.json` and restart the backend; the Scan dialog shows a **📁 Choose library folder…** button in the desktop build (hidden in the browser/Docker build).
- **M4 — CI matrix**: done — `.github/workflows/native-build.yml` builds macOS + Windows, unsigned, attaching installers to a draft GitHub Release on a `native-v*` tag.
- **M5 — polish**: app icon **done** — real logo committed at `src-tauri/icon-source.png`, generated into the full icon set by `npx tauri icon` (CI does this automatically). Remaining: Tauri auto-updater + first-run onboarding.

> Still requires a local Rust + Tauri toolchain to compile and a real test run; the cloud sandbox can't build native binaries.

## Known TODOs / decisions

- **Node runtime bundling** is the main remaining piece: simplest is to ship a per-OS Node
  binary in `resources/` and have `main.rs` spawn it; alternatively require Node 22 on the
  user's machine for v1. (`sharp` keeps native binaries in `node_modules`, which is why we
  ship `node_modules` rather than a single packed binary.)
- **Unsigned** for v1 (per decision) — users will see Gatekeeper/SmartScreen warnings;
  document "right-click → Open" / "More info → Run anyway".
- The **Docker/NAS** deployment is unchanged and stays the primary path for self-hosters.
