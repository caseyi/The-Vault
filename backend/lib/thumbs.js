'use strict';
/**
 * lib/thumbs.js: small cached copies of card images (docs/thumbnails.md §1).
 *
 * GET /thumbs/<uuid>/<file>?w=480|1280&v=<version> serves IMAGES_DIR/.thumbs/<uuid>/<file>.<w>.webp,
 * made with sharp on a miss (2 at a time, de-duplicated in flight). Without sharp, or when an image
 * cannot be converted, the original is served. The URL carries `v` (source mtime + size, and whether
 * sharp is available), so responses are cached for a year as immutable.
 *
 * sharp is optional and loaded lazily; THUMBS_NO_SHARP=1 pretends it is missing (tests, debugging).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { imageUrlToFile, isSafeImageUrl } = require('./paths');

const WIDTHS = [480, 1280];
const QUALITY = 72;
const CONCURRENCY = 2;
const IMMUTABLE = 'public, max-age=31536000, immutable';

const imagesDir = () => process.env.IMAGES_DIR || '/data/images';
const thumbsDir = () => path.join(imagesDir(), '.thumbs');

let sharpMod; // undefined = not tried, null = unavailable
function probeSharp() {
  if (process.env.THUMBS_SHARP_PROBE === '0') return true;
  try {
    const r = require('child_process').spawnSync(process.execPath, ['-e', "require('sharp')().metadata().catch(()=>{});"], { cwd: __dirname, timeout: 15000, stdio: 'ignore', env: process.env });
    if (r.status !== 0) console.warn(`sharp unavailable (probe exit ${r.status ?? r.signal}); serving original images`);
    return r.status === 0;
  } catch { return false; }
}
function getSharp() {
  if (process.env.THUMBS_NO_SHARP === '1') return null;
  if (sharpMod === undefined) {
    try {
      // Probe in a child first: on a CPU without SSE4.2 (very old NAS) loading the prebuilt
      // libvips dies with an illegal instruction, which no try/catch can stop.
      if (!probeSharp()) { sharpMod = null; return null; }
      sharpMod = require('sharp');
      try { sharpMod.cache(false); sharpMod.concurrency(1); } catch {}
    } catch { sharpMod = null; }
  }
  return sharpMod;
}
const hasSharp = () => !!getSharp();

const snapWidth = (w) => {
  const n = parseInt(w, 10);
  return Number.isFinite(n) && n > 480 ? 1280 : 480;
};

/** Image URL (/images/<rel>) → its rel part, or null. Never a path inside .thumbs. */
function relOf(imageUrl) {
  if (!isSafeImageUrl(imageUrl)) return null;
  const rel = imageUrl.slice('/images/'.length);
  if (!rel || rel.split('/').some(s => !s || s.startsWith('.'))) return null;
  return rel;
}

