'use strict';
/**
 * lib/paths.js — confine user-supplied filesystem paths to the library.
 *
 * Every endpoint that accepts (or reads from the DB) a filesystem path must run
 * it through confinePath() before touching the disk. The check is done on the
 * REAL path (symlinks resolved), so a symlink inside the library that points
 * outside it is rejected too. For a path that does not exist yet (e.g. a folder
 * we are about to create) the deepest existing ancestor is resolved instead.
 */
const fs = require('fs');
const path = require('path');

class PathError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'PathError';
    this.status = status;
  }
}

function libraryPath() {
  return process.env.LIBRARY_PATH || '/library';
}
function imagesDir() {
  return process.env.IMAGES_DIR || '/data/images';
}

/** realpath that tolerates a non-existent tail (resolves the nearest existing ancestor). */
function realpathLoose(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const tail = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    tail.unshift(path.basename(cur));
    if (parent === cur) return abs; // hit the filesystem root without finding anything
    cur = parent;
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
  }
}

/** true when `child` is `root` or lives underneath it (both absolute, already resolved). */
function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The allowed roots, realpath-resolved. `images: true` adds IMAGES_DIR. */
function allowedRoots({ images = false } = {}) {
  const roots = [libraryPath()];
  if (images) roots.push(imagesDir());
  return roots.map(r => {
    try { return realpathLoose(r); } catch { return path.resolve(r); }
  });
}

/**
 * Validate `p` and make sure it resolves inside an allowed root.
 * Returns the normalized absolute path (NOT the realpath, so it still matches
 * the folder_path values stored in the DB). Throws PathError(400|403).
 *
 * @param {string} p
 * @param {{images?: boolean, onlyImages?: boolean}} [opts]
 */
function confinePath(p, opts = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new PathError('A path is required', 400);
  if (p.includes('\0')) throw new PathError('Invalid path', 400);
  const abs = path.resolve(p);
  let real;
  try { real = realpathLoose(abs); } catch (e) { throw new PathError(`Cannot resolve path: ${e.code || e.message}`, 400); }
  const roots = opts.onlyImages
    ? [realpathLoose(imagesDir())]
    : allowedRoots({ images: !!opts.images });
  if (!roots.some(r => isInside(real, r))) {
    throw new PathError('Path is outside the library', 403);
  }
  return abs;
}

/** Non-throwing variant: returns the confined path or null. */
function tryConfine(p, opts) {
  try { return confinePath(p, opts); } catch { return null; }
}

/** Express helper: send the PathError as JSON. Returns true if it handled it. */
function sendPathError(res, err) {
  if (err instanceof PathError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * A single, safe path segment (a file or folder NAME, never a path):
 * no separators, no "..", no NUL / control characters, not empty.
 */
function isSafeSegment(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  if (!s || s === '.' || s === '..') return false;
  if (s.includes('..')) return false;
  if (/[\/\\]/.test(s)) return false;
  if (/[\x00-\x1f\x7f]/.test(s)) return false;
  return true;
}

/** The public URL form for an image under IMAGES_DIR must stay under /images/. */
function isSafeImageUrl(u) {
  if (typeof u !== 'string') return false;
  if (!u.startsWith('/images/')) return false;
  if (u.includes('\0') || u.includes('\\')) return false;
  const norm = path.posix.normalize(u);
  return norm === u && norm.startsWith('/images/') && !norm.split('/').includes('..');
}

/** Map an /images/<uuid>/<file> URL to its file on disk (confined to IMAGES_DIR) or null. */
function imageUrlToFile(u) {
  if (!isSafeImageUrl(u)) return null;
  const file = path.join(imagesDir(), u.slice('/images/'.length));
  return tryConfine(file, { onlyImages: true });
}

module.exports = {
  PathError, confinePath, tryConfine, sendPathError, isInside, realpathLoose,
  isSafeSegment, isSafeImageUrl, imageUrlToFile, libraryPath, imagesDir,
};
