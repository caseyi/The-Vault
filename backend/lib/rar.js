'use strict';
/**
 * lib/rar.js: RAR listing and extraction straight from disk (node-unrar-js createExtractorFromFile
 * reads through its own fs layer), so a multi-GB .rar is never loaded into memory and ARCHIVE_MAX_MB
 * no longer applies. Only the chosen entries are written, each capped at maxBytes (uncompressed),
 * first into a private folder under IMAGES_DIR/.tmp, then moved to their sanitised names.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const imagesDir = () => process.env.IMAGES_DIR || '/data/images';
const norm = (n) => String(n).replace(/\\/g, '/');
const safeName = (n) => path.basename(norm(n)).replace(/[^a-zA-Z0-9._-]/g, '_');

/** A private temp folder under IMAGES_DIR/.tmp (same filesystem as the images: renames are cheap). */
function tempDir(prefix = 'x') {
  const d = path.join(imagesDir(), '.tmp', `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function extractor(file, targetPath, transform) {
  const { createExtractorFromFile } = require('node-unrar-js');
  return createExtractorFromFile({ filepath: file, targetPath: targetPath || imagesDir(), filenameTransform: transform || ((n) => safeName(n)) });
}

/** [{ name, size }] of the files in a RAR (headers only). */
async function listRar(file) {
  const ex = await extractor(file);
  const { fileHeaders } = ex.getFileList();
  return [...fileHeaders].filter(h => !h.flags.directory).map(h => ({ name: norm(h.name), size: h.unpSize }));
}

/**
 * Extract the named entries (each at most maxBytes) into destDir as sanitised basenames.
 * Existing files are kept. Returns the saved basenames.
 * @param {string} file
 * @param {string} destDir
 * @param {string[]|((name:string)=>boolean)} want entry names, or a filter
 * @param {{ maxBytes?: number, rename?: (name:string)=>string }} [opts]
 */
async function extractRar(file, destDir, want, { maxBytes = Infinity, rename = safeName } = {}) {
  const pick = typeof want === 'function' ? want : ((s) => (n) => s.has(n))(new Set(want.map(norm)));
  const tmp = tempDir('rar');
  const tmpNames = new Map(); // entry → name inside tmp (unique)
  let i = 0;
  try {
    // unrar hands the transform an already-cleaned name ("../../a.jpg" → "a.jpg"), so the entry
    // being written is remembered from the filter that just accepted it
    let current = null;
    const ex = await extractor(file, tmp, (n) => {
      const t = `${i++}_${safeName(n)}`;
      tmpNames.set(current != null ? current : norm(n), t);
      return t;
    });
    const res = ex.extract({ files: (h) => {
      const ok = !h.flags.directory && h.unpSize <= maxBytes && pick(norm(h.name));
      if (ok) current = norm(h.name);
      return ok;
    } });
    const saved = [];
    for (const f of res.files) { // the iterator does the work
      const n = norm(f.fileHeader.name);
      const t = tmpNames.get(n);
      const out = rename(n);
      if (!t || !out || out === '.' || out === '..') continue;
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, out);
      if (!fs.existsSync(dest)) fs.renameSync(path.join(tmp, t), dest);
      saved.push(out);
    }
    return saved;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { listRar, extractRar, tempDir, safeName };
