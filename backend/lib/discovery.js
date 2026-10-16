'use strict';
/**
 * lib/discovery.js — folder-based model discovery (the "folder" layout mode).
 *
 * Moved out of scanner.js so the layout-aware scanner can run it over an
 * in-memory tree (one walk of the library instead of repeated readdir calls).
 * `makeDiscovery({ listDir, extended })` returns the same functions bound to a
 * directory lister; `extended` adds the scale/support variant folders of
 * docs/library-metadata.md §3 (32mm, 75mm, 1 9 Scale, Beefed, SLICER, …).
 * The default export (fs lister, not extended) is exactly the old behaviour.
 */
const fs = require('fs');
const path = require('path');

const STL_EXTS    = new Set(['.stl', '.obj', '.3mf']);
const SLICE_EXTS  = new Set(['.chitubox', '.ctb', '.photon', '.lys', '.lychee']);
const PLATE_EXTS  = new Set(['.gcode', '.gco', '.nc']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar']);

// Synology system / junk folders to skip during scanning
const IGNORED_FOLDERS = new Set([
  '@eaDir', '@tmp', '@appstore', '@autoupdate', '@database', '@S2S',
  '#recycle', '#snapshot',
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd',
  '__MACOSX', 'Thumbs.db', '.synology_cache',
  '$RECYCLE.BIN', 'System Volume Information',
]);

function isJunkFile(filename) {
  return filename.includes('@SynoEAStream') ||
         filename.includes('@SynoResource') ||
         filename.startsWith('._') ||
         filename === '.DS_Store' ||
         filename === 'Thumbs.db';
}

// Sub-folder names that are a VARIANT or ROLE of the model around them, not a
// separate model: "Mandalorian Bust/FDM/*.stl" + "/Resin/*.stl" + "/Renders/*.png"
// is ONE model with three sub-folders.
const STRONG_VARIANT_DIR = /^(?:(?:pre|un)?[- _]?supported|supports?|no[- _]?supports?|fdm|resin|sla|msla|dlp|lychee|chitubox|hollow(?:ed)?|solid)(?:[- _](?:files?|version|stls?|parts))?$/i;
const GENERIC_CONTAINER_DIR = /^(?:stls?|files|parts|3mf|obj|stl[- _]files|print[- _]files)$/i;
const MEDIA_DIR = /^(?:renders?|images?|pics?|photos?|previews?|pictures?|gallery)$/i;
const VARIANT_DIR = new RegExp(`${STRONG_VARIANT_DIR.source}|${GENERIC_CONTAINER_DIR.source}|${MEDIA_DIR.source}`, 'i');

// Extended (layout mode): scale and support folders of release packs.
const EXT_TOKENS = new Set([
  'supported', 'unsupported', 'presupported', 'pre', 'un', 'no', 'non', 'support', 'supports', 'fdm', 'resin',
  'sla', 'msla', 'dlp', 'lychee', 'lichee', 'chitubox', 'hollow', 'hollowed', 'solid', 'beefed', 'slicer', 'sliced', 'thick',
  'thin', 'files', 'file', 'version', 'stl', 'stls', 'parts', 'one', 'piece', 'pieces', 'full', 'ready', 'to', 'slice',
  'ctb', 'lys', 'obj', '3mf', 'scale', 'freescale', 'free', 'mm', 'and', 'with', 'without', 'heroic',
]);
const EXT_STRONG = new Set([
  'supported', 'unsupported', 'presupported', 'support', 'supports', 'fdm', 'resin', 'sla', 'msla', 'dlp', 'lychee', 'lichee',
  'chitubox', 'hollow', 'hollowed', 'solid', 'beefed', 'slicer', 'sliced', 'piece', 'pieces', 'scale', 'freescale',
]);
/** "32mm", "75mm", "1 9 Scale", "Freescale", "Supported", "No Supports", "Pre-Supported (thick)", "Beefed", "SLICER", "100" */
function isExtVariantName(name) {
  const toks = String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    .replace(/[()[\]]/g, ' ').replace(/(\d)\s+mm\b/g, '$1mm')
    .split(/[\s_\-.]+/).filter(Boolean);
  if (!toks.length) return false;
  let strong = false;
  for (const t of toks) {
    if (/^\d+(?:,\d+)?mm$/.test(t)) { strong = true; continue; }
    if (/^\d{1,3}%?$/.test(t)) continue;
    if (/^(?:un|no|non|pre)?s[uo]p+o?r?t+(?:ed|s)?$/.test(t) || /^(?:un|no|non|pre)?s[uo]p+r?o?t+ed$/.test(t)) { strong = true; continue; } // "Sopprted", "Suported"
    if (!EXT_TOKENS.has(t)) return false;
    if (EXT_STRONG.has(t)) strong = true;
  }
  if (!strong && toks.length === 1 && /^\d{2,3}%?$/.test(toks[0]) && parseInt(toks[0], 10) >= 25) strong = true;
  return strong;
}

function isPrintableName(name) {
  const ext = path.extname(name).toLowerCase();
  return STL_EXTS.has(ext) || ARCHIVE_EXTS.has(ext) || SLICE_EXTS.has(ext) || PLATE_EXTS.has(ext);
}

function fsListDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !IGNORED_FOLDERS.has(e.name) && !isJunkFile(e.name));
  } catch { return []; }
}

