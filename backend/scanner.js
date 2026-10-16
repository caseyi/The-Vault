const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExtractorFromData } = require('node-unrar-js');
const db = require('./db');
const {
  discoverModelFolders, VARIANT_DIR, MEDIA_DIR, IGNORED_FOLDERS, isJunkFile,
} = require('./lib/discovery');
const zipLib = require('./lib/zip');
const uuidv4 = () => crypto.randomUUID();

const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const IMAGE_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const STL_EXTS    = new Set(['.stl', '.obj', '.3mf']);
const SLICE_EXTS  = new Set(['.chitubox', '.ctb', '.photon', '.lys', '.lychee']);
const PLATE_EXTS  = new Set(['.gcode', '.gco', '.nc']);
const RENDER_KW   = ['render', 'preview', 'thumb', 'photo', 'pic', 'image', 'renders', 'previews', 'photos', 'presentation'];
const ARCHIVE_EXTS = new Set(['.zip', '.rar']);

// Archives bigger than this are not opened for render extraction (they are read
// fully into memory). Override with ARCHIVE_MAX_MB.
function archiveMaxBytes() {
  const mb = parseFloat(process.env.ARCHIVE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 500) * 1024 * 1024;
}
const MAX_IMAGE_ENTRY_BYTES = 50 * 1024 * 1024; // skip absurd "images" inside archives (zip bombs)

function archiveTooBig(p) {
  try {
    const size = fs.statSync(p).size;
    if (size > archiveMaxBytes()) {
      console.warn(`Skipping ${p}: ${Math.round(size / 1048576)} MB exceeds ARCHIVE_MAX_MB`);
      return true;
    }
  } catch { return true; }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRenderArchive(filename) {
  const lower = filename.toLowerCase();
  return RENDER_KW.some(k => lower.includes(k));
}

/**
 * Check if a filename matches a hint string.
 * Hint can be an exact filename ("renders.zip"), a glob-style wildcard ("*render*"),
 * or a comma-separated list of either ("renders.zip, *preview*").
 */
function matchesHint(filename, hint) {
  if (!hint) return false;
  const lower = filename.toLowerCase();
  return hint.split(',').map(s => s.trim().toLowerCase()).some(pattern => {
    if (pattern.includes('*')) {
      // Simple glob: convert * to regex .*
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return re.test(lower);
    }
    return lower === pattern;
  });
}

function pickRenderArchives(analysis, hint) {
  if (hint) {
    // Use only the explicitly hinted archive(s); fall back to auto-detect if none match
    const hinted = analysis.files.filter(f => ARCHIVE_EXTS.has(f.ext) && matchesHint(f.filename, hint)).map(f => f.filepath);
    if (hinted.length > 0) return hinted;
  }
  return analysis.renderArchives; // auto-detected by keyword
}

// Deterministic thumbnail ranking — score image paths by filename so the best
// render becomes the thumbnail (and the viewer shows images best-first), no AI.
const THUMB_POSITIVE = [
  [/\b(hero|main|cover|render|thumb(nail)?|beauty|promo|presentation)\b/, 6],
  [/\b(front|preview|display|key ?art)\b/, 4],
  [/\b0*1\b/, 2], // "01", "1" — often the primary shot
];
const THUMB_NEGATIVE = [
  [/\b(back|rear|bottom|underside)\b/, 3],
  [/\b(wip|sprue|raft|support(s|ed)?|presupport(ed)?|unsupported|cut|hollow)\b/, 4],
  [/\b(scale|size|dimension|measure|ruler|comparison)\b/, 3],
  [/\b(logo|watermark|banner|nsfw|sticker)\b/, 2],
];
function imageScore(p) {
  // Normalize separators (_ - . etc.) to spaces so \b matches around them
  // (underscores are "word" chars, so "render_main" wouldn't match \brender\b).
  const name = String(p).toLowerCase().split('/').pop().replace(/[^a-z0-9]+/g, ' ');
  let score = 0;
  for (const [re, w] of THUMB_POSITIVE) if (re.test(name)) score += w;
  for (const [re, w] of THUMB_NEGATIVE) if (re.test(name)) score -= w;
  return score;
}
// Returns images sorted best-thumbnail-first (stable for equal scores).
function rankImages(images) {
  return images
    .map((p, i) => ({ p, i, s: imageScore(p) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.p);
}

function isRenderImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

function detectSourceSite(s) {
  const l = s.toLowerCase();
  if (l.includes('printables'))                 return 'printables';
  if (l.includes('thingiverse'))                return 'thingiverse';
  if (l.includes('myminifactory') || l.includes('mmf')) return 'myminifactory';
  if (l.includes('patreon'))                    return 'patreon';
  if (l.includes('cults'))                      return 'cults3d';
  if (l.includes('gumroad'))                    return 'gumroad';
  return null;
}

/**
 * Cheap content hash: folder mtime + sorted list of "filename:size" entries.
 * Much faster than hashing file bytes; catches additions, deletions, renames.
 */
function folderHash(folderPath) {
  const entries = [];
  function walk(dir) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (isJunkFile(e.name) || IGNORED_FOLDERS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        try {
          const stat = fs.statSync(full);
          entries.push(`${e.name}:${stat.size}:${stat.mtimeMs}`);
        } catch {}
      }
    }
  }
  walk(folderPath);
  entries.sort();
  return crypto.createHash('sha1').update(entries.join('|')).digest('hex').slice(0, 16);
}

function fileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (STL_EXTS.has(ext))   return 'stl';
  if (ext === '.zip')       return 'zip';
  if (SLICE_EXTS.has(ext)) return 'slicer';
  if (PLATE_EXTS.has(ext)) return 'plate';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'other';
}

