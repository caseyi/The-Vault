const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
// pic covers pics/pictures, image covers images/"(Images)", photo covers photos (docs/thumbnails.md §2.2)
const RENDER_KW   = ['render', 'preview', 'thumb', 'photo', 'pic', 'image', 'renders', 'previews', 'photos', 'presentation',
  'poster', 'promo', 'artwork', 'gallery', 'showcase'];
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

// RAR is read from disk (lib/rar.js, node-unrar-js createExtractorFromFile): only the image
// entries are written, so a multi-GB .rar no longer needs ARCHIVE_MAX_MB.
async function extractImagesFromRar(rarPath, modelUuid) {
  try {
    const names = await require('./lib/rar').extractRar(rarPath, path.join(IMAGES_DIR, modelUuid), (n) => isRenderImage(n), { maxBytes: imageMaxBytes() });
    return [...new Set(names)].map(n => `/images/${modelUuid}/${n}`);
  } catch (e) {
    console.warn(`Could not extract rar ${rarPath}: ${e.message}`);
    return [];
  }
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
  // memberships MOVE: copy (deduped by UNIQUE(collection_id, model_id)), then dropCollections(from)
  moveCollections: db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order) SELECT collection_id, ?, sort_order FROM collection_models WHERE model_id = ?'),
  dropCollections: db.prepare('DELETE FROM collection_models WHERE model_id = ?'),
  countCollections: db.prepare('SELECT COUNT(*) AS n FROM collection_models WHERE model_id = ?'),
  countQueue:    db.prepare('SELECT COUNT(*) AS n FROM print_queue WHERE model_id = ?'),
  collectionByName: db.prepare('SELECT id FROM collections WHERE name = ?'),
  createCollection: db.prepare('INSERT INTO collections (name, description, pinned) VALUES (?, ?, ?)'),
  addToCollection: db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order) VALUES (?, ?, ?)'),
  moveQueue:     db.prepare('UPDATE OR IGNORE print_queue SET model_id = ? WHERE model_id = ?'),
  hideModel:     db.prepare(`UPDATE models SET hidden = 1, folder_hash = NULL, folded_into = ?, updated_at = datetime('now') WHERE id = ?`),

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
    if ((ov === 'passthrough' || ov === 'category') && depth < MAX_PASSTHROUGH_DEPTH) {
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

/**
 * Effective folder roles (docs/folder-roles.md §2): `_Meta/folder_roles.csv` rows (meta.folderRoles)
 * merged over the app's marks; the file wins.
 * @returns {{ overrides: Map, roleInfo: Map, merged: Map }}
 */
function loadFolderRoles(meta) {
  const merged = folderRolesLib.mergeRoles((meta && meta.folderRoles) || [], folderRolesLib.loadAppRoles(db));
  return { merged, ...folderRolesLib.roleMaps(merged) };
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
    stmts.dropCollections.run(kid.id);
    stmts.moveQueue.run(parentId, kid.id);
    stmts.hideModel.run(parentId, kid.id);
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
const folderRolesLib = require('./lib/folder-roles');
const librariesLib = require('./lib/libraries');
const picturesLib = require('./lib/pictures');

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
const metaSummaryLib = require('./lib/meta-summary');
function loadLibraryMeta(log = () => {}) {
  return metaSummaryLib.loadLibraryMeta(process.env.LIBRARY_PATH || LIBRARY_PATH, log);
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

/**
 * Pictures for a work (lib/pictures.js steps a, f, p): hinted/render archives first (legacy order),
 * then loose images, then a peek inside the work's other archives. { images, source, tried }
 */
async function workPictures(w, modelUuid, hint, log) {
  const res = await picturesLib.findPictures({ files: w.files, uuid: modelUuid, hint, steps: 'afp', log });
  if (res.images.length && res.source === 'archive') log('img', `       → ${res.images.length} image(s)`);
  return res;
}
async function workImages(w, modelUuid, hint, log) {
  return (await workPictures(w, modelUuid, hint, log)).images;
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

/**
 * Pending AI field proposals made stale by this scan: the field now holds a value from model.json,
 * the genre folder or the creator's manifest that differs from what the proposal was made for.
 */
function supersedeStaleSuggestions(log, roles = null) {
  // folder-role proposals the folder's effective mark already answers (file or app)
  if (roles && roles.size) {
    try {
      const done = db.prepare(`SELECT id, path, proposed FROM suggestions WHERE status = 'pending' AND type = 'role'`).all()
        .filter(r => { const e = roles.get(r.path); return e && JSON.stringify(e.role) === r.proposed; });
      for (const r of done) db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`).run(r.id);
      if (done.length) log('info', `${done.length} folder role proposal(s) superseded: the folder is marked that way now`);
    } catch { /* no path column yet */ }
  }
  // proposals about a card this scan folded away (or that would fold into one) can't be acted on
  try {
    const r = db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE status = 'pending' AND (
      model_id IN (SELECT id FROM models WHERE folded_into IS NOT NULL) OR target_id IN (SELECT id FROM models WHERE folded_into IS NOT NULL))`).run();
    if (r.changes) log('info', `${r.changes} AI proposal(s) superseded: their card was regrouped`);
  } catch { /* no suggestions table yet */ }
  let pend;
  try { pend = db.prepare(`SELECT s.id, s.field, s.current, m.character, m.franchise, m.group_name, m.editions, m.attribution FROM suggestions s JOIN models m ON m.id = s.model_id WHERE s.status = 'pending' AND s.type = 'field' AND s.field IN ('character','franchise','group_name','editions')`).all(); } catch { return; }
  const stale = [];
  for (const p of pend) {
    const prov = (parseJSON(p.attribution, {}).fields || {})[p.field];
    if (!['sidecar', 'path', 'manifest', 'role'].includes(prov)) continue;
    const now = p.field === 'editions' ? JSON.stringify(parseJSON(p.editions, [])) : JSON.stringify(p[p.field] ?? null);
    const was = p.field === 'editions' ? JSON.stringify(parseJSON(p.current, [])) : JSON.stringify(parseJSON(p.current, null));
    if (now !== was) stale.push(p.id);
  }
  if (!stale.length) return;
  db.transaction(() => { for (const id of stale) db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`).run(id); })();
  log('info', `${stale.length} AI proposal(s) superseded: the scan found values of its own`);
}

/** Tags of the category marks above a card, unless the user removed that tag (attribution.removedTags). */
function addRoleTags(id, roleTags) {
  const row = db.prepare('SELECT tags, attribution FROM models WHERE id = ?').get(id);
  if (!row) return;
  const tags = parseJSON(row.tags, []);
  const removed = new Set((parseJSON(row.attribution, {}).removedTags || []).map(t => String(t).toLowerCase()));
  const have = new Set(tags.map(t => String(t).toLowerCase()));
  const add = roleTags.filter(t => !have.has(t.toLowerCase()) && !removed.has(t.toLowerCase()));
  if (add.length) db.prepare('UPDATE models SET tags = ? WHERE id = ?').run(JSON.stringify([...tags, ...add]), id);
}

/** Confirmed merges: Map(from work_key → { to_key, to_name }) for worksLib.planWorks. */
function loadAliases() {
  try {
    const m = new Map();
    for (const a of db.prepare('SELECT from_key, to_key, to_name FROM aliases').all()) m.set(a.from_key, { to_key: a.to_key, to_name: a.to_name });
    return m;
  } catch { return new Map(); } // scanner.test.js mocks the DB
}

/**
 * Values the scan must not overwrite (docs/ai-enrichment.md §2): fields the user set
 * (attribution.userFields) or accepted from the review list (provenance "ai-reviewed") keep the
 * row's value; values the AI filled automatically ("ai") stay until the scan finds a value of its
 * own (sidecar, path, manifest…). Mutates `attribution` (provenance, userFields, enrichment trail).
 * @returns {{ character, group_name, editions, franchise? }} franchise undefined → franchiseAndTeam decides
 */
const ENRICH_FIELDS = ['character', 'group_name', 'editions', 'franchise'];
function keptFields(w, base, prevAttr, attribution) {
  const scan = { character: w.character || null, group_name: w.group || null, editions: w.editions || [], franchise: undefined };
  if (!base) return scan;
  const fields = attribution.fields = { ...(attribution.fields || {}) };
  const user = new Set(Array.isArray(prevAttr.userFields) ? prevAttr.userFields : []);
  if (user.size) attribution.userFields = [...user];
  const prev = prevAttr.fields || {};
  const col = { character: base.character || null, group_name: base.group_name || null, editions: parseJSON(base.editions, []), franchise: base.franchise || null };
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  const out = { ...scan };
  for (const f of ENRICH_FIELDS) {
    const prov = user.has(f) ? 'user' : prev[f];
    const scanProv = (attribution.fields || {})[f];
    if (prov === 'ai-reviewed' && scanProv === 'sidecar') {
      // model.json is authoritative: it beats an accepted AI proposal (never the user's own value)
      if (f === 'franchise') out[f] = w.attr.genre || col[f];
    } else if (prov === 'user' || prov === 'ai-reviewed') {
      out[f] = col[f]; fields[f] = prov;
    } else if (prov === 'ai') {
      const scanVal = f === 'franchise' ? (w.attr.genre || null) : scan[f];
      if (empty(scanVal)) { out[f] = col[f]; fields[f] = 'ai'; } else if (f === 'franchise') out[f] = scanVal;
    }
  }
  return out;
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
    setPics: db.prepare(`UPDATE models SET images=?, thumbnail_path=?, thumb_source=?, thumb_attempt=?, updated_at=datetime('now') WHERE id=?`),
    setAttempt: db.prepare(`UPDATE models SET thumb_attempt=? WHERE id=?`),
    setThumbMeta: db.prepare(`UPDATE models SET thumb_source=?, thumb_attempt=? WHERE id=?`),
    setPath: db.prepare(`UPDATE models SET folder_path=? WHERE id=?`),
    delByPath: db.prepare('DELETE FROM model_files WHERE filepath = ?'),
    delModelScope: db.prepare('DELETE FROM model_files WHERE model_id = ? AND filepath > ? AND filepath < ?'),
    delModelAll: db.prepare('DELETE FROM model_files WHERE model_id = ?'),
    insFile: db.prepare(`
      INSERT OR REPLACE INTO model_files (model_id, filename, filepath, filetype, filesize, release_name, library, variant, edition, product, matched_by, printed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    fileStats: db.prepare(`SELECT COUNT(*) n, GROUP_CONCAT(DISTINCT library) libs FROM model_files WHERE model_id = ?`),
    fold: db.prepare(`UPDATE models SET hidden = 1, folder_hash = NULL, work_key = NULL, folded_into = ?, attribution = ?, creator_id = COALESCE(?, creator_id), updated_at = datetime('now') WHERE id = ?`),
    setHidden: db.prepare(`UPDATE models SET hidden = ?, updated_at = datetime('now') WHERE id = ?`),
    setAttr: db.prepare('UPDATE models SET attribution = ? WHERE id = ?'),
    setNotes: db.prepare('UPDATE models SET notes = ? WHERE id = ?'),
    full: db.prepare('SELECT * FROM models WHERE id = ?'),
    mergeUser: db.prepare(`UPDATE models SET tags=?, is_favorite=?, print_status=?, notes=?, images=?, thumbnail_path=?, name=?, name_locked=?, source_url=COALESCE(NULLIF(source_url,''), ?), updated_at=datetime('now') WHERE id=?`),
  };
  return L;
}

/**
 * Before the first layout scan of any scope regroups rows into works, write a snapshot.
 * Without one the scan does not start: regrouping folds rows and moves user data.
 */
function preRegroupSnapshot(log, { label = 'pre-regroup', setting = 'layout_regroup_done', why: what = 'regrouping the library into works' } = {}) {
  if (typeof db.getSetting !== 'function' || (setting && db.getSetting(setting))) return null;
  const n = db.prepare('SELECT COUNT(*) AS n FROM models').get().n;
  if (!n) return null;
  const backup = require('./lib/backup');
  let reason = '';
  const file = backup.snapshot(label, { db, log: { log: (m) => log('info', m), error: (m) => { reason = m; log('warn', m); } } });
  if (!file) {
    const why = String(reason).replace(/^\[backup\] snapshot "[^"]+" failed: /, '') || 'unknown error';
    throw new Error(`Could not write the backup taken before ${what} (${why}). ` +
      `Fix BACKUP_DIR (currently ${backup.backupDir ? backup.backupDir() : process.env.BACKUP_DIR || 'next to the database'}; it must exist or be creatable, and be writable) and scan again. Nothing was changed.`);
  }
  log('info', `Backup written before ${what}: ${path.basename(file)}`);
  if (setting && setting !== 'layout_regroup_done' && typeof db.setSetting === 'function') db.setSetting(setting, new Date().toISOString());
  return file;
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
    preRegroupSnapshot(log);
    const tm = Date.now();
    const { meta, libs } = loadLibraryMeta(log);
    const metaMs = Date.now() - tm;
    const { overrides, roleInfo, merged: roles } = loadFolderRoles(meta);
    const ignore = new Set([...overrides].filter(([, r]) => r === 'ignore').map(([p]) => p));
    const tw = Date.now();
    const tree = worksLib.walkTree(libraryPath, { ignore, scope });
    log('info', `Walked ${tree.fileCount} file(s) in ${Date.now() - tw} ms`);
    const rolesLine = folderRolesLib.summaryLine(roles, (p) => tree.dirs.has(p) || ignore.has(p));
    if (rolesLine) log('info', rolesLine);
    const plan = worksLib.planWorks({ libraryPath, tree, meta, overrides, roleInfo, log, scope, aliases: loadAliases() });
    worksLib.finalizeWorks(plan.works, { libraries: libs, libraryOf: librariesLib.libraryOf });
    for (const w of plan.works) {
      w.attr = worksLib.attributeWork(w, meta);
      if (w.attr.character) { w.name = w.attr.character; w.character = w.attr.character; }
      if (w.releaseId) {
        // one card per release: "Daredevil (2025)", "Daredevil (Netflix)"; the plain release keeps the name
        if (w.releaseLabel) w.name = `${w.character || w.name} (${w.releaseLabel})`;
        if (/^\d{4}-\d{2}$/.test(w.releaseId)) w.attr.release_term = w.releaseId; // the release IS that term
        else if (/^\d{4}$/.test(w.releaseId) && w.attr.release_term && !w.attr.release_term.startsWith(w.releaseId)) w.attr.release_term = null;
        if (!w.attr.release_label && w.releaseLabel) w.attr.release_label = w.releaseLabel;
      }
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
    const printedByNameSize = new Map(); // "<filename>|<size>" → printed_at, for files that moved or reappeared
    for (const r of db.prepare('SELECT model_id, filename, filesize, filepath, printed_at FROM model_files').all()) {
      ownedTotal.set(r.model_id, (ownedTotal.get(r.model_id) || 0) + 1);
      if (inScope(r.filepath)) existingFiles.set(r.filepath, r);
      if (r.printed_at) {
        const k = `${String(r.filename || '').toLowerCase()}|${r.filesize}`;
        if (!printedByNameSize.has(k) || printedByNameSize.get(k) < r.printed_at) printedByNameSize.set(k, r.printed_at);
      }
    }
    const rows = new Map(db.prepare('SELECT id, uuid, work_key, folder_path, folded_into, hidden, name, name_locked, folder_hash, images, thumbnail_path, render_zip_hint, creator_id, attribution, franchise, team, group_name, character, editions, source_url, thumb_source, thumb_attempt FROM models').all().map(r => [r.id, r]));
    const byKey = new Map();
    const byFolder = new Map();
    for (const r of rows.values()) {
      r.folded = r.folded_into != null || /#folded-\d+$/.test(r.folder_path || '') || !!parseJSON(r.attribution, {}).foldedInto;
      if (r.work_key && !r.folded && (!byKey.has(r.work_key) || byKey.get(r.work_key).hidden)) byKey.set(r.work_key, r);
      byFolder.set(r.folder_path, r);
    }
    const produced = new Set(plan.works.map(w => w.key));
    // a row from before this regroup: the folder scanner's, or a layout row whose work no longer exists
    const isLegacy = (r) => !r.folded && (!r.work_key || !produced.has(r.work_key));

    // Files a row held that this walk did not see (deleted, or now skipped: ".ArchiveServiceTemp…",
    // "*.crdownload", dotfiles) say nothing about where the row went.
    const walked = new Set();
    for (const w of plan.works) for (const f of w.files) walked.add(f.abs);
    const gone = new Map(); // row id → [filepath]
    for (const [fp, e] of existingFiles) if (!walked.has(fp)) { if (!gone.has(e.model_id)) gone.set(e.model_id, []); gone.get(e.model_id).push(fp); }
    const liveTotal = (id) => (ownedTotal.get(id) || 0) - ((gone.get(id) || []).length);
    for (const w of plan.works) {
      const owners = new Map();
      for (const f of w.files) { const e = existingFiles.get(f.abs); if (e) owners.set(e.model_id, (owners.get(e.model_id) || 0) + 1); }
      w.owners = owners;
      w.kids = [];    // rows folded into this work that carry their user data over
      w.spread = [];  // rows whose files spread over more than 2 works (user data → a "Was: …" collection)
    }

    // Rows without any files (the folder scanner left them when a parent claimed their files):
    // which works hold the files under their folder, or under its nearest ancestor below the creator.
    // Hidden ones too: a card the user hid keeps its tags/collections (and stays hidden when it is the work).
    const emptyFolders = new Map(); // real folder → rows
    for (const r of rows.values()) {
      if (!isLegacy(r) || liveTotal(r.id) > 0) continue;
      const rf = worksLib.realFolder(r.folder_path || '');
      if (rf && inScope(rf + path.sep)) { if (!emptyFolders.has(rf)) emptyFolders.set(rf, []); emptyFolders.get(rf).push(r); }
    }
    const counts = new Map(); // folder → Map(work → files under it)
    if (emptyFolders.size) {
      const wanted = new Set();
      for (const folder of emptyFolders.keys()) {
        for (let d = folder, i = 0; i < 4 && d.length > scopeRoot.length; i++, d = path.dirname(d)) wanted.add(d);
      }
      for (const w of plan.works) {
        for (const f of w.files) {
          for (let d = f.dir; d.length >= scopeRoot.length; d = path.dirname(d)) {
            if (wanted.has(d)) { const m = counts.get(d) || new Map(); m.set(w, (m.get(w) || 0) + 1); counts.set(d, m); }
            if (d === path.dirname(d)) break;
          }
        }
      }
    }
    const sumOf = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };

    // ── bases: the row each work updates ──
    // Same work_key first. Otherwise a legacy row only when they are the same thing: the work holds
    // >= 50% of the row's files (an empty row: of the files under its folder) AND the row held >= 50%
    // of the work's previously known files. Anything else is folded, so a parent row ("DC") never
    // becomes one of its parts.
    const claimed = new Map(); // row id → work
    for (const w of plan.works) {
      const base = byKey.get(w.key);
      if (base && !claimed.has(base.id)) { claimed.set(base.id, w); w.base = base; w.baseByKey = true; } else w.base = null;
    }
    // A card split into releases: the release holding most of the card's files keeps its row
    // (id, tags, status, collections); the others become new cards
    const splitGroups = new Map();
    for (const w of plan.works) if (w.splitFrom) { if (!splitGroups.has(w.splitFrom)) splitGroups.set(w.splitFrom, []); splitGroups.get(w.splitFrom).push(w); }
    let splitting = 0;
    for (const [from, list] of splitGroups) {
      const row = byKey.get(from);
      if (!row || claimed.has(row.id) || row.folded || list.some(w => w.base)) continue;
      // the row (and its tags, status, collections) goes to the release the user printed from,
      // else the one holding most of its files
      const printed = (w) => w.files.filter(f => { const e = existingFiles.get(f.abs); return e && e.model_id === row.id && e.printed_at; }).length;
      const best = list.map(w => [w, w.owners.get(row.id) || 0, printed(w)]).sort((a, b) => b[2] - a[2] || b[1] - a[1] || b[0].files.length - a[0].files.length)[0][0];
      claimed.set(row.id, best); best.base = row; best.baseByKey = true;
      for (const w of list) w.splitSource = row;
      splitting++;
    }
    if (splitting) {
      log('info', `Splitting ${splitting} card(s) into one card per release`);
      // every scan that splits existing cards takes one (not only the first)
      preRegroupSnapshot(log, { label: 'pre-split', setting: null, why: 'splitting cards into one per release' });
    }
    const candidates = [];
    for (const w of plan.works) {
      if (w.base) continue;
      // the work's files that some row held before (files added since then say nothing about identity)
      let known = 0;
      for (const n of w.owners.values()) known += n;
      const nw = known || w.files.length || 1;
      for (const [id, n] of w.owners) {
        const r = rows.get(id);
        if (!r || !isLegacy(r) || claimed.has(id)) continue;
        const total = liveTotal(id);
        if (total > 0 && n / total >= 0.5 && n / nw >= 0.5) candidates.push({ w, r, score: (n / total) * (n / nw), n });
      }
      for (const fp of new Set([worksLib.realFolder(w.folderPath)])) {
        for (const r of emptyFolders.get(fp) || []) {
          if (claimed.has(r.id)) continue;
          const m = counts.get(fp);
          const n = (m && m.get(w)) || 0;
          const total = m ? sumOf(m) : 0;
          if (n && n / total >= 0.5 && n / (w.files.length || 1) >= 0.5) candidates.push({ w, r, score: (n / total) * (n / nw) - 0.01, n });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.n - a.n || (a.r.folder_path === a.w.folderPath ? -1 : 0) - (b.r.folder_path === b.w.folderPath ? -1 : 0) || a.r.id - b.r.id);
    for (const c of candidates) {
      if (c.w.base || claimed.has(c.r.id)) continue;
      claimed.set(c.r.id, c.w); c.w.base = c.r; c.w.baseByKey = false;
    }

    // ── which rows fold, and into what ──
    // Rows left without files once the works take theirs: folder models whose files were re-grouped,
    // parents split into parts, and empty rows. A row whose files went to 1-2 works hands its user data
    // to the work that got most of them; one spread over more works keeps it in a "Was: <name>" collection.
    const moved = new Map();
    for (const w of plan.works) for (const [id, n] of w.owners) moved.set(id, (moved.get(id) || 0) + n);
    const foldable = new Map(); // row id → { r, receivers: [work…] (most files first), spread }
    for (const r of rows.values()) {
      if (claimed.has(r.id) || !isLegacy(r)) continue;
      const total = liveTotal(r.id);
      if (total <= 0 || moved.get(r.id) !== total) continue;
      const receivers = plan.works.filter(w => w.owners.get(r.id)).sort((a, b) => b.owners.get(r.id) - a.owners.get(r.id));
      foldable.set(r.id, { r, receivers, spread: receivers.length > 2, withFiles: true });
    }
    for (const [folder, list] of emptyFolders) {
      // its own folder, else (rows that never had files: left inside a skipped ".ArchiveServiceTemp…"
      // folder or under a parent that claimed them) the nearest ancestor below the creator
      const pick = (levels) => {
        for (let d = folder, i = 0; i < levels && d.length > scopeRoot.length; i++, d = path.dirname(d)) {
          const m = counts.get(d);
          if (m) return { best: [...m.entries()].sort((a, b) => b[1] - a[1])[0][0], near: i === 0 };
        }
        return null;
      };
      const own = pick(1), up = own || pick(4);
      for (const r of list) {
        if (claimed.has(r.id)) continue;
        // a row whose files are all gone only folds into what is in its own folder now
        const hit = (ownedTotal.get(r.id) || 0) > 0 ? own : up;
        if (hit) foldable.set(r.id, { r, receivers: [hit.best], spread: false, withFiles: false, near: hit.near });
        // else nothing left there: kept for /api/organize/integrity
      }
    }
    for (const fd of foldable.values()) {
      if (fd.spread) for (const w of fd.receivers) w.spread.push(fd);
      else fd.receivers[0].kids.push(fd);
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
        if (Array.isArray(prevAttr.foldedFrom) && prevAttr.foldedFrom.length) attribution.foldedFrom = prevAttr.foldedFrom;
        // tags the user removed stay removed (category tags, AI tags): the scan keeps the list
        if (Array.isArray(prevAttr.removedTags) && prevAttr.removedTags.length) attribution.removedTags = prevAttr.removedTags;
        const kept = keptFields(w, base, prevAttr, attribution);
        if (w.roleTags && w.roleTags.length) attribution.roleTags = w.roleTags;
        const attrSig = JSON.stringify([products, w.attr.attribution, w.attr.genre, w.attr.release_term, w.attr.release_label, w.group || null, w.editions || [], w.libraries, w.name,
          ...(w.roleTags && w.roleTags.length ? [w.roleTags] : [])]);
        attribution.sig = crypto.createHash('sha1').update(attrSig).digest('hex').slice(0, 12);
        const filesOwned = base && w.owners.size === 1 && w.owners.get(base.id) === w.files.length;
        const ft = franchiseAndTeam(w, base, prevAttr, meta);
        const sameLabels = base && (base.franchise || null) === ft.franchise && (base.team || null) === ft.team;
        if (base && base.work_key === w.key && base.folder_hash === w.hash && filesOwned && prevAttr.sig === attribution.sig && base.folder_path === w.folderPath && sameLabels) {
          w.rowId = base.id;
          // an unchanged card without a picture: steps a/f/p once per files signature + pipeline version
          const sig = picturesLib.filesSig(w.files);
          if (!parseJSON(base.images, []).length && base.thumb_source !== 'user' && !picturesLib.covered(base.thumb_attempt, sig, 'afp')) {
            let pics = null;
            try {
              const creatorRow = stmts.getCreator.get(w.creator);
              const res = await workPictures(w, base.uuid, base.render_zip_hint || (creatorRow && creatorRow.render_zip_hint) || null, log);
              pics = { attempt: picturesLib.nextAttempt(base.thumb_attempt, sig, 'afp'), ...(res.images.length ? picturesLib.mergeImages(base, rankImages(res.images), res.source) : {}) };
              if (res.images.length) { counters.pictured = (counters.pictured || 0) + 1; log('img', `    🖼 ${w.name}: ${res.images.length} picture(s) (${res.source})`); }
            } catch (e) { log('warn', `    images for ${w.name}: ${e.message}`); }
            prepared.push({ w, skip: true, pics });
            continue;
          }
          prepared.push({ w, skip: true });
          continue;
        }
        const uuid = base ? base.uuid : uuidv4();
        const creatorRow = stmts.getCreator.get(w.creator);
        const hint = (base && base.render_zip_hint) || (creatorRow && creatorRow.render_zip_hint) || null;
        // Renders already on disk are reused: the base's, then those of rows folded in for good
        // (their /images/<uuid>/ dirs stay; folded rows are never deleted). Archives are opened only
        // for a card without any, or when a work's files changed since the last layout scan.
        let images = base ? parseJSON(base.images, []) : [];
        let kidThumb = null;
        for (const k of w.kids) {
          if (k.r.hidden || !(k.withFiles || k.near)) continue; // renders only from rows that were this work
          for (const im of parseJSON(k.r.images, [])) if (!images.includes(im)) images.push(im);
          if (!kidThumb && k.r.thumbnail_path) kidThumb = k.r.thumbnail_path;
        }
        const sig = picturesLib.filesSig(w.files);
        const isRender = (base && base.thumb_source === 'stl') || false;
        const needImages = !images.length || (w.baseByKey && base.folder_hash !== w.hash) || (isRender && !picturesLib.covered(base.thumb_attempt, sig, 'afp'));
        let fresh = [], freshSource = null, attempt = base ? base.thumb_attempt || null : null;
        if (needImages) {
          try {
            const res = await workPictures(w, uuid, hint, log);
            fresh = res.images; freshSource = res.source;
            if (fresh.length) images = [...new Set([...fresh, ...images])];
            attempt = picturesLib.nextAttempt(attempt, sig, 'afp');
            counters.extracted = (counters.extracted || 0) + 1;
          } catch (e) { log('warn', `    images for ${w.name}: ${e.message}`); }
        }
        images = rankImages(images);
        let thumbnail = base && base.thumbnail_path && images.includes(base.thumbnail_path) ? base.thumbnail_path
          : (kidThumb && images.includes(kidThumb) ? kidThumb : (images[0] || null));
        let thumbSource = !images.length ? null
          : (base && thumbnail === base.thumbnail_path ? (base.thumb_source || null) : (fresh.includes(thumbnail) ? freshSource : null));
        if (isRender && fresh.length && freshSource !== 'stl' && base.thumb_source !== 'user') {
          // real pictures replace a mesh render; the render moves to the end
          const m = picturesLib.mergeImages(base, rankImages(fresh), freshSource);
          images = [...new Set([...m.images, ...images])];
          const renders = images.filter(i => i.endsWith(`/${picturesLib.PREVIEW_NAME}`));
          images = [...images.filter(i => !renders.includes(i)), ...renders];
          thumbnail = m.thumbnail_path; thumbSource = m.thumb_source;
        }
        if (!thumbSource && images.length && fresh.length && thumbnail === images[0] && fresh.includes(thumbnail)) thumbSource = freshSource;
        prepared.push({ w, uuid, images, thumbnail, thumbSource, attempt, products, attribution, prevAttr, ft, kept });
      }

      db.transaction(() => {
        for (const p of prepared) {
          const w = p.w;
          if (p.skip) {
            S.touch.run(w.base.id); counters.modelsSkipped++;
            if (p.pics && p.pics.images) S.setPics.run(JSON.stringify(p.pics.images), p.pics.thumbnail_path, p.pics.thumb_source, p.pics.attempt, w.base.id);
            else if (p.pics) S.setAttempt.run(p.pics.attempt, w.base.id);
            continue;
          }
          const real = worksLib.realFolder(w.folderPath);
          const creatorId = getOrCreateCreator(w.creator, plan.creatorFolders.get(w.creator) || w.creatorFolder || real);
          const a = analysisFromFiles(w.files);
          const sourceSite = detectSourceSite(real) || detectSourceSite(w.name) || (w.attr.source === 'gumroad' || w.attr.source === 'patreon' ? w.attr.source : null);
          const base = w.base;
          const { team } = p.ft; // franchise = genre; user edits win (see franchiseAndTeam)
          const franchise = p.kept.franchise !== undefined ? p.kept.franchise : p.ft.franchise;
          const prevAutoUrl = p.prevAttr.sourceUrl;
          const sourceUrl = !base || !base.source_url || (prevAutoUrl && base.source_url === prevAutoUrl) ? (w.attr.sourceUrl || (base ? base.source_url : null) || null) : base.source_url;
          const vals = [
            JSON.stringify(w.libraries || []), w.studio || null, p.kept.character, p.kept.group_name, JSON.stringify(p.kept.editions || []),
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
            if (w.splitSource) S.setNotes.run(`Split from ${w.splitSource.name} (release ${w.releaseLabel || w.releaseId})`, id);
          }
          w.rowId = id;
          S.setThumbMeta.run(p.thumbSource || null, p.attempt || null, id);
          if (w.roleTags && w.roleTags.length) addRoleTags(id, w.roleTags);
          // files: take them from their old owners, replace this row's files in scope
          S.delModelScope.run(id, lo, hi);
          for (const f of w.files) {
            const prev = existingFiles.get(f.abs);
            if (prev && prev.model_id !== id) S.delByPath.run(f.abs);
            const printed = prev ? prev.printed_at : (printedByNameSize.get(`${String(f.name).toLowerCase()}|${f.size}`) || null);
            S.insFile.run(id, f.name, f.abs, fileType(f.name), f.size, releaseNameFor(f, real, w.creator), f.library || null,
              f.variant || null, f.edition || null, f.product || null, f.matched_by || null, printed);
          }
          if (scope) {
            const st = S.fileStats.get(id);
            db.prepare('UPDATE models SET file_count = ?, libraries = ? WHERE id = ?').run(st.n, JSON.stringify(String(st.libs || '').split(',').filter(Boolean)), id);
          }
        }
      })();
      await new Promise(resolve => setImmediate(resolve));
    }

    // ── fold old rows into the works that hold their files now (never deleted) ──
    const addLine = (text, line) => (text && text.includes(line) ? text : (text ? `${text}\n${line}` : line));
    const moveMemberships = (to, from) => { stmts.moveCollections.run(to, from); stmts.dropCollections.run(from); };
    const foldedFromOf = new Map(); // work row id → [{ id, name, collection? }]
    const noteFoldedFrom = (rowId, entry) => { if (!foldedFromOf.has(rowId)) foldedFromOf.set(rowId, []); foldedFromOf.get(rowId).push(entry); };
    db.transaction(() => {
      for (const w of plan.works) {
        if (!w.rowId || !w.kids.length) continue;
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
        const hiddenNames = [];
        // hidden only when every row that held these files was hidden (rows without files don't count)
        const contributors = [];
        if (w.base) contributors.push(!!w.base.hidden);
        for (const k of w.kids) if (k.withFiles) contributors.push(!!k.r.hidden);
        const hide = contributors.length ? contributors.every(Boolean) : !!target.hidden;
        for (const k of w.kids) {
          const kid = S.full.get(k.r.id);
          for (const t of parseJSON(kid.tags, [])) if (!tags.includes(t)) tags.push(t);
          if (status === 'unprinted' && kid.print_status && kid.print_status !== 'unprinted') status = kid.print_status;
          if (kid.notes) notes = addLine(notes, kid.notes);
          if (kid.hidden) {
            // an empty hidden row without data of its own is a leftover of the folder scanner's variant merge
            const ownData = parseJSON(kid.tags, []).length || kid.notes || kid.is_favorite || (kid.print_status && kid.print_status !== 'unprinted') || stmts.countCollections.get(kid.id).n || stmts.countQueue.get(kid.id).n;
            if (k.withFiles || ownData) hiddenNames.push(kid.name);
          } else {
            if (kid.is_favorite) fav = 1;
            if (k.withFiles || k.near) {
              for (const im of parseJSON(kid.images, [])) if (!images.includes(im)) images.push(im);
              if (!thumb && kid.thumbnail_path) thumb = kid.thumbnail_path;
            }
            if (kid.name_locked) lockedNames.push(kid.name);
            if (!srcUrl && kid.source_url) srcUrl = kid.source_url;
          }
          moveMemberships(w.rowId, kid.id);
          stmts.moveQueue.run(w.rowId, kid.id);
          // folded rows keep their folder_path (renamed to "<path>#folded-<id>" only if a work needs it)
          S.fold.run(w.rowId, JSON.stringify({ ...parseJSON(kid.attribution, {}), foldedInto: w.rowId }), target.creator_id, kid.id);
          noteFoldedFrom(w.rowId, { id: kid.id, name: kid.name, ...(kid.hidden ? { hidden: true } : {}) });
          counters.folded++;
        }
        if (lockedNames.length === 1 && !locked) { name = lockedNames[0]; locked = 1; }
        else if (lockedNames.length > 1) notes = addLine(notes, `Previous custom names: ${lockedNames.join('; ')}`);
        if (!hide) for (const n of hiddenNames) notes = addLine(notes, `Hidden before regroup: ${n}`);
        S.mergeUser.run(JSON.stringify(tags), fav, status, notes || null, JSON.stringify(images), thumb || null, name, locked, srcUrl, w.rowId);
        if (hide !== !!target.hidden) S.setHidden.run(hide ? 1 : 0, w.rowId);
        log('info', `    ⇲ Folded ${w.kids.length} earlier model(s) into ${w.name}`);
      }

      // Parents spread over more than 2 works: their tags/favorite/status/notes go to a
      // "Was: <name>" collection holding every receiving work; nothing (images included) is
      // copied onto one arbitrary part.
      const spreadDone = new Set();
      for (const w of plan.works) {
        for (const fd of w.spread) {
          if (spreadDone.has(fd.r.id)) continue;
          spreadDone.add(fd.r.id);
          const receivers = fd.receivers.filter(x => x.rowId);
          if (!receivers.length) continue;
          const kid = S.full.get(fd.r.id);
          const tags = parseJSON(kid.tags, []);
          const status = kid.print_status && kid.print_status !== 'unprinted' ? kid.print_status : null;
          const memberships = stmts.countCollections.get(kid.id).n;
          const queued = stmts.countQueue.get(kid.id).n;
          const hasUserData = tags.length || kid.is_favorite || status || kid.notes || kid.name_locked || memberships || queued;
          let collectionId = null;
          if (hasUserData) {
            const desc = [
              `Was one card "${kid.name}" before the library was regrouped into works (now ${receivers.length} cards).`,
              tags.length ? `Tags: ${tags.join(', ')}` : null,
              kid.is_favorite ? 'Favorite: yes' : null,
              status ? `Status: ${status}` : null,
              kid.notes ? `Notes: ${kid.notes}` : null,
              kid.hidden ? 'It was hidden.' : null,
            ].filter(Boolean).join('\n');
            let cname = `Was: ${kid.name}`;
            if (stmts.collectionByName.get(cname)) cname = `Was: ${kid.name} (#${kid.id})`;
            const existing = stmts.collectionByName.get(cname);
            collectionId = existing ? existing.id : stmts.createCollection.run(cname, desc, kid.is_favorite ? 1 : 0).lastInsertRowid;
            receivers.forEach((x, i) => stmts.addToCollection.run(collectionId, x.rowId, i));
          }
          for (const x of receivers) stmts.moveCollections.run(x.rowId, kid.id);
          stmts.dropCollections.run(kid.id);
          stmts.moveQueue.run(receivers[0].rowId, kid.id);
          S.fold.run(receivers[0].rowId, JSON.stringify({ ...parseJSON(kid.attribution, {}), foldedInto: receivers[0].rowId, spreadTo: receivers.map(x => x.rowId), ...(collectionId ? { collection: collectionId } : {}) }), null, kid.id);
          for (const x of receivers) noteFoldedFrom(x.rowId, { id: kid.id, name: kid.name, spread: receivers.length, ...(collectionId ? { collection: collectionId } : {}) });
          counters.folded++;
          log('info', `    ⇲ ${kid.name} spread over ${receivers.length} cards${collectionId ? ` → collection "Was: ${kid.name}"` : ''}`);
        }
      }
      for (const [rowId, list] of foldedFromOf) {
        const cur = S.full.get(rowId);
        const attr = parseJSON(cur.attribution, {});
        const prev = Array.isArray(attr.foldedFrom) ? attr.foldedFrom : [];
        const seen = new Set(prev.map(e => e.id));
        attr.foldedFrom = [...prev, ...list.filter(e => !seen.has(e.id))];
        S.setAttr.run(JSON.stringify(attr), rowId);
      }
    })();

    const orphaned = db.prepare('DELETE FROM creators WHERE id NOT IN (SELECT DISTINCT creator_id FROM models WHERE creator_id IS NOT NULL)').run();
    if (orphaned.changes > 0) log('info', `Cleaned up ${orphaned.changes} orphaned creator(s)`);
    supersedeStaleSuggestions(log, roles);
    if (typeof db.setSetting === 'function') {
      db.setSetting('layout_regroup_done', db.getSetting('layout_regroup_done') || new Date().toISOString());
      if (!scope) {
        db.setSetting('meta_sidecars', plan.sidecars || 0); // model.json files seen by the last full scan (/api/meta/status)
        db.setSetting('meta_sidecar_errors', JSON.stringify((plan.sidecarErrors || []).slice(0, 200)));
      }
    }

    const { modelsFound, modelsAdded, modelsUpdated, modelsSkipped, folded } = counters;
    stmts.finishLog.run('complete', modelsFound, modelsAdded, modelsUpdated, modelsSkipped, logId);
    const scanMs = Date.now() - t0;
    log('info', `Skipped ${modelsSkipped} unchanged card(s)${folded ? `, folded ${folded} earlier model(s)` : ''} — ${Math.round(scanMs / 100) / 10}s (meta ${metaMs} ms)`);
    return { success: true, modelsFound, modelsAdded, modelsUpdated, modelsSkipped, folded, extracted: counters.extracted || 0, pictured: counters.pictured || 0, byKind, metaMs, scanMs, files: tree.fileCount,
      // plain _Meta summary for the server's /api/meta and /api/attribution routes (not sent to clients)
      metaSummary: (() => { try { return metaSummaryLib.summarize(meta); } catch { return null; } })() };
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
  layoutMode, rankImages, analysisFromFiles, realFolder: worksLib.realFolder, loadLibraryMeta, franchiseAndTeam, loadFolderRoles,
  // used by lib/pictures.js
  imageScoreOf: imageScore, isRenderArchive, copyImageFiles, workImages, workPictures,
  MAX_RENDER_ARCHIVES, MAX_ARCHIVE_IMAGES, MAX_LOOSE_IMAGES,
};
