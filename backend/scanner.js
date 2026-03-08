const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const STL_EXTS = new Set(['.stl', '.obj', '.3mf']);
const SLICE_EXTS = new Set(['.chitubox', '.ctb', '.photon', '.lys', '.lychee']);
const PLATE_EXTS = new Set(['.gcode', '.gco', '.nc']);
const RENDER_KEYWORDS = ['render', 'preview', 'thumb', 'photo', 'pic', 'image', 'renders', 'previews', 'photos'];

function isRenderZip(filename) {
  const lower = filename.toLowerCase();
  return RENDER_KEYWORDS.some(k => lower.includes(k));
}

function isRenderImage(filename) {
  const lower = path.basename(filename).toLowerCase();
  return IMAGE_EXTS.has(path.extname(lower));
}

function detectSourceSite(folderPath) {
  const lower = folderPath.toLowerCase();
  if (lower.includes('printables')) return 'printables';
  if (lower.includes('thingiverse')) return 'thingiverse';
  if (lower.includes('myminifactory') || lower.includes('mmf')) return 'myminifactory';
  if (lower.includes('patreon')) return 'patreon';
  if (lower.includes('cults')) return 'cults3d';
  if (lower.includes('gumroad')) return 'gumroad';
  return null;
}

function extractImagesFromZip(zipPath, modelUuid) {
  const extractedPaths = [];
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });

    for (const entry of entries) {
      if (!entry.isDirectory && isRenderImage(entry.entryName)) {
        const safeName = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(modelImgDir, safeName);
        if (!fs.existsSync(outPath)) {
          zip.extractEntryTo(entry, modelImgDir, false, true, false, safeName);
        }
        extractedPaths.push(`/images/${modelUuid}/${safeName}`);
      }
    }
  } catch (e) {
    console.warn(`Could not extract zip ${zipPath}: ${e.message}`);
  }
  return extractedPaths;
}

function extractImagesFromFolder(folderPath, modelUuid) {
  const extractedPaths = [];
  try {
    const modelImgDir = path.join(IMAGES_DIR, modelUuid);
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      if (isRenderImage(file)) {
        const src = path.join(folderPath, file);
        if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });
        const safeName = file.replace(/[^a-zA-Z0-9._-]/g, '_');
        const dest = path.join(modelImgDir, safeName);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        extractedPaths.push(`/images/${modelUuid}/${safeName}`);
      }
    }
  } catch (e) {
    console.warn(`Could not scan folder images ${folderPath}: ${e.message}`);
  }
  return extractedPaths;
}

function analyzeFolder(folderPath) {
  const result = {
    files: [],
    hasStl: false,
    hasChitubox: false,
    hasLychee: false,
    hasPlate: false,
    images: [],
    renderZips: []
  };

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const size = (() => { try { return fs.statSync(fullPath).size; } catch { return 0; } })();
        result.files.push({ filename: entry.name, filepath: fullPath, ext, size });

        if (STL_EXTS.has(ext)) result.hasStl = true;
        if (ext === '.chitubox' || ext === '.ctb' || ext === '.photon') result.hasChitubox = true;
        if (ext === '.lys' || ext === '.lychee') result.hasLychee = true;
        if (PLATE_EXTS.has(ext)) result.hasPlate = true;
        if (IMAGE_EXTS.has(ext)) result.images.push(fullPath);
        if (ext === '.zip' && isRenderZip(entry.name)) result.renderZips.push(fullPath);
      }
    }
  }

  walk(folderPath);
  return result;
}

function getOrCreateCreator(creatorName, folderPath) {
  const existing = db.prepare('SELECT id FROM creators WHERE name = ?').get(creatorName);
  if (existing) return existing.id;
  const result = db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)').run(creatorName, folderPath);
  return result.lastInsertRowid;
}

