# The Vault - Native App (Tauri, macOS + Windows)

This wraps the **existing** React frontend + Node backend in a [Tauri](https://tauri.app)
desktop shell. No app logic is rewritten: the frontend ships as-is, and the Node backend
runs as a bundled sidecar the shell starts/stops. macOS and Windows build from the same
source via one CI matrix.

> Installers are built by CI (`.github/workflows/native-build.yml`) or on a machine with
> Rust + the Tauri CLI. The Rust side can be type-checked anywhere with the Linux WebKit
> dev packages (`cargo check` / `cargo clippy` in `src-tauri`, with the frontend built and
> a stub `icons/icon.png`), but running the app still needs a real macOS/Windows test.

## First launch (installing a downloaded build)

These builds are **ad-hoc signed but not notarized** (no paid Apple/Windows certificate
yet), so the OS shows a one-time warning. This is expected - here's how to get past it.

### macOS

1. Open the `.dmg` and drag **The Vault** to **Applications**.
2. **Right-click** the app in Applications → **Open** → **Open** (don't double-click the
   first time). After this once, it launches normally.

If you instead see **"The Vault is damaged and can't be opened"**, that build wasn't
ad-hoc signed (older artifact) - grab the latest release, or fix the installed copy from
**Terminal**:

```sh
APP="/Applications/The Vault.app"
sudo xattr -rd com.apple.quarantine "$APP"
sudo codesign --force --sign - "$APP/Contents/Resources/resources/node/node"
sudo codesign --force --deep --sign - "$APP"
```

> If those commands return **"Operation not permitted"**, grant your terminal **Full Disk
> Access** (System Settings → Privacy & Security → Full Disk Access), or just download the
> latest ad-hoc-signed release and use right-click → Open.

### Windows

SmartScreen will warn on first run: click **More info → Run anyway**.

### Making the warnings go away for good

Ship a notarized build: an Apple **Developer ID** ($99/yr) + macOS notarization, and a
Windows code-signing certificate. Wire the signing secrets into
`.github/workflows/native-build.yml` (tauri-action supports `APPLE_*` / Windows signing
env). Deferred for v1 by choice.

### First run inside the app

On first launch the library is empty. Open **⟳ Scan Library** → click
**📁 Choose library folder…**, pick your 3D-print folder (for a NAS, mount the share in
Finder/Explorer first and pick the mounted path), then **Start Scan**. The database,
extracted images, daily DB snapshots (`backups/`) and the backend log (`backend.log`) live
in the OS app-data dir (macOS: `~/Library/Application Support/org.thevault.desktop/`,
Windows: `%APPDATA%\org.thevault.desktop\`), so they persist across updates. If the
library service can't start, the app shows an error dialog pointing at `backend.log`.

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
cd frontend && npm ci && npm run build && cd ..
# 2. Stage the backend as a bundled resource (installs prod deps for THIS OS)
native/scripts/bundle-backend.sh
# 3. Generate the app icons from the committed logo (once, or when the logo changes)
cd native && npm ci && npx tauri icon src-tauri/icon-source.png
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
  changes are needed**. The port is picked at launch (a free loopback port), not fixed.
  A CSP in `tauri.conf.json` limits the webview to its own files, the local backend and
  Google Fonts (`withGlobalTauri` stays on: the Scan dialog uses `window.__TAURI__` for the
  folder picker).
- **Backend**: the whole `backend/` folder (minus tests/dev files) plus prod `node_modules`
  is staged into `src-tauri/resources/backend` by `scripts/bundle-backend.sh` (fails loudly
  on any copy error), plus a Node 22 runtime that CI verifies against nodejs.org's
  `SHASUMS256.txt`. `main.rs` spawns it with `HOST=127.0.0.1` (never reachable from the
  LAN), the chosen `PORT`, and `DB_PATH`/`IMAGES_DIR`/`BACKUP_DIR` in the app-data dir;
  stdout/stderr go to `backend.log` (rotated at 5 MB). It polls `/api/health` for 15 s after
  each start, and kills **and waits for** the process on quit and before restarting it.
- **Library folder**: chosen via the native folder picker (tauri-plugin-dialog) and saved
  to app config → passed to the backend as `LIBRARY_PATH`. (On a NAS, mount the SMB share
  in Finder/Explorer first, then pick the mounted path - no CIFS-in-container needed.)

## Milestone status

- **M0 - shell + spawn**: done - `main.rs` spawns the backend + injects the fetch/SSE patch. Run `tauri dev` to verify locally.
- **M1 - DB de-risk**: done - backend uses `node:sqlite` (Node 22), no native `better-sqlite3`.
- **M2 - backend + Node bundling**: done - `scripts/bundle-backend.sh` stages the backend + prod deps; CI downloads a pinned Node 22 binary into `resources/node/` per OS; `main.rs` spawns it (falls back to a `node` on PATH).
- **M3 - native config**: done - `set_library_path`/`get_library_path` commands persist the folder to `config.json` and restart the backend; the Scan dialog shows a **📁 Choose library folder…** button in the desktop build (hidden in the browser/Docker build).
- **M4 - CI matrix**: done - `.github/workflows/native-build.yml` builds macOS + Windows, ad-hoc signed. A `native-vX.Y.Z` tag stamps version X.Y.Z into `tauri.conf.json` and attaches installers to a draft GitHub Release (re-runs upload into the same release; nothing is deleted). Manual runs build `0.0.0-dev+<sha>` and keep the installers as workflow artifacts. The bundled Node + staged backend pass the scan smoke test before packaging.
- **M5 - polish**: app icon **done** (`src-tauri/icon-source.png` → `tauri icon`). First-run **onboarding done** (welcome modal when the library is empty, shared by web + native). **Auto-update**: enablement recipe below (needs a one-time signing key, so it's opt-in to keep the build green).

### Enabling auto-update (one-time)

Tauri's updater needs its own signing keypair (separate from code signing) so clients trust update payloads.

```sh
# 1. Generate an updater keypair (keep the private key + password secret)
cd native && npx tauri signer generate -w vault-updater.key

# 2. Add the plugin
#    Cargo.toml:  tauri-plugin-updater = "2"
#    main.rs:     .plugin(tauri_plugin_updater::Builder::new().build())
```

```jsonc
// 3. tauri.conf.json
"bundle": { "createUpdaterArtifacts": true },
"plugins": {
  "updater": {
    "pubkey": "<PASTE the public key printed in step 1>",
    "endpoints": ["https://github.com/caseyi/The-Vault/releases/latest/download/latest.json"]
  }
}
```

```yaml
# 4. CI (.github/workflows/native-build.yml) - pass the private key to tauri-action:
#    env:
#      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
#      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
#    and set `includeUpdaterJson: true` in the tauri-action `with:` block.
```

Then the app checks the release's `latest.json` on launch and offers to update. Add the
JS check (or do it in `main.rs`) once the keys/secrets are in place.

> Needs a real test run on macOS/Windows after wiring the keys.

## Known TODOs / decisions

- **Node runtime**: CI bundles the latest Node 22 per OS (notarized upstream binary on
  macOS; don't re-sign it). A `node` v22.13+ on PATH is the fallback in dev.
- **macOS entitlements**: `allow-dyld-environment-variables` is probably unnecessary; remove
  it in a release that gets a real Gatekeeper test.
- **Unsigned** for v1 (per decision) - users will see Gatekeeper/SmartScreen warnings;
  document "right-click → Open" / "More info → Run anyway".
- The **Docker/NAS** deployment is unchanged and stays the primary path for self-hosters.