/** Version token of a source image: mtime + size (+ 'n' when sharp is missing: originals are served). */
function versionOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return '0'; }
  const v = crypto.createHash('sha1').update(`${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 10);
  return hasSharp() ? v : `${v}n`;
}

/** /images/<uuid>/<file> → /thumbs/<uuid>/<file>?w=..&v=.. (null for anything that is not a local image). */
function thumbUrl(imageUrl, w = 480) {
  const rel = relOf(imageUrl);
  if (!rel) return null;
  const file = path.join(imagesDir(), rel);
  return `/thumbs/${rel.split('/').map(encodeURIComponent).join('/')}?w=${snapWidth(w)}&v=${versionOf(file)}`;
}

const cachePath = (rel, w) => path.join(thumbsDir(), `${rel}.${w}.webp`);

function isFresh(dest, src) {
  try { return fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs; } catch { return false; }
}

// ── generation (bounded concurrency, de-duplicated) ─────────────────────────
const inflight = new Map(); // dest → Promise
const waiting = [];
let active = 0;
const stats = { generated: 0, failed: 0 };
function runLimited(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (active < CONCURRENCY) go(); else waiting.push(go);
  });
}

/**
 * Make sure the cached thumb for rel at width w exists. Resolves to its path, or null when it
 * cannot be made (no sharp, unreadable image).
 */
function ensureThumb(rel, w) {
  w = snapWidth(w);
  const src = path.join(imagesDir(), rel);
  const dest = cachePath(rel, w);
  if (isFresh(dest, src)) return Promise.resolve(dest);
  const sharp = getSharp();
  if (!sharp || !fs.existsSync(src)) return Promise.resolve(null);
  if (inflight.has(dest)) return inflight.get(dest);
  const p = runLimited(async () => {
    if (isFresh(dest, src)) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await sharp(src, { failOn: 'none', limitInputPixels: 268402689 })
        .rotate()
        .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toFile(tmp);
      fs.renameSync(tmp, dest);
      stats.generated++;
      return dest;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      stats.failed++;
      return null;
    }
  }).finally(() => inflight.delete(dest));
  inflight.set(dest, p);
  return p;
}

/** Express handler for GET /thumbs/* */
async function serveThumb(req, res) {
  const raw = req.params[0] || '';
  let rel;
  try { rel = raw.split('/').map(decodeURIComponent).join('/'); } catch { return res.status(400).json({ error: 'Bad path' }); }
  rel = relOf(`/images/${rel}`);
  const src = rel && imageUrlToFile(`/images/${rel}`);
  if (!src) return res.status(403).json({ error: 'Path is outside the images folder' });
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return res.status(404).json({ error: 'Not found' });
  const w = snapWidth(req.query.w);
  const out = await ensureThumb(rel, w);
  res.setHeader('Cache-Control', IMMUTABLE);
  if (out) {
    res.type('image/webp');
    return res.sendFile(out, { cacheControl: false, lastModified: true, dotfiles: 'allow' });
  }
  res.setHeader('X-Thumb-Fallback', '1');
  return res.sendFile(src, { cacheControl: false, lastModified: true });
}

/** Remove the cached thumbs of one card (re-extract, image deletion). */
function removeThumbs(uuid) {
  if (!uuid || /[\\/]|^\.|\.\./.test(uuid)) return;
  try { fs.rmSync(path.join(thumbsDir(), uuid), { recursive: true, force: true }); } catch {}
}
/** Remove the cached thumbs of one image (its file was rewritten). */
function removeImageThumbs(imageUrl) {
  const rel = relOf(imageUrl);
  if (!rel) return;
  for (const w of WIDTHS) { try { fs.unlinkSync(cachePath(rel, w)); } catch {} }
}

// ── which images want a card-size thumb ────────────────────────────────────
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

/** The first 4 images of a card, thumbnail first (what list items show and hover-cycle). */
function cardImages(images, thumbnail) {
  const list = Array.isArray(images) ? images : parseJSON(images, []);
  const out = [];
  if (thumbnail && list.includes(thumbnail)) out.push(thumbnail);
  else if (thumbnail && isSafeImageUrl(thumbnail)) out.push(thumbnail);
  for (const im of list) { if (out.length >= 4) break; if (!out.includes(im)) out.push(im); }
  return out.slice(0, 4);
}

function wantedRels(db) {
  const rows = db.prepare(`SELECT images, thumbnail_path FROM models WHERE folded_into IS NULL AND images IS NOT NULL AND images NOT IN ('', '[]')`).all();
  const rels = [];
  for (const r of rows) for (const im of cardImages(r.images, r.thumbnail_path)) { const rel = relOf(im); if (rel) rels.push(rel); }
  return rels;
}

function dirBytes(dir) {
  let n = 0;
  const walk = (d) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { n += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return n;
}

// ── background filler (one at a time, yields between images) ──────────────
const filler = { queue: [], running: false, stopped: false };
function queueRels(rels) {
  const seen = new Set(filler.queue);
  for (const r of rels) if (!seen.has(r)) { filler.queue.push(r); seen.add(r); }
  if (!filler.running) runFiller();
  return rels.length;
}
async function runFiller() {
  if (!getSharp()) { filler.queue.length = 0; return; }
  filler.running = true;
  filler.stopped = false;
  try {
    while (filler.queue.length && !filler.stopped) {
      const rel = filler.queue.shift();
      const src = path.join(imagesDir(), rel);
      if (!isFresh(cachePath(rel, 480), src)) await ensureThumb(rel, 480);
      await new Promise(r => { const t = setTimeout(r, 15); if (t.unref) t.unref(); });
    }
  } finally { filler.running = false; }
}
/** Queue every card image without a fresh card-size thumb. Returns how many were queued. */
function fillMissing(db) {
  if (!getSharp()) return 0;
  const missing = wantedRels(db).filter(rel => !isFresh(cachePath(rel, 480), path.join(imagesDir(), rel)));
  return queueRels(missing);
}
/** Clear the cache and refill it. */
function rebuild(db) {
  filler.stopped = true;
  filler.queue.length = 0;
  try { fs.rmSync(thumbsDir(), { recursive: true, force: true }); } catch {}
  if (!getSharp()) return 0;
  return queueRels(wantedRels(db));
}
function stopFiller() { filler.stopped = true; filler.queue.length = 0; }

/** GET /api/thumbs/status */
function status(db) {
  const rels = wantedRels(db);
  let cached = 0;
  for (const rel of rels) if (isFresh(cachePath(rel, 480), path.join(imagesDir(), rel))) cached++;
  const card = (sql) => { try { return db.prepare(sql).get().n || 0; } catch { return 0; } };
  const live = `folded_into IS NULL AND (hidden IS NULL OR hidden = 0)`;
  return {
    sharp: hasSharp(),
    cached,
    missing: rels.length - cached,
    generating: inflight.size + filler.queue.length,
    bytes: dirBytes(thumbsDir()),
    cards: {
      withPicture: card(`SELECT COUNT(*) n FROM models WHERE ${live} AND images IS NOT NULL AND images NOT IN ('', '[]')`),
      rendered: card(`SELECT COUNT(*) n FROM models WHERE ${live} AND thumb_source = 'stl' AND images IS NOT NULL AND images NOT IN ('', '[]')`),
      missing: card(`SELECT COUNT(*) n FROM models WHERE ${live} AND (images IS NULL OR images IN ('', '[]'))`),
    },
  };
}

module.exports = {
  thumbUrl, ensureThumb, serveThumb, removeThumbs, removeImageThumbs, cardImages, fillMissing, rebuild, stopFiller,
  status, hasSharp, snapWidth, cachePath, versionOf, relOf, IMMUTABLE, WIDTHS, _stats: stats,
};
