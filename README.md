# The Vault 🗃️

Self-hosted 3D print library manager for your NAS. Indexes STL/ZIP/slicer files,
extracts render images, tracks print status, and lets you ask Claude AI to help
organise your collection.

- 🖼️ Auto-extracts preview images from render ZIPs
- 🗂️ Browse by folder tree, creator, franchise, tags, or collections
- 🖨️ Track print status (unprinted → sliced → printing → printed → painted) and a print queue
- 🤖 Optional Claude AI: auto-tagging, online image finder, per-model chat
- 📦 Runs entirely on your own hardware — your files never leave your network

<!-- Badges: update the links below to match your repo / donation pages. -->
[![License: MIT](https://img.shields.io/badge/License-MIT-c17f3a.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/caseyi)

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start-first-time)
- [Setting your library folders](#setting-your-library-folders)
  - [A folder on this machine](#a-folder-on-this-machine)
  - [A second local folder](#a-second-local-folder)
  - [A folder on another NAS over SMB / CIFS](#a-folder-on-another-nas-over-smb--cifs)
- [Folder structure expected](#folder-structure-expected)
- [Updating](#updating)
- [AI features (Claude API)](#ai-features-claude-api)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development (local build)](#development-local-build)
- [CI / CD](#cicd)
- [License](#license)
- [Support the project](#support-the-project)

---

## Requirements

- A machine that runs **Docker** and **Docker Compose v2** (a Synology/QNAP NAS,
  a Linux box, a Mac, or a Raspberry Pi all work). On Synology, install
  "Container Manager" from the Package Center.
- Your 3D print files in a folder that machine can read.
- *(Optional)* an Anthropic **Claude API key** if you want the AI features.

No build tools, Node, or Python needed on the host — the app ships as pre-built
Docker images.

---

## Quick start (first time)

```sh
# 1. Clone the repo
git clone https://github.com/caseyi/stlvault.git
cd stlvault

# 2. Create your config file from the template
cp .env.example .env

# 3. Edit .env and point LIBRARY_HOST_PATH at your 3D print folder
nano .env            # (or open it in any text editor)

# 4. Start
docker-compose up -d

# 5. Open in a browser
#    http://YOUR-NAS-IP:8484
```

Then click **⟳ SCAN LIBRARY** in the sidebar to index your files.

Docker images are pulled automatically from GitHub Container Registry — no local
build needed.

---

## Setting your library folders

All paths live in the **`.env`** file (copied from `.env.example`). You never
have to edit `docker-compose.yml` by hand. After changing `.env`, apply it with:

```sh
docker-compose up -d
```

> **How paths work:** The container can only see folders you explicitly give it.
> Each library folder is mounted **read-only** under `/library/<name>` inside the
> container, and the app scans everything under `/library`. The Scan dialog shows
> the folders it can currently see, so you can confirm a mount worked.

### A folder on this machine

This is the common case — your prints are on the same NAS/host that runs Docker.
Set these two values in `.env`:

```ini
LIBRARY_HOST_PATH=/volume1/STL Archive   # the real path on your NAS
LIBRARY_NAME=STL Archive                 # the label shown in the app
```

Spaces are fine — do **not** wrap the value in quotes.

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

Run `docker-compose up -d` again.

### A folder on another NAS over SMB / CIFS

If your prints live on a **different** NAS reached over the network, mount its
SMB/CIFS share straight into the container. Fill in the `SMB_*` values in `.env`:

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

Apply with `docker-compose up -d`. The share mounts at `/library/<SMB_NAME>` and
gets scanned like any local folder.

> **Notes on SMB:** The default options request SMB protocol `vers=3.0`. Older
> NAS devices may need `vers=2.1` or `vers=1.0` — change it in the `o:` line of
> the `smb_library` block. `uid=1000,gid=1000` make the files readable inside the
> container. Because `.env` holds the share password in plain text, keep that file
> private (it is already gitignored).

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

## Updating

Whenever a new version is released, just run:

```sh
cd /path/to/stlvault
./update.sh
```

`update.sh` pulls the latest pre-built images, restarts the containers, and
prints the URL when it's done. Your database and extracted images live in a named
Docker volume (`vault_data`) and are **never** wiped by an update.

---

## AI features (Claude API)

The Vault integrates with the Claude API (Anthropic) for smart library
management. These features are entirely optional — the app works without a key.

Enter your API key in the **Scan** modal (it's stored in your browser's
localStorage and never saved on the server), or set `CLAUDE_API_KEY` in `.env`.

**Batch auto-tagging** — Generates up to 5 tags per model (creator, franchise,
category, FDM/resin) by analysing folder names, file types, and slicer presence.
Streams progress in real time. Models with resin slicer files (Chitubox, Lychee)
are tagged "resin"; models with FDM slicer files are tagged "fdm".

**Image finder** — Scores each model's "matchability" based on available metadata
(source URL, creator name, folder naming patterns) and uses Claude with web search
to find missing thumbnails. Trial mode processes the top 10 candidates first so
you can check the hit rate before spending more credits.

**Per-model assistant** — Chat with Claude about any model. Quick actions include
"Find Online" (web search across Printables, MMF, Thingiverse, Cults3D), tag
suggestions, print notes, and organization advice.

---

## Configuration reference

All set in `.env` (host side) — see `.env.example` for the annotated template.

| Variable | Default | Description |
|---|---|---|
| `LIBRARY_HOST_PATH` | `/volume1/STL Archive` | Real path on the host to your primary print folder |
| `LIBRARY_NAME` | `STL Archive` | Label that folder shows under in the app |
| `LIBRARY2_HOST_PATH` / `LIBRARY2_NAME` | — | Optional second local folder (also uncomment its compose line) |
| `SMB_HOST` / `SMB_SHARE` / `SMB_USER` / `SMB_PASS` / `SMB_NAME` | — | Remote NAS over SMB/CIFS (also uncomment the `smb_library` block) |
| `WEB_PORT` | `8484` | Host port for the web UI |
| `CLAUDE_API_KEY` | — | Anthropic API key for AI features (optional) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Override the Claude model used |

These are set **inside the container** and normally don't need changing:

| Variable | Default | Description |
|---|---|---|
| `LIBRARY_PATH` | `/library` | Where all library folders are mounted in the container |
| `DB_PATH` | `/data/vault.db` | SQLite database location (in the `vault_data` volume) |
| `IMAGES_DIR` | `/data/images` | Where extracted images are stored |
| `PORT` | `3001` | Backend port (internal) |

---

## Troubleshooting

**"Path not found" when scanning / a folder is missing from the Scan dialog.**
The container can't see that folder. Double-check the host path in `.env`, make
sure you ran `docker-compose up -d` after editing it, and confirm the path exists
on the host. View what the container sees: `docker exec stlvault-backend-1 ls /library`.

**SMB share won't mount.** Run `docker-compose up -d` and check
`docker-compose logs backend`. Common fixes: try a different `vers=` (2.1 or 1.0)
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
    # image: ghcr.io/caseyi/stlvault-backend:latest  ← comment this out
    build: ./backend                                   ← uncomment this
  frontend:
    # image: ghcr.io/caseyi/stlvault-frontend:latest ← comment this out
    build: ./frontend                                  ← uncomment this
```

Then: `docker-compose up -d --build`

Run the test suites:

```sh
# Backend (Jest)
cd backend && npm install && npm test

# Frontend (React Testing Library)
cd frontend && npm install && CI=true npm test
```

---

## CI / CD

Pushing to `main` (or pushing a `v*` tag) triggers the GitHub Actions workflow
at `.github/workflows/docker-publish.yml`, which:

1. Builds `stlvault-backend` and `stlvault-frontend` Docker images
2. Pushes them to `ghcr.io/caseyi/stlvault-{backend,frontend}:latest`
3. Also tags each image with `sha-<commit>` for rollback

The images are public and require no authentication to pull.

---

## License

The Vault is open source under the [MIT License](LICENSE) — free to use, modify,
and share. It's offered as-is, with no warranty. If it's useful to you, a
donation is appreciated but never required (see below).

---

## Support the project

The Vault is built and maintained in spare time and given away for free. If it
saved you some headaches organising your print library, you can chip in:

> **If you like The Vault, please feel free to donate with the Sponsors button — and if you have suggestions or hit a bug, [open a GitHub issue](https://github.com/caseyi/stlvault/issues) on this repo!**

- **GitHub Sponsors** — use the **Sponsor ❤** button at the top of the repo
  (one-time or recurring, no fees).
- **Ko-fi / Buy Me a Coffee** — quick one-off tip *(add your link in
  `.github/FUNDING.yml` to make these appear).*

Either way, ⭐ starring the repo and filing good bug reports helps just as much.
Thank you! 🙏