function inferModelName(folderPath) {
  return path.basename(folderPath)
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scanLibrary(libraryPath, progressCallback) {
  const logEntry = db.prepare(
    'INSERT INTO scan_log (scan_path, status) VALUES (?, ?)'
  ).run(libraryPath, 'running');
  const logId = logEntry.lastInsertRowid;

  let modelsFound = 0, modelsAdded = 0, modelsUpdated = 0;

  try {
    const creatorDirs = fs.readdirSync(libraryPath, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const creatorDir of creatorDirs) {
      const creatorPath = path.join(libraryPath, creatorDir.name);
      const creatorName = creatorDir.name;
      const creatorId = getOrCreateCreator(creatorName, creatorPath);

      // Each subfolder under creator = one model
      const modelDirs = fs.readdirSync(creatorPath, { withFileTypes: true })
        .filter(d => d.isDirectory());

      // If creator folder itself has STL/zip files, treat the whole folder as a model too
      const creatorFiles = fs.readdirSync(creatorPath, { withFileTypes: true })
        .filter(d => !d.isDirectory());
      const hasDirectFiles = creatorFiles.some(f => {
        const ext = path.extname(f.name).toLowerCase();
        return STL_EXTS.has(ext) || ext === '.zip';
      });

      const foldersToProcess = [...modelDirs.map(d => ({
        name: d.name,
        fullPath: path.join(creatorPath, d.name),
        creatorId,
        creatorName
      }))];

      if (hasDirectFiles && modelDirs.length === 0) {
        foldersToProcess.push({ name: creatorName, fullPath: creatorPath, creatorId, creatorName });
      }

      for (const model of foldersToProcess) {
        modelsFound++;
        if (progressCallback) progressCallback({ stage: 'scanning', creator: creatorName, model: model.name, found: modelsFound });

        const analysis = analyzeFolder(model.fullPath);
        const sourceSite = detectSourceSite(model.fullPath) || detectSourceSite(model.name);

        // Check if model already exists
        const existing = db.prepare('SELECT id, uuid FROM models WHERE folder_path = ?').get(model.fullPath);

        let modelUuid = existing ? existing.uuid : uuidv4();
        let allImages = [];

        // Extract images from render zips
        for (const zipPath of analysis.renderZips) {
          const imgs = extractImagesFromZip(zipPath, modelUuid);
          allImages = allImages.concat(imgs);
        }
        // Copy loose images from folder
        if (allImages.length === 0 && analysis.images.length > 0) {
          const imgs = extractImagesFromFolder(model.fullPath, modelUuid);
          allImages = allImages.concat(imgs);
        }

        const thumbnail = allImages.length > 0 ? allImages[0] : null;
        const fileType = (filename) => {
          const ext = path.extname(filename).toLowerCase();
          if (STL_EXTS.has(ext)) return 'stl';
          if (ext === '.zip') return 'zip';
          if (SLICE_EXTS.has(ext)) return 'slicer';
          if (PLATE_EXTS.has(ext)) return 'plate';
          if (IMAGE_EXTS.has(ext)) return 'image';
          return 'other';
        };

        if (existing) {
          db.prepare(`
            UPDATE models SET
              name = ?, creator_id = ?, source_site = ?,
              file_count = ?, has_stl = ?, has_chitubox = ?, has_lychee = ?, has_plate = ?,
              thumbnail_path = ?, images = ?, last_scanned = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `).run(
            inferModelName(model.fullPath), creatorId, sourceSite,
            analysis.files.length, analysis.hasStl ? 1 : 0,
            analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
            thumbnail, JSON.stringify(allImages), existing.id
          );
          // Refresh files
          db.prepare('DELETE FROM model_files WHERE model_id = ?').run(existing.id);
          const insertFile = db.prepare('INSERT INTO model_files (model_id, filename, filepath, filetype, filesize) VALUES (?,?,?,?,?)');
          for (const f of analysis.files) {
            insertFile.run(existing.id, f.filename, f.filepath, fileType(f.filename), f.size);
          }
          modelsUpdated++;
        } else {
          const ins = db.prepare(`
            INSERT INTO models (uuid, name, creator_id, folder_path, source_site,
              file_count, has_stl, has_chitubox, has_lychee, has_plate,
              thumbnail_path, images, last_scanned)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
          `).run(
            modelUuid, inferModelName(model.fullPath), creatorId, model.fullPath, sourceSite,
            analysis.files.length, analysis.hasStl ? 1 : 0,
            analysis.hasChitubox ? 1 : 0, analysis.hasLychee ? 1 : 0, analysis.hasPlate ? 1 : 0,
            thumbnail, JSON.stringify(allImages)
          );
          const insertFile = db.prepare('INSERT INTO model_files (model_id, filename, filepath, filetype, filesize) VALUES (?,?,?,?,?)');
          for (const f of analysis.files) {
            insertFile.run(ins.lastInsertRowid, f.filename, f.filepath, fileType(f.filename), f.size);
          }
          modelsAdded++;
        }
      }
    }

    db.prepare('UPDATE scan_log SET status=?, models_found=?, models_added=?, models_updated=?, finished_at=datetime(\'now\') WHERE id=?')
      .run('complete', modelsFound, modelsAdded, modelsUpdated, logId);

    return { success: true, modelsFound, modelsAdded, modelsUpdated };
  } catch (err) {
    db.prepare('UPDATE scan_log SET status=?, error=?, finished_at=datetime(\'now\') WHERE id=?')
      .run('error', err.message, logId);
    throw err;
  }
}

module.exports = { scanLibrary, LIBRARY_PATH };
