
# The Vault 🗃️

Self-hosted 3D print library manager for your NAS. Indexes STL/ZIP/slicer files,
extracts render images, tracks print status, and lets you ask Claude AI to help
organise your collection.

<img width="1647" height="1114" alt="Screenshot 2026-06-26 at 12 35 21 PM" src="https://github.com/user-attachments/assets/35daf5fc-b167-426b-9724-e1458a8fbbeb" />

- 🖼️ Auto-extracts preview images from render ZIPs
- 🗂️ Browse by folder tree, creator, franchise, tags, or collections
- 🖨️ Track print status (unprinted → sliced → printing → printed → painted) and a print queue
- 🤖 Optional Claude AI: auto-tagging, online image finder, per-model chat
- 📦 Runs entirely on your own hardware - your files never leave your network

<!-- Badges: update the links below to match your repo / donation pages. -->
[![License: MIT](https://img.shields.io/badge/License-MIT-c17f3a.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/caseyi)

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start-first-time)
- [Step-by-step install (Windows / macOS / Synology)](#step-by-step-install)
- [Setting your library folders](#setting-your-library-folders)
  - [The easy way - add-library.sh](#the-easy-way--add-librarysh)
  - [A folder on this machine](#a-folder-on-this-machine)
  - [A second local folder](#a-second-local-folder)
  - [A folder on another NAS over SMB / CIFS](#a-folder-on-another-nas-over-smb--cifs)
- [Folder structure expected](#folder-structure-expected)
- [Updating, pinning and rolling back](#updating-pinning-and-rolling-back)
- [Backups and restore](#backups-and-restore)
- [Which version am I running?](#which-version-am-i-running)
- [AI features (Claude API)](#ai-features-claude-api)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development (local build)](#development-local-build)
- [CI / CD](#ci--cd)
- [License](#license)
- [Support the project](#support-the-project)

---

## Requirements

- A machine that runs **Docker** and **Docker Compose v2** (a Synology/QNAP NAS,
  a Linux box, a Mac, or a Raspberry Pi all work). On Synology, install
  "Container Manager" from the Package Center.
- Your 3D print files in a folder that machine can read.
- *(Optional)* an Anthropic **Claude API key** if you want the AI features.

No build tools, Node, or Python needed on the host - the app ships as pre-built
Docker images.

---

## Quick start (first time)

```sh
# 1. Clone the repo
git clone https://github.com/caseyi/The-Vault.git
cd The-Vault

# 2. Create your config file from the template
cp .env.example .env

# 3. Edit .env and point LIBRARY_HOST_PATH at your 3D print folder
nano .env            # (or open it in any text editor)

# 4. Start
docker compose up -d

# 5. Open in a browser
#    http://YOUR-NAS-IP:8484
```

Then click **⟳ SCAN LIBRARY** in the sidebar to index your files.

Docker images are pulled automatically from GitHub Container Registry - no local
build needed. On a Synology NAS, follow the Synology steps under
[Step-by-step install](#step-by-step-install) instead: they don't need git.

---

## Step-by-step install

Don't have Docker yet? Pick your platform below. Each guide gets you from zero to
The Vault running in your browser.

> A quick note on **where your files live**. If your prints are on the *same*
> machine you're installing on, point `LIBRARY_HOST_PATH` at that local folder. If
> they're on a *different* NAS on your network, leave the local path as-is and use
> the [SMB / CIFS section](#a-folder-on-another-nas-over-smb--cifs) to mount that
> NAS instead.

### 🪟 Windows

1. **Install Docker Desktop.** Download it from the official guide and run the
   installer - it will enable WSL 2 for you if needed:
   <https://docs.docker.com/desktop/setup/install/windows-install/>
   Reboot if prompted, then launch **Docker Desktop** and wait for it to say
   "Engine running".
2. **Install Git** (to download the project): <https://git-scm.com/download/win>
   *(Or download the repo as a ZIP from GitHub and unzip it.)*
3. **Get the project.** Open **Command Prompt** (type `cmd` in the Start menu and
   press Enter) and run:
   ```bat
   git clone https://github.com/caseyi/The-Vault.git
   cd The-Vault
   copy .env.example .env
   notepad .env
   ```
4. **Set your folder.** In `.env`, set `LIBRARY_HOST_PATH` to your prints folder
   using forward slashes, e.g. `LIBRARY_HOST_PATH=C:/Users/you/3DPrints`. Save.
5. **Start it:**
   ```bat
   docker compose up -d
   ```
6. Open **http://localhost:8484** and click **⟳ SCAN LIBRARY**.

> The first time Docker accesses a new drive it may pop up a **"file sharing"**
> permission prompt - click **Share it**.

### 🍎 macOS

1. **Install Docker Desktop** - pick the build for your chip (Apple Silicon vs
   Intel): <https://docs.docker.com/desktop/setup/install/mac-install/>
   Open **Docker Desktop** from Applications and wait until the whale icon shows
   "Engine running".
2. **Get the project.** Open **Terminal** (Git ships with the Xcode command-line
   tools; macOS will offer to install them if needed):
   ```sh
   git clone https://github.com/caseyi/The-Vault.git
   cd The-Vault
   cp .env.example .env
   open -e .env
   ```
3. **Set your folder.** In `.env`, set `LIBRARY_HOST_PATH` to your prints folder,
   e.g. `LIBRARY_HOST_PATH=/Users/you/3DPrints`. Save.
4. **Start it:**
   ```sh
   docker compose up -d
   ```
5. Open **http://localhost:8484** and click **⟳ SCAN LIBRARY**.

> If you keep prints on an external/network drive, Docker Desktop may ask you to
> add the folder under **Settings → Resources → File sharing**.

### 🗄️ Synology NAS

This is the setup The Vault is developed on (DSM 7, Container Manager). You only
need three files from this repo; no git on the NAS.

Synology renamed its Docker package to **Container Manager** in DSM 7.2 (x86_64
"+"/"xs" models; ARM models can't run it).

1. **Install Container Manager** from **Package Center**.
2. **Create the app folder.** In **File Station**, create
   `docker/the-vault` on `volume1` (i.e. `/volume1/docker/the-vault`).
   > The folder name matters: Docker names your data volume after it
   > (`the-vault_vault_data`). Pick it once and keep it. See
   > [Backups and restore](#backups-and-restore).
3. **Upload three files** into it (download them from GitHub → the file → *Download raw file*):
   - `docker-compose.yml`
   - `.env.example` - upload it, then rename it to **`.env`** in File Station
     (if your computer won't save a file starting with a dot, upload it as
     `env.txt` and rename it there)
   - `update.sh`
4. **Edit `.env`** (right-click → *Open with Text Editor*): set
   `LIBRARY_HOST_PATH` to your prints share, e.g. `LIBRARY_HOST_PATH=/volume1/STL Archive`
   (no quotes, spaces are fine), and optionally `CLAUDE_API_KEY`, `WEB_PORT`, `TZ`.
5. **Start it**, either way:
   - **Container Manager → Project → Create**: *Project name* `the-vault`
     (same as the folder), *Path* `/volume1/docker/the-vault`, *Source*: use the
     existing `docker-compose.yml`, then **Next → Done**. Or
   - over SSH (Control Panel → Terminal & SNMP → enable SSH):
     ```sh
     cd /volume1/docker/the-vault
     sudo docker compose up -d
     ```
6. Open **http://YOUR-NAS-IP:8484** and click **⟳ SCAN LIBRARY**.

The folder now also contains a `backups/` folder (database snapshots, see
below). Your library share is mounted **read-only**: The Vault never modifies
your files.

**Updating on Synology:** `sudo sh /volume1/docker/the-vault/update.sh`
(details in [Updating](#updating-pinning-and-rolling-back)). Upload a newer
`update.sh`/`docker-compose.yml` with File Station when the release notes say so.

---

## Setting your library folders

All paths live in the **`.env`** file (copied from `.env.example`). You never
have to edit `docker-compose.yml` by hand. After changing `.env`, apply it with:

```sh
docker compose up -d        # on Synology: sudo docker compose up -d
```

> **How paths work:** The container can only see folders you explicitly give it.
> Each library folder is mounted **read-only** under `/library/<name>` inside the
> container, and the app scans everything under `/library`. The Scan dialog shows
> the folders it can currently see, so you can confirm a mount worked.

### The easy way - `add-library.sh`

To **add an extra** library folder (local or on another NAS over SMB) without
editing config by hand, use the helper script. It writes a
`docker-compose.override.yml` that mounts the new folder *in addition to* your
primary library, then restarts. Run it from your project folder:

```sh
sh add-library.sh            # interactive - pick local or SMB and answer the prompts
sh add-library.sh --list     # show the extra libraries you've added
```

It asks for a label and either a local path or SMB details (server IP, share
name, username/password). Re-run it any time to add more. Its records
(`.vault-libraries`) and the override file are created private (chmod 600)
because they can hold SMB credentials. Prefer to do it by hand? The sections
below show the manual `.env` route.

> **Network shares on Synology - preferred way:** mount the other NAS's share in
> DSM first (**File Station → Tools → Mount Remote Folder → CIFS Shared Folder**,
> e.g. to `/volume1/remote/endor`), then add that mount point as a *local* folder
> (choice 1). DSM stores the password and reconnects after reboots, and there
> are no restrictions on password characters. The script's SMB option refuses
> passwords containing a comma (Docker's CIFS options are comma-separated).

> On a NAS without `git`, fetch just the script first:
> `wget -O add-library.sh https://raw.githubusercontent.com/caseyi/The-Vault/main/add-library.sh`

### A folder on this machine

This is the common case - your prints are on the same NAS/host that runs Docker.
Set these two values in `.env`:

```ini
LIBRARY_HOST_PATH=/volume1/STL Archive   # the real path on your NAS
LIBRARY_NAME=STL Archive                 # the label shown in the app
```

Spaces are fine - do **not** wrap the value in quotes.

### A second local folder

Want to index a second folder on the same machine? In `.env`, set:

```ini
LIBRARY2_HOST_PATH=/volume1/More Prints
LIBRARY2_NAME=More Prints
```

…then open `docker-compose.yml` and **uncomment** the matching line under
`volumes:`:

```yaml
      - ${LIBRARY2_HOST_PATH}:/library/${LIBRARY2_NAME:-More Prints}:ro
```

Run `docker compose up -d` again.

### A folder on another NAS over SMB / CIFS

If your prints live on a **different** NAS reached over the network, the most
robust option on Synology is DSM's *Mount Remote Folder* (see the tip above) plus
a local-folder entry. Alternatively, mount its SMB/CIFS share straight into the
container. Fill in the `SMB_*` values in `.env`:

```ini
SMB_HOST=192.168.1.50    # the other NAS hostname or IP (no slashes)
SMB_SHARE=3dprints       # the shared folder name on that NAS
SMB_USER=youruser        # a user that can read the share
SMB_PASS=yourpassword    # that user's password
SMB_NAME=remote          # the label shown in the app
```

Then in `docker-compose.yml`, **uncomment** two things:

1. The volume line under the backend service:
   ```yaml
         - smb_library:/library/${SMB_NAME:-remote}:ro
   ```
2. The whole `smb_library:` block at the bottom of the file.

Apply with `docker compose up -d`. The share mounts at `/library/<SMB_NAME>` and
gets scanned like any local folder.

> **Notes on SMB:** The default options request SMB protocol `vers=3.0`. Older
> NAS devices may need `vers=2.1` or `vers=1.0` - change it in the `o:` line of
> the `smb_library` block. `uid=1000,gid=1000` make the files readable inside the
> container. Because `.env` holds the share password in plain text, keep that file
> private (it is already gitignored). A password containing a comma can't be used
> this way; a password containing `$` must be wrapped in single quotes in `.env`
> (`SMB_PASS='pa$word'`).

---

## Folder structure expected

```
/volume1/STL Archive/        ← your library root (mapped to /library/STL Archive)
  CreatorName/               ← one folder per creator
    ReleaseName/             ← release = subfolder name  (e.g. "FDM", "Resin v2")
      model.stl
      renders.zip
    AnotherRelease.zip       ← or a ZIP at creator level
```

Files inside each release folder are grouped by release name in the UI.
ZIPs named with "render/preview/photo" keywords are auto-extracted for images.

The scanner supports deeply nested archive structures too (e.g.,
`Creator/Category/Subcategory/Model` up to 5 levels deep). If your Docker mount
places creators under a root folder like `/library/STL Archive`, the scanner
auto-detects this "pass-through" directory and treats its children as the real
creators.

---

## Updating, pinning and rolling back

Every push to `main` publishes new images tagged `latest` and `sha-<commit>`
(7 characters, e.g. `sha-1a2b3c4`; builds from before September 2026 use the
full 40-character commit). Update from the folder that holds
`docker-compose.yml`:

```sh
sudo sh update.sh                 # newest build (or whatever VAULT_TAG in .env says)
sudo sh update.sh sha-1a2b3c4     # pin / roll back to one build
sudo sh update.sh latest          # stop pinning, follow main again
sudo sh update.sh pre-update      # undo the last update (previous images are kept locally)
```

`update.sh` (it re-runs itself with `sudo` if needed):

1. notes which Docker volume holds your data and **refuses to continue if this
   folder would use a different one** (renamed folder / different project name
   would otherwise start an empty library);
2. snapshots the database to `backups/vault-pre-update-<date>.db` (keeps 5);
3. keeps the running images as `:pre-update`, pulls, restarts and waits until
   healthy;
4. checks the data volume again (and puts the previous version back if it
   changed), prints the deployed version/commit, removes old unused images.

A tag argument is saved as `VAULT_TAG=...` in `.env`, so a pinned version stays
pinned across restarts and Container Manager rebuilds. Build tags are listed at
<https://github.com/caseyi/The-Vault/pkgs/container/stlvault-backend>.

> Coming from the old script: `./update.sh rollback` is gone (use `pre-update`
> or a `sha-` tag). Old `:rollback` images can be removed with
> `sudo docker rmi ghcr.io/caseyi/stlvault-backend:rollback ghcr.io/caseyi/stlvault-frontend:rollback`.

**Container Manager instead of SSH:** *Project → the-vault → Action → Stop*,
then *Action → Build* re-pulls and restarts; this skips the snapshot and volume
checks, so prefer `update.sh`.

**Optional weekly auto-update (DSM Task Scheduler):** *Control Panel → Task
Scheduler → Create → Scheduled Task → User-defined script*. General: user
**root**. Schedule: weekly, e.g. Sunday 04:00. Task Settings → Run command:

```sh
sh /volume1/docker/the-vault/update.sh >> /volume1/docker/the-vault/backups/update.log 2>&1
```

Tick *Send run details by email → only when the script terminates abnormally*
to hear about failures. Pinned installs (a `sha-` `VAULT_TAG`) stay pinned.

---

## Backups and restore

**What is where**

- Database + extracted images: the Docker volume `<folder>_vault_data`
  (e.g. `the-vault_vault_data`), stored under `/volume1/@docker/volumes/`,
  which File Station doesn't show. Find it with
  `sudo docker volume ls | grep vault_data`.
- Snapshots: `backups/` next to `docker-compose.yml` (visible in File Station).
  The backend writes `vault-YYYYMMDD.db` once a day (the newest `BACKUP_KEEP`,
  default 7, are kept) and `vault-pre-forcescan-<time>.db` before every forced
  rescan; `update.sh` adds `vault-pre-update-<time>.db`.
- **Include `/volume1/docker/the-vault` (with `backups/`) in Hyper Backup.**
  Snapshots hold the database (tags, statuses, collections, notes); extracted
  images are regenerated by a rescan / re-extract.

Never run `docker compose down -v`: `-v` deletes the data volume.

**Restore a snapshot**

```sh
cd /volume1/docker/the-vault
ls backups/                                  # pick one, e.g. vault-20260926.db
sudo docker compose stop frontend backend
sudo docker compose run --rm --no-deps --entrypoint sh backend -c '
  set -e; cd /data
  for f in vault.db vault.db-wal vault.db-shm; do if [ -f "$f" ]; then cp "$f" "$f.before-restore"; fi; done
  rm -f vault.db-wal vault.db-shm
  cp /backups/vault-20260926.db vault.db'
sudo docker compose up -d
```

The current database is kept as `vault.db.before-restore` inside the volume.
(`docker compose run` reuses the backend's volumes, so `/backups` is your
`backups/` folder.)

---

## Which version am I running?

- The sidebar footer shows the version and the commit it was built from.
- `http://YOUR-NAS-IP:8484/api/health` returns `version`, `build`, `gitSha`,
  `buildDate` and whether the library is writable.
- `update.sh` prints the same after each update, and `VAULT_TAG` in `.env`
  shows whether you are pinned.

---

## AI features (Claude API)

The Vault integrates with the Claude API (Anthropic) for smart library
management. These features are entirely optional - the app works without a key.

Enter your API key in the **Scan** modal (it's stored in your browser's
localStorage and never saved on the server), or set `CLAUDE_API_KEY` in `.env`.

**Batch auto-tagging** - Generates up to 5 tags per model (creator, franchise,
category, FDM/resin) by analysing folder names, file types, and slicer presence.
Streams progress in real time. Models with resin slicer files (Chitubox, Lychee)
are tagged "resin"; models with FDM slicer files are tagged "fdm".

**Image finder** - Scores each model's "matchability" based on available metadata
(source URL, creator name, folder naming patterns) and uses Claude with web search
to find missing thumbnails. Trial mode processes the top 10 candidates first so
you can check the hit rate before spending more credits.

**Per-model assistant** - Chat with Claude about any model. Quick actions include
"Find Online" (web search across Printables, MMF, Thingiverse, Cults3D), tag
suggestions, print notes, and organization advice.

---

## Configuration reference

All set in `.env` (host side) - see `.env.example` for the annotated template.

| Variable | Default | Description |
|---|---|---|
| `LIBRARY_HOST_PATH` | `/volume1/STL Archive` | Real path on the host to your primary print folder |
| `LIBRARY_NAME` | `STL Archive` | Label that folder shows under in the app |
| `LIBRARY2_HOST_PATH` / `LIBRARY2_NAME` | - | Optional second local folder (also uncomment its compose line) |
| `SMB_HOST` / `SMB_SHARE` / `SMB_USER` / `SMB_PASS` / `SMB_NAME` | - | Remote NAS over SMB/CIFS (also uncomment the `smb_library` block) |
| `WEB_PORT` | `8484` | Host port for the web UI |
| `VAULT_TAG` | `latest` | Which image build to run (`sha-1a2b3c4` pins; written by `update.sh <tag>`) |
| `TZ` | `America/Los_Angeles` | Time zone for logs and the daily snapshot |
| `BACKUP_KEEP` | `7` | How many daily DB snapshots to keep in `backups/` |
| `CLAUDE_API_KEY` | - | Anthropic API key for AI features (optional) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Override the Claude model used |
| `ORGANIZE_SSH_TARGET` | - | e.g. `casey@dagobah`; shown in generated Organize scripts |
| `ALLOWED_ORIGINS` | Tauri origins | Extra browser origins allowed to call the API (comma list, `*` = any); uncomment in compose |
| `ARCHIVE_MAX_MB` | `500` | Archives larger than this are never opened for render extraction |
| `SCRAPER_ALLOW_PRIVATE` | `0` | `1` lets the web scraper fetch LAN/private addresses |
| `COMPOSE_PROJECT_NAME` | folder name | Only to keep using an existing `<name>_vault_data` volume after moving the folder |

These are set **inside the container** (by the image or compose) and normally
don't need changing:

| Variable | Default | Description |
|---|---|---|
| `LIBRARY_PATH` | `/library` | Where all library folders are mounted in the container |
| `DB_PATH` | `/data/vault.db` | SQLite database location (in the `vault_data` volume) |
| `IMAGES_DIR` | `/data/images` | Where extracted images are stored |
| `BACKUP_DIR` | `/backups` | Snapshot folder (bind-mounted from `./backups`) |
| `HOST` / `PORT` | `0.0.0.0` / `3001` | Backend bind address and port (internal) |
| `GIT_SHA` / `BUILD_DATE` | baked in | Commit and build time of the image |

---

## Troubleshooting

**"Path not found" when scanning / a folder is missing from the Scan dialog.**
The container can't see that folder. Double-check the host path in `.env`, make
sure you ran `docker compose up -d` after editing it, and confirm the path exists
on the host. View what the container sees: `sudo docker compose exec backend ls /library`.

**My library is empty after an update / moving the folder.** Your data is still
in the old volume. Run `sudo docker volume ls | grep vault_data`; if the volume
with your data is e.g. `thevault_vault_data`, add `COMPOSE_PROJECT_NAME=thevault`
to `.env` and run `sudo sh update.sh`. (`update.sh` refuses to switch volumes
for exactly this reason.)

**Permission denied.** Run Docker commands with `sudo` on Synology (`update.sh`
does this itself). `backups/` is created by Docker as root; File Station can
still read and copy the snapshots. Edit `.env` as an administrator.

**Port conflict ("port is already allocated").** DSM itself uses 5000/5001 and
often 80/443. Set another `WEB_PORT` in `.env` and `sudo docker compose up -d`.

**Behind a reverse proxy (DSM Login Portal → Reverse Proxy, Nginx Proxy
Manager, …): scan progress only appears at the end, or long tasks stop.**
Streams send `X-Accel-Buffering: no` and a heartbeat every 15 s, which nginx-based
proxies honour. If yours still buffers, disable response buffering for the site
and raise the proxy read timeout (DSM: *Reverse Proxy → Edit → Advanced
Settings*, e.g. 3600 s). If the proxy rewrites the `Host` header and the app
answers 403, add the public origin to `ALLOWED_ORIGINS`.

**Large libraries.** The first scan reads every folder and can take a while on
tens of thousands of models; it runs in the background (minimize the dialog and
keep browsing). Later scans skip unchanged folders. A *force* rescan re-reads
everything and takes a DB snapshot first.

**Organize says the library is read-only / gives me a script.** In Docker the
library is mounted read-only on purpose, so file moves/renames are generated as
a shell script instead. Review it, then run it on the NAS over SSH (as the user
that owns the files, e.g. `ORGANIZE_SSH_TARGET`), and rescan.

**SMB share won't mount.** Run `sudo docker compose up -d` and check
`sudo docker compose logs backend`. Common fixes: try a different `vers=` (2.1 or 1.0)
in the `smb_library` block, verify the username/password, and make sure the host
can reach the NAS (`ping SMB_HOST`).

**No images appear.** Images come from ZIPs whose names contain render/preview/
photo keywords, or loose image files in the model folder. Use **Generate Tags** /
**Find Images** (needs a Claude key), or set a per-creator "render ZIP hint" via
the ⚙ button next to a creator.

**Port 8484 already in use.** Change `WEB_PORT` in `.env` and restart.

**AI features say the key is invalid.** Use the **Test** button next to the key
field in the Scan modal. Keys start with `sk-ant-`.

---

## Development (local build)

To build images locally instead of pulling from GHCR, edit `docker-compose.yml`:

```yaml
services:
  backend:
    # image: ghcr.io/caseyi/stlvault-backend:${VAULT_TAG:-latest}  ← comment this out
    build: ./backend                                                ← uncomment this
  frontend:
    # image: ghcr.io/caseyi/stlvault-frontend:${VAULT_TAG:-latest} ← comment this out
    build: ./frontend                                               ← uncomment this
```

Then: `docker compose up -d --build`

Run the test suites (Node 22.13+; lockfiles are committed, so use `npm ci`):

```sh
cd backend && npm ci && npm test              # Jest
cd frontend && npm ci && CI=true npm test      # React Testing Library
node .github/scripts/smoke-scan.js             # boots the backend and scans a fixture
```

---

## CI / CD

`.github/workflows/docker-publish.yml` runs on every pull request and every
push to `main` or a `v*` tag:

1. **test** - backend Jest, frontend tests, and a real scan smoke test.
2. **images** - builds both images, starts them together, waits for health,
   scans a fixture library through the API, checks the frontend proxies `/api`
   and doesn't log API keys. Only then, and only for `main`/tags, pushes
   `ghcr.io/caseyi/stlvault-{backend,frontend}` as `latest` + `sha-<7 chars>`
   (and `X.Y.Z` / `X.Y` for `vX.Y.Z` tags). Pull requests never push.

`backend-smoke.yml` repeats the scan smoke test on Linux, macOS and Windows,
`native-build.yml` builds the desktop app on `native-v*` tags, and Dependabot
opens grouped monthly update PRs. The images are public and need no login to
pull.

---

## License

The Vault is open source under the [MIT License](LICENSE) - free to use, modify,
and share. It's offered as-is, with no warranty. If it's useful to you, a
donation is appreciated but never required (see below).

---

## Support the project

The Vault is built and maintained in spare time and given away for free. If it
saved you some headaches organising your print library, you can chip in:

> **If you like The Vault, please feel free to donate with the Sponsors button - and if you have suggestions or hit a bug, [open a GitHub issue](https://github.com/caseyi/The-Vault/issues) on this repo!**

- **GitHub Sponsors** - use the **Sponsor ❤** button at the top of the repo
  (one-time or recurring, no fees).

Either way, ⭐ starring the repo and filing good bug reports helps just as much.
Thank you! 🙏
