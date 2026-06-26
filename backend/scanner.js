const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const IMAGE_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const STL_EXTS    = new Set(['.stl', '.obj', '.3mf']);
const SLICE_EXTS  = new Set(['.chitubox', '.ctb', '.photon', '.lys', '.lychee']);
const PLATE_EXTS  = new Set(['.gcode', '.gco', '.nc']);
const RENDER_KW   = ['render', 'preview', 'thumb', 'photo', 'pic', 'image', 'renders', 'previews', 'photos', 'presentation'];
const ARCHIVE_EXTS = new Set(['.zip', '.rar']);

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
  try {
    const zip = new AdmZip(zipPath);
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory && isRenderImage(entry.entryName)) {
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

function extractImagesFromRar(rarPath, modelUuid) {
  const extracted = [];
  try {
    const buf = Uint8Array.from(fs.readFileSync(rarPath)).buffer;
    const extractor = createExtractorFromData({ data: buf });
    const list = extractor.extract();
    const files = [...list.files];
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
    for (const file of files) {
      if (!file.fileHeader.flags.directory && isRenderImage(file.fileHeader.name)) {
        const safeName = path.basename(file.fileHeader.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(modelImgDir, safeName);
        if (!fs.existsSync(outPath) && file.extraction) {
          fs.writeFileSync(outPath, Buffer.from(file.extraction));
        }
        extracted.push(`/images/${modelUuid}/${safeName}`);
      }
    }
  } catch (e) {
    console.warn(`Could not extract rar ${rarPath}: ${e.message}`);
  }
  return extracted;
}

function extractImagesFromArchive(archivePath, modelUuid) {
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

/**
 * Recursively discover model folders under a root directory.
 * A "model folder" is one that directly contains printable files (STL, ZIP, etc).
 * A folder with only subdirectories is a "category" — we recurse deeper.
 * Returns array of { name, fullPath } entries.
 * @param {string} rootDir - The directory to search
 * @param {string} namePrefix - Breadcrumb prefix for display names (e.g. "Star Wars / Vehicles")
 * @param {number} maxDepth - Maximum recursion depth (default 5)
 */
function discoverModelFolders(rootDir, namePrefix, maxDepth) {
  if (maxDepth === undefined) maxDepth = 5;
  const results = [];

  function recurse(dir, prefix, depth) {
    if (depth <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter(e => !IGNORED_FOLDERS.has(e.name) && !isJunkFile(e.name));

    const subdirs = entries.filter(e => e.isDirectory());
    const files   = entries.filter(e => !e.isDirectory());
    const hasPrintableFiles = files.some(f => {
      const ext = path.extname(f.name).toLowerCase();
      return STL_EXTS.has(ext) || ARCHIVE_EXTS.has(ext) || SLICE_EXTS.has(ext) || PLATE_EXTS.has(ext);
    });

    if (hasPrintableFiles) {
      results.push({ name: prefix || path.basename(dir), fullPath: dir });
      // Also recurse into subdirectories — they may contain their own models
      // (e.g. a folder with ZIPs at one level AND sub-folders with more models)
      if (subdirs.length > 0) {
        for (const sub of subdirs) {
          const childPath = path.join(dir, sub.name);
          const childName = prefix ? `${prefix} / ${sub.name}` : sub.name;
          recurse(childPath, childName, depth - 1);
        }
      }
    } else if (subdirs.length > 0) {
      for (const sub of subdirs) {
        const childPath = path.join(dir, sub.name);
        const childName = prefix ? `${prefix} / ${sub.name}` : sub.name;
        recurse(childPath, childName, depth - 1);
      }
    }
  }

  recurse(rootDir, namePrefix || '', maxDepth);
  return results;
}

// ── Prepared statements (compiled once, reused thousands of times) ────────────

const stmts = {
  getCreator:    db.prepare('SELECT id, render_zip_hint FROM creators WHERE name = ?'),
  addCreator:    db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)'),

  getModel:      db.prepare('SELECT id, uuid, folder_hash, images, render_zip_hint, creator_id FROM models WHERE folder_path = ?'),
  insertModel:   db.prepare(`
    INSERT INTO models (uuid, name, creator_id, folder_path, source_site,
      file_count, has_stl, has_chitubox, has_lychee, has_plate,
      thumbnail_path, images, folder_hash, franchise, team, last_scanned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `),
  updateModel:   db.prepare(`
    UPDATE models SET
      name=?, creator_id=?, source_site=?,
      file_count=?, has_stl=?, has_chitubox=?, has_lychee=?, has_plate=?,
      thumbnail_path=?, images=?, folder_hash=?, franchise=?, team=?,
      last_scanned=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `),
  touchModel:    db.prepare(`UPDATE models SET last_scanned=datetime('now') WHERE id=?`),

  deleteFiles:   db.prepare('DELETE FROM model_files WHERE model_id = ?'),
  insertFile:    db.prepare(`
    INSERT OR IGNORE INTO model_files (model_id, filename, filepath, filetype, filesize, release_name)
    VALUES (?,?,?,?,?,?)
  `),

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

async function scanLibrary(libraryPath, progressCallback, logger) {
  const log = logger || (() => {});
  const logId = db.prepare('INSERT INTO scan_log (scan_path, status) VALUES (?, ?)').run(libraryPath, 'running').lastInsertRowid;

  let modelsFound = 0, modelsAdded = 0, modelsUpdated = 0, modelsSkipped = 0;

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
    let folderOverrides = new Map();
    try { folderOverrides = new Map(db.prepare('SELECT path, role FROM folder_overrides').all().map(r => [r.path, r.role])); } catch {}
    const creatorDirs = resolveCreatorDirs(libraryPath, 0, log, folderOverrides);
    log('info', `Found ${creatorDirs.length} creator folder(s)`);

    for (const creatorDir of creatorDirs) {
      // Yield before each creator so /api/scan/status, the SSE stream, and the
      // rest of the app stay responsive during long scans (esp. slow SMB mounts).
      await new Promise(resolve => setImmediate(resolve));

      const creatorPath = creatorDir.path;
      const creatorName = creatorDir.name;
      const creatorId = getOrCreateCreator(creatorName, creatorPath);
      const creatorRow = stmts.getCreator.get(creatorName);
      const creatorHint = creatorRow?.render_zip_hint || null;

      if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName });

      // Discover model folders recursively — handles archive-style creators
      // like "Wicked Archive/Star Wars/Vehicles/X-wing" by walking past
      // category-only folders until finding actual printable content.
      const discovered = discoverModelFolders(creatorPath, '', 5);
      const foldersToProcess = discovered.map(d => ({
        ...d, creatorId, creatorName
      }));

      log('creator', `▸ ${creatorName} (${foldersToProcess.length} model${foldersToProcess.length !== 1 ? 's' : ''})`);

      // Process models in small transaction batches (10 at a time) so the
      // event loop can deliver SSE progress updates between batches.
      const CHUNK_SIZE = 10;
      for (let ci = 0; ci < foldersToProcess.length; ci += CHUNK_SIZE) {
        const chunk = foldersToProcess.slice(ci, ci + CHUNK_SIZE);

        db.transaction(() => {
          for (const model of chunk) {
            modelsFound++;
            if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName, model: model.name, found: modelsFound });

            const existing = stmts.getModel.get(model.fullPath);
            const hash = folderHash(model.fullPath);

            // ── Skip if unchanged ─────────────────────────────────────────────
            if (existing && existing.folder_hash === hash) {
              stmts.touchModel.run(existing.id);
              // Fix creator attribution even on skip (e.g. "STL Archive" → actual creator)
              if (existing.creator_id !== model.creatorId) {
                db.prepare('UPDATE models SET creator_id=?, updated_at=datetime(\'now\') WHERE id=?').run(model.creatorId, existing.id);
                log('info', `  ↻ Re-attributed: ${model.name} → ${model.creatorName}`);
              }
              modelsSkipped++;
              log('skip', `  ⟳ Unchanged: ${model.name}`);
              continue;
            }

            // ── Analyze folder ────────────────────────────────────────────────
            const analysis = analyzeFolder(model.fullPath, creatorName);
            const sourceSite = detectSourceSite(model.fullPath) || detectSourceSite(model.name);
            const modelUuid = existing ? existing.uuid : uuidv4();

            // Extract franchise/team from path relative to creator folder
            // e.g. creator/Marvel/X-Men/Cable → franchise=Marvel, team=X-Men
            const relParts = path.relative(creatorPath, model.fullPath).split(path.sep).filter(Boolean);
            const pathFranchise = relParts.length >= 2 ? relParts[0] : null;
            const pathTeam      = relParts.length >= 3 ? relParts[1] : null;
            // Model-level hint overrides creator-level hint
            const hint = existing?.render_zip_hint || creatorHint || null;

            let allImages = existing ? JSON.parse(existing.images || '[]') : [];

            // Only re-extract images if folder changed
            const freshImages = [];
            const renderArchives = pickRenderArchives(analysis, hint);
            for (const archivePath of renderArchives) {
              log('zip', `    📦 ${path.basename(archivePath)}`);
              const imgs = extractImagesFromArchive(archivePath, modelUuid);
              freshImages.push(...imgs);
              if (imgs.length) log('img', `       → ${imgs.length} image(s)`);
            }
            if (freshImages.length === 0 && analysis.images.length > 0) {
              freshImages.push(...extractImagesFromFolder(model.fullPath, modelUuid));
            }
            // Merge: keep manually-added images, add newly found ones
            if (freshImages.length > 0) {
              allImages = [...new Set([...freshImages, ...allImages])];
            }

            const thumbnail = allImages[0] || null;

            if (existing) {
              stmts.updateModel.run(
                inferModelName(model.fullPath), creatorId, sourceSite,
                analysis.files.length, analysis.hasStl ? 1 : 0,
                analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
                thumbnail, JSON.stringify(allImages), hash, pathFranchise, pathTeam, existing.id
              );
              stmts.deleteFiles.run(existing.id);
              for (const f of analysis.files) stmts.insertFile.run(existing.id, f.filename, f.filepath, fileType(f.filename), f.size, f.release_name || null);
              const releaseList = [...analysis.releases];
              log('update', `    ↻ ${model.name} (${analysis.files.length} files${releaseList.length ? `, ${releaseList.length} release${releaseList.length>1?'s':''}` : ''})`);
              modelsUpdated++;
            } else {
              const ins = stmts.insertModel.run(
                modelUuid, inferModelName(model.fullPath), creatorId, model.fullPath, sourceSite,
                analysis.files.length, analysis.hasStl ? 1 : 0,
                analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
                thumbnail, JSON.stringify(allImages), hash, pathFranchise, pathTeam
              );
              for (const f of analysis.files) stmts.insertFile.run(ins.lastInsertRowid, f.filename, f.filepath, fileType(f.filename), f.size, f.release_name || null);
              const releaseList = [...analysis.releases];
              log('add', `    + ${model.name} (${analysis.files.length} files${releaseList.length ? `, ${releaseList.length} release${releaseList.length>1?'s':''}` : ''}${allImages.length ? `, ${allImages.length} img` : ''})`);
              modelsAdded++;
            }
          }
        })(); // end transaction chunk

        // Yield to event loop so SSE can deliver progress updates
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Clean up orphaned creators (no models left — e.g. "STL Archive" after re-attribution)
    const orphaned = db.prepare('DELETE FROM creators WHERE id NOT IN (SELECT DISTINCT creator_id FROM models WHERE creator_id IS NOT NULL)').run();
    if (orphaned.changes > 0) log('info', `Cleaned up ${orphaned.changes} orphaned creator(s)`);

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
 * Uses the same scan-state machinery (scanLog/scanSummary) as scanLibrary.
 * Called by POST /api/scan/creator/:id.
 */
async function scanSingleCreator(creatorPath, creatorId, creatorName, progressCallback, logger) {
  const log = logger || (() => {});
  const logId = db.prepare('INSERT INTO scan_log (scan_path, status) VALUES (?, ?)').run(creatorPath, 'running').lastInsertRowid;

  let modelsFound = 0, modelsAdded = 0, modelsUpdated = 0, modelsSkipped = 0;

  try {
    const creatorRow = stmts.getCreator.get(creatorName);
    const creatorHint = creatorRow?.render_zip_hint || null;

    if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName });

    const discovered = discoverModelFolders(creatorPath, '', 5);
    const foldersToProcess = discovered.map(d => ({ ...d, creatorId, creatorName }));

    log('creator', `▸ ${creatorName} (${foldersToProcess.length} model${foldersToProcess.length !== 1 ? 's' : ''})`);

    const CHUNK_SIZE = 10;
    for (let ci = 0; ci < foldersToProcess.length; ci += CHUNK_SIZE) {
      const chunk = foldersToProcess.slice(ci, ci + CHUNK_SIZE);

      db.transaction(() => {
        for (const model of chunk) {
          modelsFound++;
          if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName, model: model.name, found: modelsFound });

          const existing = stmts.getModel.get(model.fullPath);
          const hash = folderHash(model.fullPath);

          if (existing && existing.folder_hash === hash) {
            stmts.touchModel.run(existing.id);
            if (existing.creator_id !== creatorId) {
              db.prepare('UPDATE models SET creator_id=?, updated_at=datetime(\'now\') WHERE id=?').run(creatorId, existing.id);
              log('info', `  ↻ Re-attributed: ${model.name} → ${creatorName}`);
            }
            modelsSkipped++;
            log('skip', `  ⟳ Unchanged: ${model.name}`);
            return;
          }

          const analysis = analyzeFolder(model.fullPath, creatorName);
          const sourceSite = detectSourceSite(model.fullPath) || detectSourceSite(model.name);
          const modelUuid = existing ? existing.uuid : uuidv4();

          const relParts = path.relative(creatorPath, model.fullPath).split(path.sep).filter(Boolean);
          const pathFranchise = relParts.length >= 2 ? relParts[0] : null;
          const pathTeam      = relParts.length >= 3 ? relParts[1] : null;
          const hint = existing?.render_zip_hint || creatorHint || null;

          let allImages = existing ? JSON.parse(existing.images || '[]') : [];
          const freshImages = [];
          const renderArchives = pickRenderArchives(analysis, hint);
          for (const archivePath of renderArchives) {
            log('zip', `    📦 ${path.basename(archivePath)}`);
            const imgs = extractImagesFromArchive(archivePath, modelUuid);
            freshImages.push(...imgs);
            if (imgs.length) log('img', `       → ${imgs.length} image(s)`);
          }
          if (freshImages.length === 0 && analysis.images.length > 0) {
            freshImages.push(...extractImagesFromFolder(model.fullPath, modelUuid));
          }
          if (freshImages.length > 0) {
            allImages = [...new Set([...freshImages, ...allImages])];
          }
          const thumbnail = allImages[0] || null;

          if (existing) {
            stmts.updateModel.run(
              inferModelName(model.fullPath), creatorId, sourceSite,
              analysis.files.length, analysis.hasStl ? 1 : 0,
              analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
              thumbnail, JSON.stringify(allImages), hash, pathFranchise, pathTeam, existing.id
            );
            stmts.deleteFiles.run(existing.id);
            for (const f of analysis.files) stmts.insertFile.run(existing.id, f.filename, f.filepath, fileType(f.filename), f.size, f.release_name || null);
            log('update', `    ↻ ${model.name} (${analysis.files.length} files)`);
            modelsUpdated++;
          } else {
            const ins = stmts.insertModel.run(
              modelUuid, inferModelName(model.fullPath), creatorId, model.fullPath, sourceSite,
              analysis.files.length, analysis.hasStl ? 1 : 0,
              analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
              thumbnail, JSON.stringify(allImages), hash, pathFranchise, pathTeam
            );
            for (const f of analysis.files) stmts.insertFile.run(ins.lastInsertRowid, f.filename, f.filepath, fileType(f.filename), f.size, f.release_name || null);
            log('add', `    + ${model.name} (${analysis.files.length} files${allImages.length ? `, ${allImages.length} img` : ''})`);
            modelsAdded++;
          }
        }
      })();

      await new Promise(resolve => setImmediate(resolve));
    }

    stmts.finishLog.run('complete', modelsFound, modelsAdded, modelsUpdated, modelsSkipped, logId);
    log('info', `Skipped ${modelsSkipped} unchanged model(s)`);
    return { success: true, modelsFound, modelsAdded, modelsUpdated, modelsSkipped };

  } catch (err) {
    stmts.errorLog.run('error', err.message, logId);
    throw err;
  }
}

module.exports = { scanLibrary, scanSingleCreator, LIBRARY_PATH, matchesHint, pickRenderArchives, analyzeFolder, inferReleaseName, discoverModelFolders, extractImagesFromArchive };