function inferModelName(folderPath) {
  return path.basename(folderPath).replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Image extraction ──────────────────────────────────────────────────────────

// Streams the central directory with yauzl (lib/zip.js) instead of loading the
// archive, so multi-GB zips get thumbnails. ZIP_MAX_MB / an explicit ARCHIVE_MAX_MB cap it.
async function extractImagesFromZip(zipPath, modelUuid, opts = {}) {
  if (zipLib.zipTooBig(zipPath)) {
    console.warn(`Skipping ${zipPath}: larger than ZIP_MAX_MB/ARCHIVE_MAX_MB`);
    return [];
  }
  try {
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    const names = await zipLib.extractZipImages(zipPath, modelImgDir, { limit: opts.limit || 0, rank: rankImages });
    return [...new Set(names)].map(n => `/images/${modelUuid}/${n}`);
  } catch (e) {
    console.warn(`Could not extract zip ${zipPath}: ${e.message}`);
    return [];
  }
}

// node-unrar-js v2's createExtractorFromData is async (it loads a WASM module);
// calling it synchronously (as this used to) silently extracted nothing.
async function extractImagesFromRar(rarPath, modelUuid) {
  const extracted = [];
  if (archiveTooBig(rarPath)) return extracted;
  try {
    const data = fs.readFileSync(rarPath);
    // Hand node-unrar-js the Buffer's own ArrayBuffer when it isn't a pooled
    // slice (large reads never are) — avoids copying the whole archive again.
    const ab = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      ? data.buffer
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const extractor = await createExtractorFromData({ data: ab });
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
    // Only decompress image entries (the STLs in the same archive are skipped).
    const list = extractor.extract({
      files: (h) => !h.flags.directory && isRenderImage(h.name) && !(h.unpSize > MAX_IMAGE_ENTRY_BYTES),
    });
    for (const file of list.files) {
      const safeName = path.basename(String(file.fileHeader.name).replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_');
      const outPath = path.join(modelImgDir, safeName);
      if (!fs.existsSync(outPath) && file.extraction) {
        fs.writeFileSync(outPath, file.extraction);
      }
      extracted.push(`/images/${modelUuid}/${safeName}`);
    }
  } catch (e) {
    console.warn(`Could not extract rar ${rarPath}: ${e.message}`);
  }
  return extracted;
}

/** Extract render images from a .zip/.rar into IMAGES_DIR/<uuid>/. Always returns a Promise. */
async function extractImagesFromArchive(archivePath, modelUuid, opts) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.rar') return extractImagesFromRar(archivePath, modelUuid);
  return extractImagesFromZip(archivePath, modelUuid, opts);
}

function extractImagesFromFolder(folderPath, modelUuid) {
  const extracted = [];
  try {
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    for (const file of fs.readdirSync(folderPath)) {
      if (isJunkFile(file)) continue;
      if (isRenderImage(file)) {
        const src = path.join(folderPath, file);
        try { if (fs.statSync(src).size > imageMaxBytes()) continue; } catch { continue; } // IMAGE_MAX_MB (default 50)
        if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
        const safeName = file.replace(/[^a-zA-Z0-9._-]/g, '_');
        const dest = path.join(modelImgDir, safeName);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        extracted.push(`/images/${modelUuid}/${safeName}`);
      }
    }
  } catch (e) {
    console.warn(`Could not scan folder images ${folderPath}: ${e.message}`);
  }
  return extracted;
}

// ── analyzeFolder ─────────────────────────────────────────────────────────────

/**
 * Derive a clean release name from a ZIP stem or subfolder name.
 * e.g.  "CreatorName_CoolPack_v1.2_STLs" → "CoolPack v1.2 STLs"
 *        "FDM"                             → "FDM"
 *        "[GroupTag] Some Release (Renders)" → "Some Release (Renders)"
 */
function inferReleaseName(raw, creatorName) {
  let name = path.basename(raw, path.extname(raw)); // strip .zip if present
  name = name.replace(/^\[.*?\]\s*/g, '');           // strip [bracket tags]
  if (creatorName) {
    const esc = creatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    name = name.replace(new RegExp(`^${esc}[\\s_\\-]+`, 'i'), '');
  }
  name = name.replace(/[_]+/g, ' ').trim();
  return name || path.basename(raw, path.extname(raw));
}

/**
 * Walk a model folder, tagging every file with the release it belongs to.
 *
 *   subfolder/  → all files inside get release_name = cleaned subfolder name
 *   file.zip    → release_name = cleaned zip stem
 *   loose file  → release_name = null  (ungrouped)
 */
function analyzeFolder(folderPath, creatorName) {
  const result = {
    files: [], hasStl: false, hasChitubox: false, hasLychee: false, hasPlate: false,
    images: [], renderArchives: [], releases: new Set(),
  };

  let topEntries;
  try { topEntries = fs.readdirSync(folderPath, { withFileTypes: true }); }
  catch { return result; }

  for (const entry of topEntries) {
    if (IGNORED_FOLDERS.has(entry.name) || isJunkFile(entry.name)) continue;
    const full = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      const releaseName = inferReleaseName(entry.name, creatorName);
      result.releases.add(releaseName);

      function walkSub(dir) {
        let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
          if (IGNORED_FOLDERS.has(e.name) || isJunkFile(e.name)) continue;
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { walkSub(fp); continue; }
          const ext = path.extname(e.name).toLowerCase();
          let size = 0; try { size = fs.statSync(fp).size; } catch {}
          result.files.push({ filename: e.name, filepath: fp, ext, size, release_name: releaseName });
          if (STL_EXTS.has(ext))                                       result.hasStl = true;
          if (ext==='.chitubox'||ext==='.ctb'||ext==='.photon')        result.hasChitubox = true;
          if (ext==='.lys'||ext==='.lychee')                           result.hasLychee = true;
          if (PLATE_EXTS.has(ext))                                     result.hasPlate = true;
          if (IMAGE_EXTS.has(ext))                                     result.images.push(fp);
          if (ARCHIVE_EXTS.has(ext) && isRenderArchive(e.name))             result.renderArchives.push(fp);
        }
      }
      walkSub(full);

    } else {
      const ext = path.extname(entry.name).toLowerCase();
      let size = 0; try { size = fs.statSync(full).size; } catch {}
      const releaseName = ARCHIVE_EXTS.has(ext) ? inferReleaseName(entry.name, creatorName) : null;
      if (releaseName) result.releases.add(releaseName);
      result.files.push({ filename: entry.name, filepath: full, ext, size, release_name: releaseName });
      if (STL_EXTS.has(ext))                                     result.hasStl = true;
      if (ext==='.chitubox'||ext==='.ctb'||ext==='.photon')      result.hasChitubox = true;
      if (ext==='.lys'||ext==='.lychee')                         result.hasLychee = true;
      if (PLATE_EXTS.has(ext))                                   result.hasPlate = true;
      if (IMAGE_EXTS.has(ext))                                   result.images.push(full);
      if (ARCHIVE_EXTS.has(ext) && isRenderArchive(entry.name))       result.renderArchives.push(full);
    }
  }

  return result;
}

// ── Model-folder discovery (lib/discovery.js) ─────────────────────────────────
// Sub-folder names that are a VARIANT or ROLE of the model around them live in
// lib/discovery.js (shared with the layout-aware scanner).

// ── Prepared statements (compiled once, reused thousands of times) ────────────

const stmts = {
  getCreator:    db.prepare('SELECT id, render_zip_hint FROM creators WHERE name = ?'),
  addCreator:    db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)'),

  getModel:      db.prepare('SELECT id, uuid, folder_hash, images, thumbnail_path, render_zip_hint, creator_id, name_locked FROM models WHERE folder_path = ?'),
  insertModel:   db.prepare(`
    INSERT INTO models (uuid, name, creator_id, folder_path, source_site,
      file_count, has_stl, has_chitubox, has_lychee, has_plate,
      thumbnail_path, images, folder_hash, franchise, team, last_scanned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `),
  // User edits win: a locked (user-renamed) name is kept, and franchise/team
  // are only filled from the folder path when they are still empty.
  updateModel:   db.prepare(`
    UPDATE models SET
      name = CASE WHEN COALESCE(name_locked, 0) = 1 THEN name ELSE ? END,
      creator_id=?, source_site=?,
      file_count=?, has_stl=?, has_chitubox=?, has_lychee=?, has_plate=?,
      thumbnail_path=?, images=?, folder_hash=?,
      franchise = COALESCE(NULLIF(franchise, ''), ?),
      team = COALESCE(NULLIF(team, ''), ?),
      last_scanned=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `),
  touchModel:    db.prepare(`UPDATE models SET last_scanned=datetime('now') WHERE id=?`),
  reattribute:   db.prepare(`UPDATE models SET creator_id=?, updated_at=datetime('now') WHERE id=?`),

  deleteFiles:   db.prepare('DELETE FROM model_files WHERE model_id = ?'),
  insertFile:    db.prepare(`
    INSERT OR IGNORE INTO model_files (model_id, filename, filepath, filetype, filesize, release_name)
    VALUES (?,?,?,?,?,?)
  `),

  // Stale models that sit INSIDE a variant sub-folder of a model (left over from
  // before variant folders were merged — e.g. a model called "Supported").
  staleUnder:    db.prepare(`
    SELECT id, folder_path, tags, is_favorite, print_status, notes FROM models
    WHERE (folder_path = ? OR (folder_path > ? AND folder_path < ?))
      AND (hidden IS NULL OR hidden = 0)
  `),
  modelUserData: db.prepare('SELECT tags, is_favorite, print_status, notes FROM models WHERE id = ?'),
  mergeUserData: db.prepare(`UPDATE models SET tags=?, is_favorite=?, print_status=?, notes=?, updated_at=datetime('now') WHERE id=?`),
  moveCollections: db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order) SELECT collection_id, ?, sort_order FROM collection_models WHERE model_id = ?'),
  moveQueue:     db.prepare('UPDATE OR IGNORE print_queue SET model_id = ? WHERE model_id = ?'),
  hideModel:     db.prepare(`UPDATE models SET hidden = 1, folder_hash = NULL, updated_at = datetime('now') WHERE id = ?`),

  finishLog:     db.prepare(`
    UPDATE scan_log
    SET status=?, models_found=?, models_added=?, models_updated=?, models_skipped=?, finished_at=datetime('now')
    WHERE id=?
  `),
  errorLog:      db.prepare(`UPDATE scan_log SET status=?, error=?, finished_at=datetime('now') WHERE id=?`),
};

