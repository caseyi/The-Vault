'use strict';
/**
 * lib/libraries.js — top-level folders of LIBRARY_PATH are libraries
 * (docs/library-metadata.md §1): /library/STL Archive (Dagobah), /library/3dPrint (Endor).
 *
 * LIBRARY_LABELS="STL Archive=Dagobah,3dPrint=Endor" gives them display names.
 * A top-level folder counts as a library when it is labelled, or when it looks
 * like a mount (only sub-folders, a mount/dump name such as "STL Archive",
 * "3dPrint", "Library", "Downloads"). When no folder qualifies (a plain
 * creator-per-folder library), the whole LIBRARY_PATH is one library.
 */
const fs = require('fs');
const path = require('path');

const MOUNT_NAME = /^(stl[\s_-]?archive(?:-\d+)?|3d[\s_-]?prints?|library|libraries|nas|share|volume\d*|downloads?|gumroad|backups?)$/i;

function libraryRoot() { return process.env.LIBRARY_PATH || '/library'; }

/** "STL Archive=Dagobah,3dPrint=Endor" → Map(folder → label) (plus vault.json libraryLabels). */
function parseLabels(str, extra) {
  const m = new Map();
  for (const part of String(str || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k && v) m.set(k, v);
  }
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (!m.has(k) && v) m.set(k, String(v));
  return m;
}

const SKIP_TOP = /^(?:[@#.]|_Meta$|_Inbox$|_Duplicates_Pending_Delete$)/;

/**
 * @returns {{ name: string, folder: string, path: string, writable: boolean }[]}
 *   name = label (Dagobah), folder = top-level folder name, path = absolute path
 */
function pickLibraries(root, entries, labels) {
  const libs = [];
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_TOP.test(e.name)) continue;
    const full = path.join(root, e.name);
    if (labels.has(e.name) || MOUNT_NAME.test(e.name.trim())) libs.push({ name: labels.get(e.name) || e.name, folder: e.name, path: full });
  }
  if (!libs.length) libs.push({ name: labels.get(path.basename(root)) || path.basename(root) || 'Library', folder: '', path: root });
  return libs.sort((a, b) => a.path.localeCompare(b.path));
}

function listLibraries(root = libraryRoot(), extraLabels) {
  const labels = parseLabels(process.env.LIBRARY_LABELS, extraLabels);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
  const libs = pickLibraries(root, entries, labels);
  for (const l of libs) {
    try { fs.accessSync(l.path, fs.constants.W_OK); l.writable = true; } catch { l.writable = false; }
  }
  return libs;
}

/**
 * listLibraries() without blocking the event loop (a stalled SMB/NFS mount must not hang
 * /api/health). Rejects after timeoutMs; the fs calls themselves keep running in libuv.
 * @returns {Promise<{ libraries, rootWritable }>}
 */
function listLibrariesAsync(root = libraryRoot(), extraLabels, { timeoutMs = 3000 } = {}) {
  const fsp = fs.promises;
  const writable = (p) => fsp.access(p, fs.constants.W_OK).then(() => true, () => false);
  const work = (async () => {
    const labels = parseLabels(process.env.LIBRARY_LABELS, extraLabels);
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { entries = []; }
    const libs = pickLibraries(root, entries, labels);
    const [rootWritable, ...flags] = await Promise.all([writable(root), ...libs.map(l => writable(l.path))]);
    libs.forEach((l, i) => { l.writable = flags[i]; });
    return { libraries: libs, rootWritable };
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`library folders did not answer within ${timeoutMs} ms`)), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Label of the library holding `p` (or null). */
function libraryOf(p, libs) {
  let best = null;
  for (const l of libs || []) {
    if (p === l.path || p.startsWith(l.path.endsWith(path.sep) ? l.path : l.path + path.sep)) {
      if (!best || l.path.length > best.path.length) best = l;
    }
  }
  return best ? best.name : null;
}

module.exports = { listLibraries, listLibrariesAsync, libraryOf, parseLabels, libraryRoot };
