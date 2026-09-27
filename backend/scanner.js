const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const db = require('./db');
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

// Synology system / junk folders to skip during scanning
const IGNORED_FOLDERS = new Set([
  '@eaDir', '@tmp', '@appstore', '@autoupdate', '@database', '@S2S',
  '#recycle', '#snapshot',
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd',
  '__MACOSX', 'Thumbs.db', '.synology_cache',
  '$RECYCLE.BIN', 'System Volume Information',
]);

// Synology extended-attribute stream files and other junk file patterns to skip
function isJunkFile(filename) {
  return filename.includes('@SynoEAStream') ||
         filename.includes('@SynoResource') ||
         filename.startsWith('._') ||
         filename === '.DS_Store' ||
         filename === 'Thumbs.db';
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

function extractImagesFromZip(zipPath, modelUuid) {
  const extracted = [];
  if (archiveTooBig(zipPath)) return extracted;
  try {
    const zip = new AdmZip(zipPath);
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory && isRenderImage(entry.entryName)) {
        if (entry.header && entry.header.size > MAX_IMAGE_ENTRY_BYTES) continue;
        const safeName = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(modelImgDir, safeName);
        if (!fs.existsSync(outPath)) zip.extractEntryTo(entry, modelImgDir, false, true, false, safeName);
        extracted.push(`/images/${modelUuid}/${safeName}`);
      }
    }
  } catch (e) {
    console.warn(`Could not extract zip ${zipPath}: ${e.message}`);
  }
  return extracted;
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
async function extractImagesFromArchive(archivePath, modelUuid) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.rar') return extractImagesFromRar(archivePath, modelUuid);
  return extractImagesFromZip(archivePath, modelUuid);
}