function getOrCreateCreator(name, folderPath) {
  const existing = stmts.getCreator.get(name);
  if (existing) return existing.id;
  return stmts.addCreator.run(name, folderPath).lastInsertRowid;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

// Folder names we descend THROUGH (a mount root, a download dump, etc.) rather
// than treat as a creator. Helps with chains like "STL Archive/Gumroad Downloads/<creator>".
const PASSTHROUGH_NAME = /^(gumroad|gumroad downloads?|downloads?|backups?|sync|syncthing|temp|tmp|unsorted|to[\s_-]?sort|imports?|stl[\s_-]?archive|3d[\s_-]?prints?|prints?|library)$/i;
const MAX_PASSTHROUGH_DEPTH = 6;

function dirInfo(dirPath) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return { childDirs: [], hasPrintable: false }; }
  entries = entries.filter(e => !IGNORED_FOLDERS.has(e.name) && !isJunkFile(e.name));
  const hasPrintable = entries.some(e => {
    if (e.isDirectory()) return false;
    const ext = path.extname(e.name).toLowerCase();
    return STL_EXTS.has(ext) || ARCHIVE_EXTS.has(ext) || SLICE_EXTS.has(ext) || PLATE_EXTS.has(ext);
  });
  const childDirs = entries.filter(e => e.isDirectory());
  return { childDirs, hasPrintable };
}

/**
 * Decide whether `name` (with already-computed `info`) is a pass-through container
 * to descend into, vs. a creator folder to stop at. A folder is a pass-through
 * when it holds no printable files AND either its name looks like a dump/mount,
 * or — near the top of the tree — it has just a single subfolder (a wrapper).
 * Otherwise it's a creator. Pure function (no fs) so it's easy to reason about/test.
 */
function isPassthrough(name, info, depth) {
  if (info.hasPrintable || info.childDirs.length === 0) return false;
  if (PASSTHROUGH_NAME.test(String(name).trim())) return true;
  if (depth < 2 && info.childDirs.length === 1) return true;
  return false;
}

/**
 * Resolve the real creator folders under basePath, descending through
 * pass-through containers (mount roots, download dumps, single-child wrappers).
 */
function resolveCreatorDirs(basePath, depth = 0, log = () => {}, overrides = new Map()) {
  const info = dirInfo(basePath);
  const results = [];
  for (const dir of info.childDirs) {
    const dirPath = path.join(basePath, dir.name);

    // Manual overrides win over the heuristic
    const ov = overrides.get(dirPath);
    if (ov === 'ignore') { log('info', `Skipping "${dir.name}" (manual override: ignore)`); continue; }
    if (ov === 'creator') { results.push({ name: dir.name, path: dirPath }); continue; }
    if (ov === 'passthrough' && depth < MAX_PASSTHROUGH_DEPTH) {
      log('info', `"${dir.name}" → descending (manual override: container)`);
      results.push(...resolveCreatorDirs(dirPath, depth + 1, log, overrides));
      continue;
    }

    const childInfo = dirInfo(dirPath);
    if (depth < MAX_PASSTHROUGH_DEPTH && isPassthrough(dir.name, childInfo, depth)) {
      log('info', `"${dir.name}" looks like a container — descending to find creators inside it`);
      results.push(...resolveCreatorDirs(dirPath, depth + 1, log, overrides));
    } else {
      results.push({ name: dir.name, path: dirPath });
    }
  }
  return results;
}

// ── Per-model processing (shared by scanLibrary and scanSingleCreator) ────────

function loadFolderOverrides() {
  try { return new Map(db.prepare('SELECT path, role FROM folder_overrides').all().map(r => [r.path, r.role])); }
  catch { return new Map(); }
}

function nextPathBound(p) {
  // Everything strictly under `p + sep` sorts between `p + sep` and `p + (sep+1)`
  const sep = path.sep;
  return [p + sep, p + String.fromCharCode(sep.charCodeAt(0) + 1)];
}

/** Non-hidden models whose folder is one of this model's variant sub-folders (or inside one). */
function findStaleVariantModels(model) {
  if (!model.variantDirs || model.variantDirs.length === 0) return [];
  const out = [];
  for (const v of model.variantDirs) {
    const vp = path.join(model.fullPath, v);
    const [lo, hi] = nextPathBound(vp);
    // Only models sitting IN the variant folder or in nested variant/media
    // folders (Supported/STL) are stale; anything else is a real model.
    for (const row of stmts.staleUnder.all(vp, lo, hi)) {
      const rest = path.relative(vp, row.folder_path);
      if (rest === '' || rest.split(path.sep).every(seg => VARIANT_DIR.test(seg.trim()))) out.push(row);
    }
  }
  return out;
}

/**
 * Phase 1 (filesystem only, no DB writes): hash, analyze, extract renders.
 * Runs OUTSIDE the write transaction so slow archive extraction never holds
 * the SQLite write lock.
 */
async function prepareModel(model, ctx) {
  const existing = stmts.getModel.get(model.fullPath);
  const hash = folderHash(model.fullPath);
  const stale = findStaleVariantModels(model);

  // ── Skip if unchanged (and nothing left over to absorb) ───────────────────
  if (existing && existing.folder_hash === hash && stale.length === 0) {
    return { kind: 'skip', model, existing };
  }

  const analysis = analyzeFolder(model.fullPath, ctx.creatorName);
  const sourceSite = detectSourceSite(model.fullPath) || detectSourceSite(model.name);
  const modelUuid = existing ? existing.uuid : uuidv4();

  // Extract franchise/team from path relative to creator folder
  // e.g. creator/Marvel/X-Men/Cable → franchise=Marvel, team=X-Men
  const relParts = path.relative(ctx.creatorPath, model.fullPath).split(path.sep).filter(Boolean);
  const pathFranchise = relParts.length >= 2 ? relParts[0] : null;
  const pathTeam      = relParts.length >= 3 ? relParts[1] : null;
  // Model-level hint overrides creator-level hint
  const hint = existing?.render_zip_hint || ctx.creatorHint || null;

  let allImages = [];
  if (existing) { try { allImages = JSON.parse(existing.images || '[]'); } catch { allImages = []; } }

  const freshImages = [];
  const renderArchives = pickRenderArchives(analysis, hint);
  for (const archivePath of renderArchives) {
    ctx.log('zip', `    📦 ${path.basename(archivePath)}`);
    const imgs = await extractImagesFromArchive(archivePath, modelUuid);
    freshImages.push(...imgs);
    if (imgs.length) ctx.log('img', `       → ${imgs.length} image(s)`);
  }
  if (freshImages.length === 0 && analysis.images.length > 0) {
    freshImages.push(...extractImagesFromFolder(model.fullPath, modelUuid));
    // Renders that live in a variant sub-folder (e.g. "Renders/") of this model
    for (const v of model.variantDirs || []) {
      if (MEDIA_DIR.test(v.trim())) freshImages.push(...extractImagesFromFolder(path.join(model.fullPath, v), modelUuid));
    }
  }
  // Merge: keep manually-added images, add newly found ones
  if (freshImages.length > 0) allImages = [...new Set([...freshImages, ...allImages])];
  // Rank so the best render is the thumbnail and leads the viewer order
  allImages = rankImages(allImages);
  // Preserve a manually-chosen thumbnail if it's still present
  const thumbnail = (existing && existing.thumbnail_path && allImages.includes(existing.thumbnail_path))
    ? existing.thumbnail_path : (allImages[0] || null);

  return {
    kind: existing ? 'update' : 'add',
    model, existing, hash, analysis, sourceSite, modelUuid,
    pathFranchise, pathTeam, allImages, thumbnail, stale,
  };
}

