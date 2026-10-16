'use strict';
/**
 * lib/zip.js — streaming zip access with yauzl (docs/library-metadata.md §9).
 *
 * adm-zip loads the whole archive into memory, so multi-GB Wicked zips never
 * got thumbnails. yauzl reads only the central directory, then inflates just
 * the entries we ask for.
 *
 * Size limit: ZIP_MAX_MB when set (0 = no limit); otherwise ARCHIVE_MAX_MB only
 * when it is set explicitly (the old knob still works); otherwise no limit
 * (streaming only reads the central directory and the chosen images).
 */
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_IMAGE_ENTRY_BYTES = 50 * 1024 * 1024; // default cap for one image entry (zip bombs)
/** IMAGE_MAX_MB (default 50) caps one extracted image, from a folder or from an archive. */
function imageMaxBytes() {
  const mb = parseFloat(process.env.IMAGE_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : MAX_IMAGE_ENTRY_BYTES;
}

function zipMaxBytes() {
  const z = parseFloat(process.env.ZIP_MAX_MB);
  if (Number.isFinite(z)) return z > 0 ? z * 1024 * 1024 : Infinity;
  const a = parseFloat(process.env.ARCHIVE_MAX_MB);
  if (Number.isFinite(a) && a > 0) return a * 1024 * 1024;
  return Infinity;
}
function zipTooBig(p) {
  try { return fs.statSync(p).size > zipMaxBytes(); } catch { return true; }
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    // decodeStrings:false — yauzl would reject the whole archive on one "../x.png" entry;
    // we decode names ourselves and only ever use their basename.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zf) => (err ? reject(err) : resolve(zf)));
  });
}

/** Read the central directory: [{ name, size, compressedSize, isDirectory }] (entry objects kept internally). */
async function readEntries(zf) {
  return new Promise((resolve, reject) => {
    const out = [];
    zf.on('entry', (e) => {
      let name;
      try { name = yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, e.fileNameRaw, yauzl.parseExtraFields(e.extraFieldRaw), false); }
      catch { name = Buffer.from(e.fileNameRaw).toString('utf8'); }
      name = String(name).replace(/\\/g, '/');
      out.push({ name, size: e.uncompressedSize, compressedSize: e.compressedSize, isDirectory: /\/$/.test(name), _entry: e });
      zf.readEntry();
    });
    zf.on('end', () => resolve(out));
    zf.on('error', reject);
    zf.readEntry();
  });
}

/** List a zip's entries without inflating anything. */
async function listZip(file) {
  const zf = await openZip(file);
  try {
    const entries = await readEntries(zf);
    return entries.map(({ _entry, ...e }) => e);
  } finally { try { zf.close(); } catch {} }
}

function writeEntry(zf, entry, dest) {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const tmp = `${dest}.part-${process.pid}`;
      const ws = fs.createWriteStream(tmp);
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; try { ws.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} reject(e); };
      rs.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', () => { if (failed) return; try { fs.renameSync(tmp, dest); resolve(); } catch (e) { fail(e); } });
      rs.pipe(ws);
    });
  });
}

const safeName = (entryName) => path.basename(String(entryName).replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_');

/**
 * Extract image entries into destDir (flattened, sanitised names, never outside destDir).
 * @param {string} file
 * @param {string} destDir
 * @param {{ select?: string[], limit?: number, rank?: (names:string[])=>string[] }} [opts]
 *   select — only these entry names; limit — at most N images (best first when rank is given)
 * @returns {Promise<string[]>} saved file names (basenames inside destDir)
 */
async function extractZipImages(file, destDir, opts = {}) {
  const zf = await openZip(file);
  try {
    let images = (await readEntries(zf)).filter(e => !e.isDirectory && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()) && e.size <= imageMaxBytes());
    if (Array.isArray(opts.select) && opts.select.length) {
      const want = new Set(opts.select);
      images = images.filter(e => want.has(e.name));
    }
    if (opts.rank) {
      const order = opts.rank(images.map(e => e.name));
      const pos = new Map(order.map((n, i) => [n, i]));
      images.sort((a, b) => (pos.get(a.name) ?? 1e9) - (pos.get(b.name) ?? 1e9));
    }
    if (opts.limit > 0) images = images.slice(0, opts.limit);
    if (!images.length) return [];
    fs.mkdirSync(destDir, { recursive: true });
    const saved = [];
    for (const e of images) {
      const name = safeName(e.name);
      if (!name || name === '.' || name === '..') continue;
      const dest = path.join(destDir, name);
      try {
        if (!fs.existsSync(dest)) await writeEntry(zf, e._entry, dest);
        saved.push(name);
      } catch (err) {
        // one corrupt entry must not cost the rest of the archive
        if (typeof opts.onError === 'function') opts.onError(e.name, err);
      }
    }
    return saved;
  } finally { try { zf.close(); } catch {} }
}

module.exports = { listZip, extractZipImages, zipTooBig, zipMaxBytes, imageMaxBytes, safeName, IMAGE_EXTS, MAX_IMAGE_ENTRY_BYTES };
