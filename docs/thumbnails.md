# Thumbnails: faster scrolling and fewer cards without a picture

Status: spec for `feature/thumbnails` (stacked on `feature/folder-roles`).

Casey (Oct 27 2026): "Can we also cache the thumbnails to make the scroll faster? And figure out an
even better way of adding the thumbnails, most have zip folders with renders or posters or
something, only a few should be missing thumbnails."

Measured on Dagobah (build 0c98942): 1,330 of 4,981 cards have an image (27%). Card images are the
original extracted renders, about 6.5 MB each on average, served with `Cache-Control: public,
max-age=0`, so every scroll re-validates and decodes multi-MB PNGs. A sample of 25 image-less cards:
about half have only STL/Lychee files, the rest have zips whose names carry no render keyword
(`MH-06-SUP-Levels.zip`, `bane 1-6.zip`, Wicked `(Stl Pre Supported)` parts), and one had loose
JPGs that were never used (the image pass only runs for new or changed cards).

## 1. Thumbnail cache (scroll speed)

- `lib/thumbs.js` makes small copies with **sharp** (Docker `node:22-alpine` and the Tauri platforms
  have prebuilt binaries; `require` is lazy and optional: without sharp the original is served).
- Sizes: `w=480` for cards (WebP, quality 72, EXIF-rotated, no upscaling) and `w=1280` for the
  detail viewer. Cached at `IMAGES_DIR/.thumbs/<uuid>/<name>.<w>.webp`.
- `GET /thumbs/<uuid>/<file>?w=480&v=<version>` serves the cached copy, generating it on a miss
  (small concurrency limit, de-duplicated in-flight). On failure it serves the original. Path is
  confined to `IMAGES_DIR` like `/images`.
  Headers: `Cache-Control: public, max-age=31536000, immutable` (the URL carries `v`, derived from the
  source file's mtime and size).
- `/images/*` gets `Cache-Control: public, max-age=604800` plus ETag (names can be reused, so not
  immutable).
- Model list items add `thumb_url` and `thumb_urls` (first 4 images, best first, for hover cycling);
  model detail adds `thumb_urls` aligned with `images` (w=1280) and `thumb_source`.
- Cache is filled in the background: after each scan for cards whose images changed, and once at
  startup for any card image without a cached thumb (rate-limited, one at a time, yields).
  `GET /api/thumbs/status` → `{ sharp: true, cached, missing, generating, bytes }`.
  `POST /api/thumbs/rebuild` clears and refills the cache.
- nginx: `location /thumbs/` proxies to the backend (same as `/images/`), keeps the headers.
- Deleting a card's images or re-extracting removes its `.thumbs/<uuid>` folder.

## 2. Finding a picture for every card

Per card without images, in order, stopping at the first that yields images:

1. **Loose images** among the card's files (exists, but now also retried for unchanged cards).
2. **Render archives** by name (exists). Keywords extended: poster, promo, artwork, gallery,
   showcase, pics, pictures, photos, images, renders, preview, thumb, "(Images)".
3. **Peek inside the card's other archives**: read only the zip central directory (yauzl, no
   decompression; cheap even for multi-GB zips) of up to 16 archives per card (render-named first,
   then smallest first). Image entries of at least 20 KB are ranked with `rankImages` plus a size
   bonus; the best 6 across all archives are extracted. RAR keeps `ARCHIVE_MAX_MB`.
4. **Render the model itself**: a pure-JS STL/OBJ/3MF renderer (`lib/mesh-render.js`, no native
   code, no GPU) draws a 3/4 view preview PNG (640x640, soft studio lighting, neutral background).
   - Input: STL (binary and ASCII), OBJ, and 3MF (zip + XML). Loose files first; else the best entry
     inside the card's zips (streamed, no full-archive read).
   - Which mesh: the files of one folder are rendered together when they look like parts of one
     model (same folder, not support/test files), up to 300 MB and 4M triangles; else the largest
     single mesh that is not a support, base-only or test file.
   - Up axis: Z-up (slicer convention) unless the mesh is much taller in Y.
   - Saved as `stl-preview.png` in the card's image folder; `thumb_source = 'stl'`.
5. Nothing found: the card keeps the placeholder; its attempt is remembered.

`models.thumb_source`: `folder | archive | archive-peek | stl | web | user` (new column).
`models.thumb_attempt`: signature of (card files + pipeline version) of the last failed or
successful attempt, so a rescan never repeats work for an unchanged card; bumping the pipeline
version retries everything once. A user-chosen thumbnail (`user`) is never replaced.

## 3. Running it

- Every scan runs steps 1-3 for new or changed cards (as today) and queues step 4.
- `GET /api/thumbs/fill?scope=missing|all&steps=peek,render` (SSE, one job at a time, stops on
  disconnect) works through cards without images: progress `{done, total, found:{folder, archive,
  peek, stl}, failed}`. It runs in a worker thread (rendering is CPU-bound).
- `POST /api/models/:id/thumbnail/render {file?}` renders one card now (optionally a chosen file).

## 4. UI

- Gallery cards use `thumb_url` / `thumb_urls`, keep a fixed aspect ratio (no layout shift), and the
  card grid uses `content-visibility: auto` with an intrinsic size.
- A small "3D" badge marks previews rendered from the mesh.
- Scan window → "Thumbnails": counts (with picture / rendered / missing, cache size), "Find missing
  pictures" (runs the fill job with the task log), "Rebuild cache".
- Card detail: filmstrip uses thumbs; "Render preview from model" with a file picker when the card
  has no picture or the user wants a different one.