/** Fold a stale variant model's user data into the real model, then hide it (never delete). */
function absorbStale(parentId, stale, log, modelName) {
  if (!stale.length) return;
  const parent = stmts.modelUserData.get(parentId);
  let tags = []; try { tags = JSON.parse(parent.tags || '[]'); } catch {}
  let fav = parent.is_favorite ? 1 : 0;
  let status = parent.print_status || 'unprinted';
  let notes = parent.notes || '';
  for (const kid of stale) {
    try { for (const t of JSON.parse(kid.tags || '[]')) if (!tags.includes(t)) tags.push(t); } catch {}
    if (kid.is_favorite) fav = 1;
    if (status === 'unprinted' && kid.print_status && kid.print_status !== 'unprinted') status = kid.print_status;
    if (kid.notes && !notes.includes(kid.notes)) notes = notes ? `${notes}\n${kid.notes}` : kid.notes;
    stmts.moveCollections.run(parentId, kid.id);
    stmts.moveQueue.run(parentId, kid.id);
    stmts.hideModel.run(kid.id);
  }
  stmts.mergeUserData.run(JSON.stringify(tags), fav, status, notes || null, parentId);
  log('info', `    ⇲ Merged ${stale.length} variant sub-folder model(s) into ${modelName}`);
}

/** Phase 2 (inside a write transaction): write the prepared result. Returns the outcome. */
function commitModel(p, ctx) {
  const { model, existing } = p;
  if (p.kind === 'skip') {
    stmts.touchModel.run(existing.id);
    // Fix creator attribution even on skip (e.g. "STL Archive" → actual creator)
    if (existing.creator_id !== ctx.creatorId) {
      stmts.reattribute.run(ctx.creatorId, existing.id);
      ctx.log('info', `  ↻ Re-attributed: ${model.name} → ${ctx.creatorName}`);
    }
    ctx.log('skip', `  ⟳ Unchanged: ${model.name}`);
    return 'skipped';
  }

  const { analysis } = p;
  // Stale variant models own some of these files (model_files.filepath is
  // UNIQUE) — release them first so the real model can claim them.
  for (const kid of p.stale) stmts.deleteFiles.run(kid.id);

  const name = inferModelName(model.fullPath);
  const releaseList = [...analysis.releases];
  const relInfo = releaseList.length ? `, ${releaseList.length} release${releaseList.length > 1 ? 's' : ''}` : '';
  let id;
  if (existing) {
    id = existing.id;
    stmts.updateModel.run(
      name, ctx.creatorId, p.sourceSite,
      analysis.files.length, analysis.hasStl ? 1 : 0,
      analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
      p.thumbnail, JSON.stringify(p.allImages), p.hash, p.pathFranchise, p.pathTeam, id
    );
    stmts.deleteFiles.run(id);
  } else {
    id = stmts.insertModel.run(
      p.modelUuid, name, ctx.creatorId, model.fullPath, p.sourceSite,
      analysis.files.length, analysis.hasStl ? 1 : 0,
      analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
      p.thumbnail, JSON.stringify(p.allImages), p.hash, p.pathFranchise, p.pathTeam
    ).lastInsertRowid;
  }
  for (const f of analysis.files) stmts.insertFile.run(id, f.filename, f.filepath, fileType(f.filename), f.size, f.release_name || null);
  absorbStale(id, p.stale, ctx.log, model.name);

  if (existing) {
    ctx.log('update', `    ↻ ${model.name} (${analysis.files.length} files${relInfo})`);
    return 'updated';
  }
  ctx.log('add', `    + ${model.name} (${analysis.files.length} files${relInfo}${p.allImages.length ? `, ${p.allImages.length} img` : ''})`);
  return 'added';
}

/**
 * Discover and process every model folder of one creator, in chunks of 10:
 * filesystem work first (outside any transaction), then one short write
 * transaction per chunk, then a yield so SSE/progress stay live.
 */
async function processCreatorModels(ctx, progressCallback, counters) {
  const discovered = discoverModelFolders(ctx.creatorPath, '', 5, ctx.overrides);
  ctx.log('creator', `▸ ${ctx.creatorName} (${discovered.length} model${discovered.length !== 1 ? 's' : ''})`);

  const CHUNK_SIZE = 10;
  for (let ci = 0; ci < discovered.length; ci += CHUNK_SIZE) {
    const chunk = discovered.slice(ci, ci + CHUNK_SIZE);
    const prepared = [];
    for (const model of chunk) {
      counters.modelsFound++;
      if (progressCallback) progressCallback({ stage: 'scanning', creator: ctx.creatorName, model: model.name, found: counters.modelsFound });
      try {
        prepared.push(await prepareModel(model, ctx));
      } catch (e) {
        ctx.log('error', `  ✗ ${model.name}: ${e.message}`);
      }
    }

    db.transaction(() => {
      for (const p of prepared) {
        const outcome = commitModel(p, ctx);
        if (outcome === 'skipped') counters.modelsSkipped++;
        else if (outcome === 'updated') counters.modelsUpdated++;
        else if (outcome === 'added') counters.modelsAdded++;
      }
    })();

    // Yield to event loop so SSE can deliver progress updates
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function scanLibraryLegacy(libraryPath, progressCallback, logger) {
  const log = logger || (() => {});
  const logId = db.prepare('INSERT INTO scan_log (scan_path, status) VALUES (?, ?)').run(libraryPath, 'running').lastInsertRowid;

  const counters = { modelsFound: 0, modelsAdded: 0, modelsUpdated: 0, modelsSkipped: 0 };

  // Clean up any creators/models from Synology system folders left over from earlier scans
  const junkCreators = db.prepare(
    `SELECT id, name FROM creators WHERE ${[...IGNORED_FOLDERS].map(() => 'name = ?').join(' OR ')}`
  ).all(...IGNORED_FOLDERS);
  if (junkCreators.length > 0) {
    const junkIds = junkCreators.map(c => c.id);
    const placeholders = junkIds.map(() => '?').join(',');
    const deletedModels = db.prepare(`DELETE FROM models WHERE creator_id IN (${placeholders})`).run(...junkIds).changes;
    const deletedCreators = db.prepare(`DELETE FROM creators WHERE id IN (${placeholders})`).run(...junkIds).changes;
    log('info', `Cleaned up ${deletedCreators} system folder creator(s) and ${deletedModels} model(s) (${junkCreators.map(c => c.name).join(', ')})`);
  }

  try {
    // Resolve creator directories — handle pass-through library roots.
    // If a top-level folder contains ONLY subdirectories (no printable files),
    // it's likely a library root like "STL Archive" and its children are the
    // actual creators. We flatten these out so we don't attribute everything
    // to the library root name.
    const folderOverrides = loadFolderOverrides();
    const creatorDirs = resolveCreatorDirs(libraryPath, 0, log, folderOverrides);
    log('info', `Found ${creatorDirs.length} creator folder(s)`);

    for (const creatorDir of creatorDirs) {
      // Yield before each creator so /api/scan/status, the SSE stream, and the
      // rest of the app stay responsive during long scans (esp. slow SMB mounts).
      await new Promise(resolve => setImmediate(resolve));

      const creatorName = creatorDir.name;
      const creatorId = getOrCreateCreator(creatorName, creatorDir.path);
      const creatorRow = stmts.getCreator.get(creatorName);

      if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName });

      // Discover model folders recursively — handles archive-style creators
      // like "Wicked Archive/Star Wars/Vehicles/X-wing" by walking past
      // category-only folders until finding actual printable content.
      await processCreatorModels({
        creatorPath: creatorDir.path, creatorName, creatorId,
        creatorHint: creatorRow?.render_zip_hint || null,
        overrides: folderOverrides, log,
      }, progressCallback, counters);
    }

    // Clean up orphaned creators (no models left — e.g. "STL Archive" after re-attribution)
    const orphaned = db.prepare('DELETE FROM creators WHERE id NOT IN (SELECT DISTINCT creator_id FROM models WHERE creator_id IS NOT NULL)').run();
    if (orphaned.changes > 0) log('info', `Cleaned up ${orphaned.changes} orphaned creator(s)`);

    const { modelsFound, modelsAdded, modelsUpdated, modelsSkipped } = counters;
    stmts.finishLog.run('complete', modelsFound, modelsAdded, modelsUpdated, modelsSkipped, logId);
    log('info', `Skipped ${modelsSkipped} unchanged model(s)`);
    return { success: true, modelsFound, modelsAdded, modelsUpdated, modelsSkipped };

  } catch (err) {
    stmts.errorLog.run('error', err.message, logId);
    throw err;
  }
}