function extractImagesFromFolder(folderPath, modelUuid) {
  const extracted = [];
  try {
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    for (const file of fs.readdirSync(folderPath)) {
      if (isJunkFile(file)) continue;
      if (isRenderImage(file)) {
        const src = path.join(folderPath, file);
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

// ── Model-folder discovery ────────────────────────────────────────────────────

// Sub-folder names that are a VARIANT or ROLE of the model around them, not a
// separate model: "Mandalorian Bust/FDM/*.stl" + "/Resin/*.stl" + "/Renders/*.png"
// is ONE model with three sub-folders.
const STRONG_VARIANT_DIR = /^(?:(?:pre|un)?[- _]?supported|supports?|no[- _]?supports?|fdm|resin|sla|msla|dlp|lychee|chitubox|hollow(?:ed)?|solid)(?:[- _](?:files?|version|stls?|parts))?$/i;
const GENERIC_CONTAINER_DIR = /^(?:stls?|files|parts|3mf|obj|stl[- _]files|print[- _]files)$/i;
const MEDIA_DIR = /^(?:renders?|images?|pics?|photos?|previews?|pictures?|gallery)$/i;
const VARIANT_DIR = new RegExp(`${STRONG_VARIANT_DIR.source}|${GENERIC_CONTAINER_DIR.source}|${MEDIA_DIR.source}`, 'i');

function isPrintableName(name) {
  const ext = path.extname(name).toLowerCase();
  return STL_EXTS.has(ext) || ARCHIVE_EXTS.has(ext) || SLICE_EXTS.has(ext) || PLATE_EXTS.has(ext);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !IGNORED_FOLDERS.has(e.name) && !isJunkFile(e.name));
  } catch { return []; }
}

/** Does `dir` contain printable files within `depth` levels? */
function containsPrintable(dir, depth) {
  const entries = listDir(dir);
  if (entries.some(e => !e.isDirectory() && isPrintableName(e.name))) return true;
  if (depth <= 0) return false;
  return entries.some(e => e.isDirectory() && containsPrintable(path.join(dir, e.name), depth - 1));
}

/**
 * A variant folder is "flat" when it holds the model's printables itself
 * (Supported/*.stl), or only nested variant/media folders that do
 * (Supported/STL/*.stl). A variant-named folder that instead holds OTHER
 * sub-folders with printables (e.g. a Patreon release laid out as
 * "Pre-Supported/<Model A>/", "Pre-Supported/<Model B>/") is a container of
 * separate models and must never be merged into one card.
 */
function isFlatVariant(dir, depth = 2) {
  const entries = listDir(dir);
  const subdirs = entries.filter(e => e.isDirectory());
  for (const sub of subdirs) {
    const full = path.join(dir, sub.name);
    const n = sub.name.trim();
    if (MEDIA_DIR.test(n)) continue;
    if (VARIANT_DIR.test(n) && depth > 0 && (isFlatVariant(full, depth - 1) || !containsPrintable(full, 3))) continue;
    if (containsPrintable(full, 3)) return false; // holds an independent model folder
  }
  return true;
}

/** A generic "Files"/"STLs" folder that actually holds 3+ separate model folders. */
function looksLikeModelContainer(dir) {
  const kids = listDir(dir).filter(e => e.isDirectory() && !VARIANT_DIR.test(e.name.trim()));
  let withPrintables = 0;
  for (const k of kids) {
    if (listDir(path.join(dir, k.name)).some(e => !e.isDirectory() && isPrintableName(e.name))) withPrintables++;
    if (withPrintables >= 3) return true;
  }
  return false;
}

/**
 * Classify the sub-folders of a folder that has NO printable files of its own.
 * Returns { merge: boolean, absorbed: string[] } — merge=true means the folder
 * is ONE model whose sub-folders are variants/roles (FDM/Resin/Supported/Renders…).
 * Any folder-role override on a sub-folder marks it as independent (blocks the
 * merge), except 'ignore' which just drops it.
 */
function classifyVariantContainer(dir, subdirs, overrides) {
  const absorbed = [];
  let variantWithPrintables = false;
  const needsCheck = [];
  let hasVariantName = false;
  for (const sub of subdirs) {
    const name = sub.name.trim();
    const full = path.join(dir, sub.name);
    if (overrides.has(full)) return { merge: false, absorbed: [] };
    if (VARIANT_DIR.test(name)) hasVariantName = true;
    needsCheck.push({ sub, name, full });
  }
  if (!hasVariantName) return { merge: false, absorbed: [] }; // plain category folder — cheap exit
  for (const { sub, name, full } of needsCheck) {
    if (MEDIA_DIR.test(name)) { absorbed.push(sub.name); continue; }
    if (STRONG_VARIANT_DIR.test(name) || GENERIC_CONTAINER_DIR.test(name)) {
      // A variant-named folder full of separate model folders is a container,
      // not a variant: keep the old per-folder behaviour (recurse).
      if (!isFlatVariant(full)) return { merge: false, absorbed: [] };
      if (GENERIC_CONTAINER_DIR.test(name) && looksLikeModelContainer(full)) return { merge: false, absorbed: [] };
      absorbed.push(sub.name);
      if (containsPrintable(full, 3)) variantWithPrintables = true;
      continue;
    }
    // Any other name: an independent model if it holds printables; otherwise
    // (instructions, paint guides…) it's just part of this model.
    if (containsPrintable(full, 3)) return { merge: false, absorbed: [] };
    absorbed.push(sub.name);
  }
  return { merge: variantWithPrintables, absorbed: variantWithPrintables ? absorbed : [] };
}

/**
 * Recursively discover model folders under a root directory.
 *  - A folder that directly contains printable files (STL, ZIP, …) is a model.
 *    Its variant/role sub-folders (FDM, Resin, Supported, Renders…) belong to it;
 *    other sub-folders are searched for further models.
 *  - A folder with NO printable files of its own whose sub-folders are all
 *    variants/roles (at least one holding printables) is ONE model too.
 *  - Any other folder with only subdirectories is a "category" — we recurse deeper.
 * Folder-role overrides (folder_overrides table) take precedence: 'ignore' skips
 * a folder, and any override on a folder or sub-folder disables the variant merge.
 * Returns array of { name, fullPath, variantDirs } entries.
 * @param {string} rootDir - The directory to search
 * @param {string} namePrefix - Breadcrumb prefix for display names (e.g. "Star Wars / Vehicles")
 * @param {number} maxDepth - Maximum recursion depth (default 5)
 * @param {Map<string,string>} [overrides] - folder_overrides path → role
 */
function discoverModelFolders(rootDir, namePrefix, maxDepth, overrides) {
  if (maxDepth === undefined) maxDepth = 5;
  const ov = overrides instanceof Map ? overrides : new Map();
  const results = [];

  function recurse(dir, prefix, depth) {
    if (depth <= 0) return;
    if (ov.get(dir) === 'ignore') return;
    const entries = listDir(dir);
    const subdirs = entries.filter(e => e.isDirectory() && ov.get(path.join(dir, e.name)) !== 'ignore');
    const files   = entries.filter(e => !e.isDirectory());
    const hasPrintableFiles = files.some(f => isPrintableName(f.name));
    const name = prefix || path.basename(dir);
    const childName = (sub) => (prefix ? `${prefix} / ${sub.name}` : sub.name);

    if (hasPrintableFiles) {
      const variantDirs = [];
      const descend = [];
      for (const sub of subdirs) {
        const full = path.join(dir, sub.name);
        const n = sub.name.trim();
        const isVariant = !ov.has(full) && (MEDIA_DIR.test(n) ||
          (STRONG_VARIANT_DIR.test(n) && isFlatVariant(full)) ||
          (GENERIC_CONTAINER_DIR.test(n) && isFlatVariant(full) && !looksLikeModelContainer(full)));
        if (isVariant) variantDirs.push(sub.name); else descend.push(sub);
      }
      results.push({ name, fullPath: dir, variantDirs });
      // Other sub-folders may contain their own models (e.g. a folder with ZIPs
      // at one level AND sub-folders with more models)
      for (const sub of descend) recurse(path.join(dir, sub.name), childName(sub), depth - 1);
      return;
    }

    if (subdirs.length === 0) return;

    // (Not at the root: the root is the creator folder, not a model.)
    if (depth < maxDepth && !ov.has(dir)) {
      const { merge, absorbed } = classifyVariantContainer(dir, subdirs, ov);
      if (merge) {
        results.push({ name, fullPath: dir, variantDirs: absorbed });
        return;
      }
    }
    for (const sub of subdirs) recurse(path.join(dir, sub.name), childName(sub), depth - 1);
  }

  recurse(rootDir, namePrefix || '', maxDepth);
  return results;
}

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

async function scanLibrary(libraryPath, progressCallback, logger) {
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
async function scanSingleCreator(creatorPath, creatorId, creatorName, progressCallback, logger) {
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

module.exports = {
  scanLibrary, scanSingleCreator, LIBRARY_PATH, matchesHint, pickRenderArchives, analyzeFolder,
  inferReleaseName, discoverModelFolders, extractImagesFromArchive, VARIANT_DIR, isImageFile: isRenderImage,
};
