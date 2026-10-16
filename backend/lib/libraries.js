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
function listLibraries(root = libraryRoot(), extraLabels) {
  const labels = parseLabels(process.env.LIBRARY_LABELS, extraLabels);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !SKIP_TOP.test(e.name)); } catch { entries = []; }
  const libs = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (labels.has(e.name) || MOUNT_NAME.test(e.name.trim())) libs.push({ name: labels.get(e.name) || e.name, folder: e.name, path: full });
  }
  if (!libs.length) libs.push({ name: labels.get(path.basename(root)) || path.basename(root) || 'Library', folder: '', path: root });
  libs.sort((a, b) => a.path.localeCompare(b.path));
  for (const l of libs) {
    try { fs.accessSync(l.path, fs.constants.W_OK); l.writable = true; } catch { l.writable = false; }
  }
  return libs;
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

module.exports = { listLibraries, libraryOf, parseLabels, libraryRoot };