/**
 * scanSingleCreator — scan one creator folder in isolation.
 * Uses the same per-model pipeline as scanLibrary.
 * Called by POST /api/scan/creator/:id.
 */
async function scanSingleCreatorLegacy(creatorPath, creatorId, creatorName, progressCallback, logger) {
  const log = logger || (() => {});
  const logId = db.prepare('INSERT INTO scan_log (scan_path, status) VALUES (?, ?)').run(creatorPath, 'running').lastInsertRowid;

  const counters = { modelsFound: 0, modelsAdded: 0, modelsUpdated: 0, modelsSkipped: 0 };

  try {
    const creatorRow = stmts.getCreator.get(creatorName);
    if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName });

    await processCreatorModels({
      creatorPath, creatorName, creatorId,
      creatorHint: creatorRow?.render_zip_hint || null,
      overrides: loadFolderOverrides(), log,
    }, progressCallback, counters);

    const { modelsFound, modelsAdded, modelsUpdated, modelsSkipped } = counters;
    stmts.finishLog.run('complete', modelsFound, modelsAdded, modelsUpdated, modelsSkipped, logId);
    log('info', `Skipped ${modelsSkipped} unchanged model(s)`);
    return { success: true, modelsFound, modelsAdded, modelsUpdated, modelsSkipped };

  } catch (err) {
    stmts.errorLog.run('error', err.message, logId);
    throw err;
  }
}

// ── Layout-aware scan (docs/library-metadata.md) ─────────────────────────────
// LAYOUT_MODE=legacy keeps the folder-based scanner above; the default groups
// files into works (studio identity, release packs, folder fallback) and
// attributes them from <library>/_Meta.
const worksLib = require('./lib/works');
const metaLib = require('./lib/meta');
const librariesLib = require('./lib/libraries');

function layoutMode() {
  return String(process.env.LAYOUT_MODE || 'layout').trim().toLowerCase() === 'legacy' ? 'legacy' : 'layout';
}

function imageMaxBytes() {
  const mb = parseFloat(process.env.IMAGE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}
const MAX_RENDER_ARCHIVES = 2;   // per work and scan (Wicked works carry one Images.zip per edition/variant)
const MAX_ARCHIVE_IMAGES = 12;   // best-ranked images taken from each archive
const MAX_LOOSE_IMAGES = 24;

/** Libraries (top-level folders) + the merged _Meta of every library. */
function loadLibraryMeta(log = () => {}) {
  const root = process.env.LIBRARY_PATH || LIBRARY_PATH;
  let libs = librariesLib.listLibraries(root);
  const dirs = [...new Set([path.join(root, '_Meta'), ...libs.map(l => path.join(l.path, '_Meta'))])];
  const meta = metaLib.loadMeta({ dirs, roots: [...new Set([root, ...libs.map(l => l.path)])], log });
  if (meta.vault && meta.vault.libraryLabels) libs = librariesLib.listLibraries(root, meta.vault.libraryLabels);
  return { meta, libs };
}

/** analyzeFolder()-shaped result from a list of model_files rows (works may share or span folders). */
function analysisFromFiles(rows) {
  const result = { files: [], hasStl: false, hasChitubox: false, hasLychee: false, hasPlate: false, images: [], renderArchives: [], releases: new Set() };
  for (const r of rows) {
    const fp = r.filepath || r.abs;
    const filename = r.filename || r.name || path.basename(fp);
    const ext = path.extname(filename).toLowerCase();
    result.files.push({ filename, filepath: fp, ext, size: r.filesize ?? r.size ?? 0, release_name: r.release_name || null });
    if (STL_EXTS.has(ext)) result.hasStl = true;
    if (ext === '.chitubox' || ext === '.ctb' || ext === '.photon') result.hasChitubox = true;
    if (ext === '.lys' || ext === '.lychee') result.hasLychee = true;
    if (PLATE_EXTS.has(ext)) result.hasPlate = true;
    if (IMAGE_EXTS.has(ext)) result.images.push(fp);
    if (ARCHIVE_EXTS.has(ext) && (isRenderArchive(filename) || r.variant === 'images')) result.renderArchives.push(fp);
  }
  return result;
}

function copyImageFiles(paths, modelUuid) {
  const out = [];
  const dir = path.join(IMAGES_DIR, modelUuid);
  for (const src of paths) {
    try {
      const st = fs.statSync(src);
      if (st.size > imageMaxBytes()) continue;
      const safeName = path.basename(src).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, safeName);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      out.push(`/images/${modelUuid}/${safeName}`);
    } catch (e) {
      console.warn(`Could not copy image ${src}: ${e.message}`);
    }
  }
  return out;
}

/** Renders for a work: hinted/render archives first (legacy order), then loose images. */
async function workImages(w, modelUuid, hint, log) {
  const analysis = analysisFromFiles(w.files);
  const fresh = [];
  const archives = pickRenderArchives(analysis, hint).slice(0, MAX_RENDER_ARCHIVES);
  for (const a of archives) {
    log('zip', `    📦 ${path.basename(a)}`);
    const imgs = await extractImagesFromArchive(a, modelUuid, { limit: MAX_ARCHIVE_IMAGES });
    fresh.push(...imgs);
    if (imgs.length) log('img', `       → ${imgs.length} image(s)`);
  }
  if (!fresh.length && analysis.images.length) fresh.push(...copyImageFiles(rankImages(analysis.images).slice(0, MAX_LOOSE_IMAGES), modelUuid));
  return fresh;
}

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

const STUDIO_KINDS = new Set(['work', 'diorama']);
function pathSegmentSet(...paths) {
  const out = new Set();
  for (const p of paths) for (const seg of String(worksLib.realFolder(p || '')).split(/[\\/]/)) if (seg) out.add(seg.trim().toLowerCase());
  return out;
}
const eqi = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * franchise (= genre) and team for a work. User edits win; values the old folder scanner
 * derived from the path are cleaned up: a franchise equal to a folder of the card that is not a
 * genre ("Humblewood STLs", "Unsupported", "April"), and on works/dioramas/release items a team
 * that mirrors the group or a folder. A franchise still holding our previous automatic value follows the new one.
 */
function franchiseAndTeam(w, base, prevAttr, meta) {
  const auto = w.attr.genre || null;
  const autoTeam = w.kind === 'model' ? (w.pathTeam || null) : null;
  if (!base) return { franchise: auto, team: autoTeam };
  const segs = pathSegmentSet(base.folder_path, w.folderPath);
  let fr = base.franchise || null;
  if (fr && segs.has(fr.trim().toLowerCase()) && !metaLib.isKnownGenre(meta, fr)) fr = null;
  if (fr && prevAttr.autoFranchise !== undefined && fr === prevAttr.autoFranchise) fr = null;
  let team = base.team || null;
  if (team && !(w.kind === 'model' || w.kind === 'tool')) {
    if (eqi(team, base.group_name) || eqi(team, w.group) || segs.has(team.trim().toLowerCase())) team = null;
  }
  return { franchise: fr || auto, team: team || autoTeam };
}

