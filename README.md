# The Vault 🗃️

Self-hosted 3D print library manager for your NAS. Indexes STL/ZIP/slicer files,
extracts render images, tracks print status, and lets you ask Claude AI to help
organise your collection.

---

## Quick start (first time)

```sh
# 1. Clone the repo
git clone https://github.com/caseyi/stlvault.git
cd stlvault

# 2. Edit docker-compose.yml — change the library path to your 3D print folder
#    Find the line:  - /volume1/3dprints:/library:ro
#    Replace /volume1/3dprints with your actual path

# 3. Start
docker-compose up -d

# 4. Open in browser
http://YOUR-NAS-IP:8484
```

Images are pulled automatically from GitHub Container Registry — no local build needed.

---

## Updating

Whenever a new version is released, just run:

```sh
cd /path/to/stlvault
./update.sh
```

That's it. `update.sh` pulls the latest pre-built images, restarts the containers,
and prints the URL when it's done.

---

## Folder structure expected

```
/volume1/3dprints/           ← your library root (mapped to /library in Docker)
  CreatorName/               ← one folder per creator
    ReleaseName/             ← release = subfolder name  (e.g. "FDM", "Resin v2")
      model.stl
      renders.zip
    AnotherRelease.zip       ← or a ZIP at creator level
```

Files inside each release folder are grouped by release name in the UI.
ZIPs named with "render/preview/photo" keywords are auto-extracted for images.

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

---

## CI / CD

Pushing to `main` (or pushing a `v*` tag) triggers the GitHub Actions workflow
at `.github/workflows/docker-publish.yml`, which:

1. Builds `stlvault-backend` and `stlvault-frontend` Docker images
2. Pushes them to `ghcr.io/caseyi/stlvault-{backend,frontend}:latest`
3. Also tags each image with `sha-<commit>` for rollback

The images are public and require no authentication to pull.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LIBRARY_PATH` | `/library` | Path to your 3D print folder inside the container |
| `DB_PATH` | `/data/vault.db` | SQLite database location |
| `IMAGES_DIR` | `/data/images` | Where extracted images are stored |
| `PORT` | `3001` | Backend port (internal) |