function makeDiscovery({ listDir = fsListDir, extended = false } = {}) {
  const isStrong = (n) => STRONG_VARIANT_DIR.test(n) || (extended && isExtVariantName(n));
  const isVariant = (n) => VARIANT_DIR.test(n) || (extended && isExtVariantName(n));

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
      if (isVariant(n) && depth > 0 && (isFlatVariant(full, depth - 1) || !containsPrintable(full, 3))) continue;
      if (containsPrintable(full, 3)) return false; // holds an independent model folder
    }
    return true;
  }

  /** A generic "Files"/"STLs" folder that actually holds 3+ separate model folders. */
  function looksLikeModelContainer(dir) {
    const kids = listDir(dir).filter(e => e.isDirectory() && !isVariant(e.name.trim()));
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
      if (isVariant(name)) hasVariantName = true;
      needsCheck.push({ sub, name, full });
    }
    if (!hasVariantName) return { merge: false, absorbed: [] }; // plain category folder — cheap exit
    for (const { sub, name, full } of needsCheck) {
      if (MEDIA_DIR.test(name)) { absorbed.push(sub.name); continue; }
      if (isStrong(name) || GENERIC_CONTAINER_DIR.test(name)) {
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
   * `opts.boundary(dir)` (layout mode) stops at a folder and reports it instead
   * (release folders are handled by their own pass).
   * Returns array of { name, fullPath, variantDirs } entries.
   */
  function discoverModelFolders(rootDir, namePrefix, maxDepth, overrides, opts = {}) {
    if (maxDepth === undefined) maxDepth = 5;
    const ov = overrides instanceof Map ? overrides : new Map();
    const results = [];
    const boundary = typeof opts.boundary === 'function' ? opts.boundary : null;

    function recurse(dir, prefix, depth) {
      if (depth <= 0) return;
      if (ov.get(dir) === 'ignore') return;
      const entries = listDir(dir);
      let subdirs = entries.filter(e => e.isDirectory() && ov.get(path.join(dir, e.name)) !== 'ignore');
      if (boundary) subdirs = subdirs.filter(e => !boundary(path.join(dir, e.name), e.name));
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
          const isV = !ov.has(full) && (MEDIA_DIR.test(n) ||
            (isStrong(n) && isFlatVariant(full)) ||
            (GENERIC_CONTAINER_DIR.test(n) && isFlatVariant(full) && !looksLikeModelContainer(full)));
          if (isV) variantDirs.push(sub.name); else descend.push(sub);
        }
        results.push({ name, fullPath: dir, variantDirs });
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

  return { discoverModelFolders, classifyVariantContainer, isFlatVariant, looksLikeModelContainer, containsPrintable, isVariant, isStrong };
}

const legacy = makeDiscovery();

module.exports = {
  makeDiscovery, discoverModelFolders: legacy.discoverModelFolders, isExtVariantName,
  STRONG_VARIANT_DIR, GENERIC_CONTAINER_DIR, MEDIA_DIR, VARIANT_DIR, IGNORED_FOLDERS, isJunkFile, isPrintableName,
  fsListDir, STL_EXTS, SLICE_EXTS, PLATE_EXTS, ARCHIVE_EXTS,
};