/** release_name like the old analyzeFolder: first sub-folder below the work folder, or the archive stem. */
function releaseNameFor(file, folder, creatorName) {
  const rel = path.relative(folder, file.abs);
  if (rel.startsWith('..')) return null;
  const parts = rel.split(path.sep);
  if (parts.length > 1) return inferReleaseName(parts[0], creatorName);
  return ARCHIVE_EXTS.has(path.extname(file.name).toLowerCase()) ? inferReleaseName(file.name, creatorName) : null;
}

function cleanupJunkCreators(log) {
  const junkCreators = db.prepare(
    `SELECT id, name FROM creators WHERE ${[...IGNORED_FOLDERS].map(() => 'name = ?').join(' OR ')}`
  ).all(...IGNORED_FOLDERS);
  if (junkCreators.length > 0) {
    const junkIds = junkCreators.map(c => c.id);
    const placeholders = junkIds.map(() => '?').join(',');
    const deletedModels = db.prepare(`DELETE FROM models WHERE creator_id IN (${placeholders})`).run(...junkIds).changes;
    const deletedCreators = db.prepare(`DELETE FROM creators WHERE id IN (${placeholders})`).run(...junkIds).changes;
    log('info', `Cleaned up ${deletedCreators} system folder creator(s) and ${deletedModels} model(s) (${junkCreators.map(c => c.name).join(', ')})`);
  }
}

