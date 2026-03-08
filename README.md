# 🗄️ The Vault — 3D Print Library Manager

A self-hosted web app for indexing and browsing your 3D print collection on a Synology NAS (or any Docker host).

---

## ✨ Features

- **Gallery view** — browse all your models with thumbnails
- **Auto image extraction** — pulls preview images from render ZIPs automatically
- **Creator organization** — mirrors your `Creator Name / Model Name` folder structure
- **Print status tracking** — mark models as Unprinted → Sliced → Printed → Painted
- **Search & filter** — search by name, creator, tags; filter by print status
- **Tagging & notes** — add custom tags and print notes to any model
- **File type detection** — identifies STL, Chitubox, Lychee, GCode files

---

## 🚀 Setup (Synology NAS)

### Step 1 — Install Docker
1. Open **Package Center** on your Synology
2. Search for **Container Manager** and install it

### Step 2 — Copy files to your NAS
Copy the entire `the-vault` folder to your NAS (e.g., `/volume1/docker/the-vault`)

### Step 3 — Edit docker-compose.yml
Open `docker-compose.yml` in a text editor and change this line:
```
- /volume1/3dprints:/library:ro
```
Replace `/volume1/3dprints` with the actual path to your 3D print folder on your NAS.

**To find your path:**
- Open File Station on your Synology
- Navigate to your 3D prints folder
- Right-click → Properties — the path is shown there

### Step 4 — Start the app
Open a terminal/SSH on your NAS and run:
```bash
cd /volume1/docker/the-vault
docker compose up -d --build
```

The first build takes 3–5 minutes. After that, open your browser:
```
http://YOUR-NAS-IP:8484
```

### Step 5 — Scan your library
1. Click **"⟳ SCAN LIBRARY"** in the sidebar
2. The path `/library` is pre-filled — this maps to your NAS folder
3. Click **Start Scan** and wait for it to finish
4. Your models will appear in the gallery!

---

## 📁 Expected Folder Structure

The app works best with this structure:
```
/volume1/3dprints/
├── CreatorName1/
│   ├── Cool Dragon/
│   │   ├── renders.zip          ← images extracted from here
│   │   ├── dragon_body.stl
│   │   └── dragon_wings.stl
│   └── Space Marine/
│       ├── previews/
│       │   ├── front.jpg
│       │   └── back.jpg
│       └── marine.stl
├── AnotherCreator/
│   └── ...
```

- **Top-level folders** = creators
- **Subfolders** = individual models
- **ZIPs with "render", "preview", "photo" in the name** = images extracted automatically
- **Loose JPG/PNG files** in the model folder are also picked up

---

## 🔄 Re-scanning

Run a scan any time you add new files. The scanner will:
- Add new models it hasn't seen before
- Update existing models if new files were added
- Never delete anything from your actual files (the library is mounted read-only)

---

## 🛠️ Troubleshooting

**App won't start:**
- Make sure Docker/Container Manager is installed
- Check the path in `docker-compose.yml` exists on your NAS

**No images showing:**
- Your ZIPs need to contain image files (JPG/PNG)
- The ZIP filename should include words like "render", "preview", or "photo"
- Loose JPG/PNG files directly in the model folder also work

**Scan is slow:**
- Normal — it's opening every ZIP to extract images
- A large library (1000+ models) may take 10–20 minutes on first scan
- Subsequent scans are much faster (skips already-indexed models)

---

## 🔧 Updating

```bash
cd /volume1/docker/the-vault
docker compose down
docker compose up -d --build
```

Your database and extracted images are stored in a Docker volume and are preserved across updates.