let L = null; // layout statements, prepared on first use (scanner.test.js mocks the DB)
function layoutStmts() {
  if (L) return L;
  L = {
    insert: db.prepare(`
      INSERT INTO models (uuid, name, creator_id, folder_path, source_site, source_url,
        file_count, has_stl, has_chitubox, has_lychee, has_plate, thumbnail_path, images, folder_hash,
        franchise, team, work_key, kind, library, libraries, studio, character, group_name, editions,
        release_term, release_label, source, products, attribution, confidence, last_scanned)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`),
    update: db.prepare(`
      UPDATE models SET
        name = CASE WHEN COALESCE(name_locked, 0) = 1 THEN name ELSE ? END,
        creator_id=?, folder_path=?, source_site=COALESCE(?, source_site), source_url=?,
        file_count=?, has_stl=?, has_chitubox=?, has_lychee=?, has_plate=?,
        thumbnail_path=?, images=?, folder_hash=?, franchise=?, team=?,
        work_key=?, kind=?, library=?, libraries=?, studio=?, character=?, group_name=?, editions=?,
        release_term=?, release_label=?, source=?, products=?, attribution=?, confidence=?,
        last_scanned=datetime('now'), updated_at=datetime('now')
      WHERE id=?`),
    touch: db.prepare(`UPDATE models SET last_scanned=datetime('now') WHERE id=?`),
    setPath: db.prepare(`UPDATE models SET folder_path=? WHERE id=?`),
    delByPath: db.prepare('DELETE FROM model_files WHERE filepath = ?'),
    delModelScope: db.prepare('DELETE FROM model_files WHERE model_id = ? AND filepath > ? AND filepath < ?'),
    delModelAll: db.prepare('DELETE FROM model_files WHERE model_id = ?'),
    insFile: db.prepare(`
      INSERT OR REPLACE INTO model_files (model_id, filename, filepath, filetype, filesize, release_name, library, variant, edition, product, matched_by, printed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    fileStats: db.prepare(`SELECT COUNT(*) n, GROUP_CONCAT(DISTINCT library) libs FROM model_files WHERE model_id = ?`),
    fold: db.prepare(`UPDATE models SET hidden = 1, folder_hash = NULL, work_key = NULL, attribution = ?, creator_id = COALESCE(?, creator_id), updated_at = datetime('now') WHERE id = ?`),
    full: db.prepare('SELECT * FROM models WHERE id = ?'),
    mergeUser: db.prepare(`UPDATE models SET tags=?, is_favorite=?, print_status=?, notes=?, images=?, thumbnail_path=?, name=?, name_locked=?, source_url=COALESCE(NULLIF(source_url,''), ?), updated_at=datetime('now') WHERE id=?`),
  };
  return L;
}

/**
 * The layout-aware scan. `scope` limits it to one creator folder (per-creator rescan):
 * only files under scope are walked, replaced and re-grouped.
 */
async function scanLibraryLayout(libraryPath, progressCallback, logger, { scope = null } = {}) {
  const log = logger || (() => {});
  const t0 = Date.now();
  const logId = db.prepare('INSERT INTO scan_log (scan_path, status) VALUES (?, ?)').run(scope || libraryPath, 'running').lastInsertRowid;
  const counters = { modelsFound: 0, modelsAdded: 0, modelsUpdated: 0, modelsSkipped: 0, folded: 0 };
  cleanupJunkCreators(log);
  const S = layoutStmts();
  try {
    if (!scope && typeof db.getSetting === 'function' && !db.getSetting('layout_regroup_done')) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM models').get().n;
      if (n > 0) {
        const file = require('./lib/backup').snapshot('pre-regroup', { db, log: { log: (m) => log('info', m), error: (m) => log('warn', m) } });
        if (file) log('info', `Backup written before regrouping into works: ${path.basename(file)}`);
      }
    }
    const tm = Date.now();
    const { meta, libs } = loadLibraryMeta(log);
    const metaMs = Date.now() - tm;
    const overrides = loadFolderOverrides();
    const ignore = new Set([...overrides].filter(([, r]) => r === 'ignore').map(([p]) => p));
    const tw = Date.now();
    const tree = worksLib.walkTree(libraryPath, { ignore, scope });
    log('info', `Walked ${tree.fileCount} file(s) in ${Date.now() - tw} ms`);
    const plan = worksLib.planWorks({ libraryPath, tree, meta, overrides, log, scope });
    worksLib.finalizeWorks(plan.works, { libraries: libs, libraryOf: librariesLib.libraryOf });
    for (const w of plan.works) {
      w.attr = worksLib.attributeWork(w, meta);
      if (w.attr.character) { w.name = w.attr.character; w.character = w.attr.character; }
    }
    const byKind = {};
    for (const w of plan.works) byKind[w.kind] = (byKind[w.kind] || 0) + 1;
    log('info', `Grouped into ${plan.works.length} card(s): ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`);

    // ── existing state ──
    const scopeRoot = scope || libraryPath;
    const [lo, hi] = nextPathBound(scopeRoot);
    const inScope = (p) => p > lo && p < hi;
    const existingFiles = new Map();
    const ownedTotal = new Map();
    for (const r of db.prepare('SELECT model_id, filepath, printed_at FROM model_files').all()) {
      ownedTotal.set(r.model_id, (ownedTotal.get(r.model_id) || 0) + 1);
      if (inScope(r.filepath)) existingFiles.set(r.filepath, r);
    }
    const rows = new Map(db.prepare('SELECT id, uuid, work_key, folder_path, hidden, name, name_locked, folder_hash, images, thumbnail_path, render_zip_hint, creator_id, attribution, franchise, team, group_name, source_url FROM models').all().map(r => [r.id, r]));
    const byKey = new Map();
    const byFolder = new Map();
    for (const r of rows.values()) {
      r.folded = /#folded-\d+$/.test(r.folder_path || '') || !!parseJSON(r.attribution, {}).foldedInto;
      if (r.work_key && !r.folded && (!byKey.has(r.work_key) || byKey.get(r.work_key).hidden)) byKey.set(r.work_key, r);
      byFolder.set(r.folder_path, r);
    }
    const produced = new Set(plan.works.map(w => w.key));
    const walked = new Set();
    for (const w of plan.works) for (const f of w.files) walked.add(f.abs);

    // ── bases: the row each work updates (same work_key, else a stale/legacy row in its folder) ──
    const claimed = new Map(); // row id → work
    for (const w of plan.works) {
      const owners = new Map();
      for (const f of w.files) { const e = existingFiles.get(f.abs); if (e) owners.set(e.model_id, (owners.get(e.model_id) || 0) + 1); }
      w.owners = owners;
      let base = byKey.get(w.key);
      if (base && claimed.has(base.id)) base = null;
      if (!base) {
        const real = worksLib.realFolder(w.folderPath);
        for (const fp of [w.folderPath, real]) {
          const r = byFolder.get(fp);
          if (r && !claimed.has(r.id) && !r.folded && (!r.work_key || !produced.has(r.work_key))) { base = r; break; }
        }
      }
      if (base) claimed.set(base.id, w);
      w.base = base || null;
    }
    // Rows left without files once the works take theirs → folded at the end. That covers
    // folder models whose files were re-grouped and the empty rows the folder scanner left
    // (sub-folders whose files a parent model had claimed).
    const moved = new Map();
    for (const w of plan.works) for (const [id, n] of w.owners) moved.set(id, (moved.get(id) || 0) + n);
    const emptyFolders = new Map(); // real folder → row ids with no files at all
    const foldable = new Set();
    for (const r of rows.values()) {
      if (claimed.has(r.id) || r.folded || (r.work_key && produced.has(r.work_key))) continue;
      const total = ownedTotal.get(r.id) || 0;
      if (total && moved.get(r.id) === total) foldable.add(r.id);
      else if (!total && !r.hidden) {
        const rf = worksLib.realFolder(r.folder_path || '');
        if (rf && inScope(rf + path.sep)) { if (!emptyFolders.has(rf)) emptyFolders.set(rf, []); emptyFolders.get(rf).push(r.id); }
      }
    }
    const emptyTarget = new Map(); // row id → work holding most files under its folder
    if (emptyFolders.size) {
      // the folder itself, else its nearest ancestor below the creator (a row left inside a
      // skipped ".ArchiveServiceTemp…" folder belongs with the work around it)
      const wanted = new Set();
      for (const folder of emptyFolders.keys()) {
        for (let d = folder, i = 0; i < 4 && d.length > scopeRoot.length; i++, d = path.dirname(d)) wanted.add(d);
      }
      const counts = new Map(); // folder → Map(work → n)
      for (const w of plan.works) {
        for (const f of w.files) {
          for (let d = f.dir; d.length >= scopeRoot.length; d = path.dirname(d)) {
            if (wanted.has(d)) { const m = counts.get(d) || new Map(); m.set(w, (m.get(w) || 0) + 1); counts.set(d, m); }
            if (d === path.dirname(d)) break;
          }
        }
      }
      for (const [folder, ids] of emptyFolders) {
        let m = null;
        for (let d = folder, i = 0; !m && i < 4 && d.length > scopeRoot.length; i++, d = path.dirname(d)) m = counts.get(d) || null;
        if (!m) continue; // nothing left there: kept for /api/organize/integrity
        const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
        for (const id of ids) { foldable.add(id); emptyTarget.set(id, best); }
      }
    }
    // ── folder_path collisions with rows that are not moving ──
    db.transaction(() => {
      for (const [id, w] of claimed) {
        const r = rows.get(id);
        if (r.folder_path !== w.folderPath) S.setPath.run(`${r.folder_path}#tmp-${id}`, id);
      }
      for (const w of plan.works) {
        const holder = byFolder.get(w.folderPath);
        if (!holder || (w.base && holder.id === w.base.id) || claimed.has(holder.id)) continue;
        if (foldable.has(holder.id) || holder.folded) { S.setPath.run(`${holder.folder_path}#folded-${holder.id}`, holder.id); holder.folder_path = `${holder.folder_path}#folded-${holder.id}`; holder.folded = true; }
        else w.folderPath = `${worksLib.realFolder(w.folderPath)}#${worksLib.slugify(`${w.kind} ${w.name}`)}`;
      }
    })();

    // ── upsert works in chunks: filesystem work first, then one short transaction ──
    const CHUNK = 25;
    const works = plan.works.sort((a, b) => (a.creator || '').localeCompare(b.creator || '') || a.name.localeCompare(b.name));
    for (let ci = 0; ci < works.length; ci += CHUNK) {
      const chunk = works.slice(ci, ci + CHUNK);
      const prepared = [];
      for (const w of chunk) {
        counters.modelsFound++;
        if (progressCallback) progressCallback({ stage: 'scanning', creator: w.creator, model: w.name, found: counters.modelsFound });
        const base = w.base;
        const prevAttr = base ? parseJSON(base.attribution, {}) : {};
        const products = JSON.stringify(w.attr.products);
        const attribution = { ...w.attr.attribution, autoFranchise: w.attr.genre || null, sourceUrl: w.attr.sourceUrl || null };
        const attrSig = JSON.stringify([products, w.attr.attribution, w.attr.genre, w.attr.release_term, w.attr.release_label, w.group || null, w.editions || [], w.libraries, w.name]);
        attribution.sig = crypto.createHash('sha1').update(attrSig).digest('hex').slice(0, 12);
        const filesOwned = base && w.owners.size === 1 && w.owners.get(base.id) === w.files.length;
        const ft = franchiseAndTeam(w, base, prevAttr, meta);
        const sameLabels = base && (base.franchise || null) === ft.franchise && (base.team || null) === ft.team;
        if (base && base.folder_hash === w.hash && filesOwned && prevAttr.sig === attribution.sig && base.folder_path === w.folderPath && sameLabels) {
          prepared.push({ w, skip: true });
          continue;
        }
        const uuid = base ? base.uuid : uuidv4();
        const creatorRow = stmts.getCreator.get(w.creator);
        const hint = (base && base.render_zip_hint) || (creatorRow && creatorRow.render_zip_hint) || null;
        let images = base ? parseJSON(base.images, []) : [];
        const needImages = !base || base.folder_hash !== w.hash || !images.length;
        if (needImages) {
          try {
            const fresh = await workImages(w, uuid, hint, log);
            if (fresh.length) images = [...new Set([...fresh, ...images])];
          } catch (e) { log('warn', `    images for ${w.name}: ${e.message}`); }
        }
        images = rankImages(images);
        const thumbnail = base && base.thumbnail_path && images.includes(base.thumbnail_path) ? base.thumbnail_path : (images[0] || null);
        prepared.push({ w, uuid, images, thumbnail, products, attribution, prevAttr, ft });
      }

      db.transaction(() => {
        for (const p of prepared) {
          const w = p.w;
          if (p.skip) { S.touch.run(w.base.id); counters.modelsSkipped++; continue; }
          const real = worksLib.realFolder(w.folderPath);
          const creatorId = getOrCreateCreator(w.creator, plan.creatorFolders.get(w.creator) || w.creatorFolder || real);
          const a = analysisFromFiles(w.files);
          const sourceSite = detectSourceSite(real) || detectSourceSite(w.name) || (w.attr.source === 'gumroad' || w.attr.source === 'patreon' ? w.attr.source : null);
          const base = w.base;
          const { franchise, team } = p.ft; // franchise = genre; user edits win (see franchiseAndTeam)
          const prevAutoUrl = p.prevAttr.sourceUrl;
          const sourceUrl = !base || !base.source_url || (prevAutoUrl && base.source_url === prevAutoUrl) ? (w.attr.sourceUrl || (base ? base.source_url : null) || null) : base.source_url;
          const vals = [
            JSON.stringify(w.libraries || []), w.studio || null, w.character || null, w.group || null, JSON.stringify(w.editions || []),
            w.attr.release_term || null, w.attr.release_label || null, w.attr.source || null, p.products, JSON.stringify(p.attribution), p.attribution.confidence,
          ];
          let id;
          if (base) {
            id = base.id;
            S.update.run(w.name, creatorId, w.folderPath, sourceSite, sourceUrl,
              w.files.length, a.hasStl ? 1 : 0, a.hasChitubox ? 1 : 0, a.hasLychee ? 1 : 0, a.hasPlate ? 1 : 0,
              p.thumbnail, JSON.stringify(p.images), w.hash, franchise, team,
              w.key, w.kind, w.library, ...vals, id);
            counters.modelsUpdated++;
            log('update', `    ↻ ${w.name} (${w.files.length} files)`);
          } else {
            id = S.insert.run(p.uuid, w.name, creatorId, w.folderPath, sourceSite, sourceUrl,
              w.files.length, a.hasStl ? 1 : 0, a.hasChitubox ? 1 : 0, a.hasLychee ? 1 : 0, a.hasPlate ? 1 : 0,
              p.thumbnail, JSON.stringify(p.images), w.hash, franchise, team,
              w.key, w.kind, w.library, ...vals).lastInsertRowid;
            counters.modelsAdded++;
            log('add', `    + ${w.name} (${w.files.length} files${p.images.length ? `, ${p.images.length} img` : ''})`);
          }
          w.rowId = id;
          // files: take them from their old owners, replace this row's files in scope
          S.delModelScope.run(id, lo, hi);
          for (const f of w.files) {
            const prev = existingFiles.get(f.abs);
            if (prev && prev.model_id !== id) S.delByPath.run(f.abs);
            S.insFile.run(id, f.name, f.abs, fileType(f.name), f.size, releaseNameFor(f, real, w.creator), f.library || null,
              f.variant || null, f.edition || null, f.product || null, f.matched_by || null, prev ? prev.printed_at : null);
          }
          if (scope) {
            const st = S.fileStats.get(id);
            db.prepare('UPDATE models SET file_count = ?, libraries = ? WHERE id = ?').run(st.n, JSON.stringify(String(st.libs || '').split(',').filter(Boolean)), id);
          }
        }
      })();
      await new Promise(resolve => setImmediate(resolve));
    }

    // ── fold old folder-based rows whose files now belong to works (never deleted) ──
    const foldInto = new Map(); // work → [row]
    for (const id of foldable) {
      let best = emptyTarget.get(id) || null, bestN = 0;
      if (!best) for (const w of plan.works) { const n = w.owners.get(id) || 0; if (n > bestN && w.rowId) { best = w; bestN = n; } }
      if (best && !best.rowId) best = null;
      if (best) { if (!foldInto.has(best)) foldInto.set(best, []); foldInto.get(best).push(id); }
    }
    db.transaction(() => {
      for (const [w, ids] of foldInto) {
        const target = S.full.get(w.rowId);
        let tags = parseJSON(target.tags, []);
        let fav = target.is_favorite ? 1 : 0;
        let status = target.print_status || 'unprinted';
        let notes = target.notes || '';
        let images = parseJSON(target.images, []);
        let thumb = target.thumbnail_path;
        let name = target.name, locked = target.name_locked ? 1 : 0;
        let srcUrl = null;
        const lockedNames = [];
        for (const id of ids) {
          const kid = S.full.get(id);
          if (!kid.hidden) {
            for (const t of parseJSON(kid.tags, [])) if (!tags.includes(t)) tags.push(t);
            if (kid.is_favorite) fav = 1;
            if (status === 'unprinted' && kid.print_status && kid.print_status !== 'unprinted') status = kid.print_status;
            if (kid.notes && !notes.includes(kid.notes)) notes = notes ? `${notes}\n${kid.notes}` : kid.notes;
            for (const im of parseJSON(kid.images, [])) if (!images.includes(im)) images.push(im);
            if (!thumb && kid.thumbnail_path) thumb = kid.thumbnail_path;
            if (kid.name_locked) lockedNames.push(kid.name);
            if (!srcUrl && kid.source_url) srcUrl = kid.source_url;
            stmts.moveCollections.run(w.rowId, id);
            stmts.moveQueue.run(w.rowId, id);
          }
          // folded rows keep their folder_path (renamed to "<path>#folded-<id>" only if a work needs it)
          S.fold.run(JSON.stringify({ ...parseJSON(kid.attribution, {}), foldedInto: w.rowId }), target.creator_id, id);
          counters.folded++;
        }
        if (lockedNames.length === 1 && !locked) { name = lockedNames[0]; locked = 1; }
        else if (lockedNames.length > 1) {
          const line = `Previous custom names: ${lockedNames.join('; ')}`;
          if (!notes.includes(line)) notes = notes ? `${notes}\n${line}` : line;
        }
        S.mergeUser.run(JSON.stringify(tags), fav, status, notes || null, JSON.stringify(images), thumb || null, name, locked, srcUrl, w.rowId);
        log('info', `    ⇲ Folded ${ids.length} earlier model(s) into ${w.name}`);
      }
    })();

    const orphaned = db.prepare('DELETE FROM creators WHERE id NOT IN (SELECT DISTINCT creator_id FROM models WHERE creator_id IS NOT NULL)').run();
    if (orphaned.changes > 0) log('info', `Cleaned up ${orphaned.changes} orphaned creator(s)`);
    if (!scope && typeof db.setSetting === 'function') {
      db.setSetting('layout_regroup_done', db.getSetting('layout_regroup_done') || new Date().toISOString());
      db.setSetting('meta_sidecars', plan.sidecars || 0); // model.json files seen by the last full scan (/api/meta/status)
    }

    const { modelsFound, modelsAdded, modelsUpdated, modelsSkipped, folded } = counters;
    stmts.finishLog.run('complete', modelsFound, modelsAdded, modelsUpdated, modelsSkipped, logId);
    const scanMs = Date.now() - t0;
    log('info', `Skipped ${modelsSkipped} unchanged card(s)${folded ? `, folded ${folded} earlier model(s)` : ''} — ${Math.round(scanMs / 100) / 10}s (meta ${metaMs} ms)`);
    return { success: true, modelsFound, modelsAdded, modelsUpdated, modelsSkipped, folded, byKind, metaMs, scanMs, files: tree.fileCount };
  } catch (err) {
    stmts.errorLog.run('error', err.message, logId);
    throw err;
  }
}

async function scanLibrary(libraryPath, progressCallback, logger) {
  if (layoutMode() === 'legacy') return scanLibraryLegacy(libraryPath, progressCallback, logger);
  return scanLibraryLayout(libraryPath, progressCallback, logger);
}

/**
 * scanSingleCreator — scan one creator folder (POST /api/scan/creator/:id).
 * Layout mode re-groups only the files under that folder.
 */
async function scanSingleCreator(creatorPath, creatorId, creatorName, progressCallback, logger) {
  if (layoutMode() === 'legacy') return scanSingleCreatorLegacy(creatorPath, creatorId, creatorName, progressCallback, logger);
  const root = process.env.LIBRARY_PATH || LIBRARY_PATH;
  const base = creatorPath === root || creatorPath.startsWith(root + path.sep) ? root : path.dirname(creatorPath);
  return scanLibraryLayout(base, progressCallback, logger, { scope: creatorPath });
}

module.exports = {
  scanLibrary, scanSingleCreator, scanLibraryLegacy, LIBRARY_PATH, matchesHint, pickRenderArchives, analyzeFolder,
  inferReleaseName, discoverModelFolders, extractImagesFromArchive, VARIANT_DIR, isImageFile: isRenderImage,
  layoutMode, rankImages, analysisFromFiles, realFolder: worksLib.realFolder, loadLibraryMeta, franchiseAndTeam,
};
