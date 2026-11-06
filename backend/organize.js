/**
 * organize.js — Library organisation routes for The Vault
 *
 * Routes mounted at /api/organize:
 *   GET  /health              – duplicates across creators, empties, missing info, file hygiene
 *   POST /dedupe/resolve      – fold duplicate cards into one (an accepted merge: alias + Unmerge)
 *   POST /gap-analysis        – compare a list of names (Gumroad CSV) against the library
 *   GET  /integrity           – cards whose folders are gone
 *   GET  /loose-files, POST /group-files – unpack loose files into folders (script when read-only)
 *   GET  /fs-tree, /franchises – folder tree for Folder Roles, genre list
 *
 * Genre, name and tag edits, merges and folder-role proposals live in Enrich and the Review tab
 * (lib/enrich.js, lib/review-rules.js); the older Annotate / Franchise / bulk tools were removed.
 */

'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const db       = require('./db');
const { realFolder } = require('./scanner');
const librariesLib = require('./lib/libraries');
const folderRolesLib = require('./lib/folder-roles');
const { confinePath, sendPathError, isSafeSegment } = require('./lib/paths');
const { shellQuote, toHostPath } = require('./lib/shell');
const { isVariantOnlyName } = require('./lib/similar');
const { wrapAsyncRoutes } = require('./lib/middleware');

const router = wrapAsyncRoutes(express.Router());

const LIBRARY_PATH  = process.env.LIBRARY_PATH || '/library';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Simple Levenshtein distance for fuzzy matching */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalise a model name for fuzzy comparison */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deep-normalise a model name for cross-creator duplicate detection.
 * Strips noise (timestamps, scale prefixes, common modifiers) but keeps
 * meaningful variant words (bust, statue, diorama) so "Spider-Man Bust"
 * and "Spider-Man Statue" are NOT collapsed together.
 */
function deepNorm(s) {
  let n = String(s || '').toLowerCase();
  // Google Drive batch-download timestamps: -20250109T000437Z-003
  n = n.replace(/-\d{8}t\d{6}z(-\d+)?/gi, '');
  // Scale prefixes: "1_12 scale", "1:12", "1/12 scale"
  n = n.replace(/\b\d+[\:_\/x]\d+\s*scale\b/gi, '');
  // Common noise-only modifiers (not bust/statue/diorama — those are meaningful)
  n = n.replace(/\b(nsfw|presupported|pre[-\s]?support(?:s|ed)?|unsupported|fdm|remix|fan[-\s]?art|fanart|painted|uncut)\b/gi, '');
  // Creator slug suffixes: CA3D, MMF, TGA, etc.
  n = n.replace(/\b([A-Z]{2,4}\d*)\b/g, '');
  // Collapse non-alphanumeric to single space
  n = n.replace(/[^a-z0-9]+/g, ' ').trim();
  return n;
}

/** Similarity ratio 0-1 (higher = more similar) */
function similarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - levenshtein(na, nb) / maxLen : 1;
}

/** Confine a request path or answer 400/403. Returns the path, or null if a response was sent. */
function confinedOr4xx(res, p) {
  try { return confinePath(p); } catch (e) { if (sendPathError(res, e)) return null; throw e; }
}

// ── snapshot ──────────────────────────────────────────────────────────────────

// ── auto-annotate (SSE) ───────────────────────────────────────────────────────

// ── annotate preview / apply ──────────────────────────────────────────────────

// ── health scan ───────────────────────────────────────────────────────────────

/**
 * GET /api/organize/health
 *
 * Returns:
 *   duplicates     – models with very similar names (similarity ≥ 0.85)
 *   emptyFolders   – models with file_count = 0
 *   noThumbnail    – models missing thumbnail_path
 *   noSource       – models missing source_url
 *   noTags         – models with empty tags array
 *   noFranchise    – models with no franchise assigned
 */
router.get('/health', async (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.folder_path, m.file_count, m.thumbnail_path,
           m.source_url, m.tags, m.franchise, m.creator_id, c.name AS creator_name
    FROM models m
    LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0) AND COALESCE(m.kind, 'model') != 'tool'
    ORDER BY m.name
  `).all();

  const emptyFolders  = models.filter(m => !m.file_count || m.file_count === 0);
  const noThumbnail   = models.filter(m => !m.thumbnail_path);
  const noSource      = models.filter(m => !m.source_url);
  const noTags        = models.filter(m => { try { return !JSON.parse(m.tags || '[]').length; } catch { return true; } });
  const noFranchise   = models.filter(m => !m.franchise);

  // Cross-creator duplicates: same deep-normalized name, different creators
  const byDeepKey = new Map();
  for (const m of models) {
    // Names that are only variant/role words ("Supported", "FDM", "Renders")
    // say nothing about WHICH model it is — never group those across creators.
    if (isVariantOnlyName(m.name)) continue;
    const key = deepNorm(m.name);
    if (!key || key.length < 4 || isVariantOnlyName(key)) continue; // skip too-short keys
    if (!byDeepKey.has(key)) byDeepKey.set(key, []);
    byDeepKey.get(key).push(m);
  }
  const crossCreatorDupes = [];
  for (const [key, group] of byDeepKey) {
    const creatorIds = new Set(group.map(m => m.creator_id).filter(Boolean));
    if (creatorIds.size > 1) {
      crossCreatorDupes.push({ key, models: group });
    }
  }
  crossCreatorDupes.sort((a, b) => b.models.length - a.models.length);

  // File level: the same name + byte size in two libraries (Dagobah / Endor) is a
  // backup copy, never a duplicate; inside ONE library it is a duplicate.
  const libs = librariesLib.listLibraries();
  const fileRows = db.prepare(`
    SELECT f.filename, f.filesize, f.filepath, f.library, f.model_id, m.name AS model_name
    FROM model_files f JOIN models m ON m.id = f.model_id
    WHERE (m.hidden IS NULL OR m.hidden = 0) AND f.filesize >= 102400
  `).all();
  const bySig = new Map();
  for (const f of fileRows) {
    const k = `${f.filename.toLowerCase()}|${f.filesize}`;
    if (!bySig.has(k)) bySig.set(k, []);
    bySig.get(k).push(f);
  }
  const fileDuplicates = [];
  let backupCopies = 0;
  for (const list of bySig.values()) {
    if (list.length < 2) continue;
    const perLib = new Map();
    for (const f of list) {
      const lib = f.library || librariesLib.libraryOf(f.filepath, libs) || '';
      if (!perLib.has(lib)) perLib.set(lib, []);
      perLib.get(lib).push(f);
    }
    if (perLib.size > 1) backupCopies++;
    for (const [lib, same] of perLib) {
      if (same.length > 1) fileDuplicates.push({ library: lib || null, filename: same[0].filename, filesize: same[0].filesize, copies: same.map(f => ({ filepath: f.filepath, model_id: f.model_id, model_name: f.model_name })) });
    }
  }
  fileDuplicates.sort((a, b) => b.filesize * b.copies.length - a.filesize * a.copies.length);
  // Synology Drive conflict copies ("…_Conflict") are indexed but flagged
  const conflictFolders = models.filter(m => /_Conflict(?:\b|$)/i.test(realFolder(m.folder_path) || ''));

  res.json({
    summary: {
      total: models.length,
      emptyFolders: emptyFolders.length,
      noThumbnail: noThumbnail.length,
      noSource: noSource.length,
      noTags: noTags.length,
      noFranchise: noFranchise.length,
      crossCreatorDupes: crossCreatorDupes.length,
      fileDuplicates: fileDuplicates.length,
      backupCopies,
      conflictFolders: conflictFolders.length,
    },
    crossCreatorDupes,
    emptyFolders,
    noThumbnail,
    noSource,
    noTags,
    noFranchise,
    fileDuplicates: fileDuplicates.slice(0, 500),
    backupCopies,
    conflictFolders,
  });
});

// ── gap analysis ──────────────────────────────────────────────────────────────

/**
 * POST /api/organize/gap-analysis
 * Body: { csv: string, threshold?: number }
 *
 * Accepts a Gumroad CSV (text/string — the full file contents) or a plain list
 * of model names (one per line, or comma-separated values with a "Model Name"
 * column header).
 *
 * Fuzzy-matches each name against models.name in the DB.
 * Returns: { missing[], present[], stats }
 */
router.post('/gap-analysis', (req, res) => {
  const { csv = '', threshold = 0.75 } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv body required' });

  // Parse names from CSV
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  let names = [];

  if (lines[0] && lines[0].toLowerCase().includes(',')) {
    // Proper CSV — find "Model Name" or "Name" column
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
    const nameIdx = headers.indexOf('model name') !== -1 ? headers.indexOf('model name')
      : headers.indexOf('name') !== -1 ? headers.indexOf('name') : 0;
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      const val = (cols[nameIdx] || '').replace(/"/g, '').trim();
      if (val) names.push(val);
    }
  } else {
    // Plain list
    names = lines;
  }

  const dbModels = db.prepare(`SELECT id, name FROM models WHERE (hidden IS NULL OR hidden = 0)`).all();

  const results = { missing: [], present: [], stats: { checked: names.length, missing: 0, present: 0 } };

  for (const name of names) {
    let bestScore = 0, bestMatch = null;
    for (const m of dbModels) {
      const score = similarity(name, m.name);
      if (score > bestScore) { bestScore = score; bestMatch = m; }
    }
    if (bestScore >= threshold) {
      results.present.push({ searched: name, matched: bestMatch?.name, score: Math.round(bestScore * 100) / 100, id: bestMatch?.id });
      results.stats.present++;
    } else {
      results.missing.push({ searched: name, closestMatch: bestMatch?.name, score: Math.round(bestScore * 100) / 100 });
      results.stats.missing++;
    }
  }

  results.missing.sort((a, b) => a.searched.localeCompare(b.searched));
  results.present.sort((a, b) => a.searched.localeCompare(b.searched));

  res.json(results);
});

// ── list franchises ───────────────────────────────────────────────────────────

/**
 * GET /api/organize/franchises
 * Returns all distinct franchise values with model counts.
 */
router.get('/franchises', (req, res) => {
  const rows = db.prepare(`
    SELECT franchise, COUNT(*) as count
    FROM models
    WHERE franchise IS NOT NULL AND franchise != ''
      AND (hidden IS NULL OR hidden = 0)
    GROUP BY franchise
    ORDER BY count DESC, franchise
  `).all();
  res.json(rows);
});

// ── franchise browser ─────────────────────────────────────────────────────────

// ── bulk update ───────────────────────────────────────────────────────────────

// ── thumbnail stats / fix ─────────────────────────────────────────────────────

/**
 * GET /api/organize/integrity
 * Checks which model folder paths no longer exist on disk.
 * Fast (filesystem stat only, no ZIP parsing).
 */
router.get('/integrity', (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.folder_path, m.file_count,
           c.name AS creator_name
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
  `).all();

  const missingFolders = [];
  const missingFiles = [];
  const checked = { folders: 0, ok: 0 };

  for (const m of models) {
    checked.folders++;
    if (!m.folder_path || !fs.existsSync(realFolder(m.folder_path))) {
      missingFolders.push({ id: m.id, name: m.name, creator_name: m.creator_name, folder_path: m.folder_path });
    } else {
      checked.ok++;
    }
  }

  res.json({
    summary: { checked: checked.folders, ok: checked.ok, missingFolders: missingFolders.length },
    missingFolders,
  });
});

// ── loose file grouper ────────────────────────────────────────────────────────

const GROUPABLE_EXTS = new Set(['.zip', '.rar', '.7z', '.stl', '.obj', '.3mf', '.lys', '.chitubox', '.gcode', '.pdf', '.png', '.jpg', '.jpeg']);

function isGroupableFile(filename) {
  const lower = filename.toLowerCase();
  if (lower === '.ds_store' || lower === 'thumbs.db') return false;
  if (lower.startsWith('._') || lower.startsWith('@') || lower.startsWith('#')) return false;
  const ext = path.extname(lower);
  return GROUPABLE_EXTS.has(ext);
}

/**
 * Extract a model/character name from a filename by stripping:
 *  - file extension
 *  - Google Drive timestamp suffix (e.g. -20250109T000437Z-003)
 *  - scale prefix (e.g. "1_12 scale", "1-6 scale", "1-9scale")
 *  - common modifiers (pre-support, uncut, NSFW, painted, …)
 *  - creator slug (CA3D, CA 3D)
 */
function extractModelName(filename) {
  let name = filename;

  // Strip extension
  name = name.replace(/\.(zip|rar|7z|stl|obj|3mf|lys|chitubox|gcode|pdf|png|jpe?g)$/i, '');

  // Strip Google Drive timestamp: -20250109T000437Z-003  (with optional leading space/dash)
  name = name.replace(/\s*-\s*\d{8}T\d{6}Z-\d+\s*$/, '');

  // Strip scale prefix: "1_12 scale ", "1-9scale ", "1_6 Scale " etc.
  name = name.replace(/^\d+[-_]\d+\s*[Ss]cale\s*/i, '');

  // Strip common variant modifiers (word-boundary aware)
  // Note: "diorama" is intentionally NOT stripped — it's a distinct product type
  name = name.replace(/\bpre[-\s]?support(?:s|ed)?\b/gi, '');
  name = name.replace(/\buncut\b/gi, '');
  name = name.replace(/\bNSFW\b/gi, '');
  name = name.replace(/\bpainted\b/gi, '');
  name = name.replace(/\bbust\b/gi, '');
  name = name.replace(/\bstatue\b/gi, '');

  // Strip creator slug at word boundary
  name = name.replace(/\bCA[-\s]?3D\b/gi, '');

  // Clean up leftover separators and whitespace
  name = name.replace(/\s*[-–—]\s*$/, '').trim();
  name = name.replace(/^\s*[-–—]\s*/, '').trim();
  name = name.replace(/\s+/g, ' ').trim();

  return name;
}

function normalizeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function groupFilesByName(files) {
  const groups = new Map(); // normalizedKey → { suggestedName, files }

  for (const filename of files) {
    const extracted = extractModelName(filename);
    if (!extracted) continue;
    const key = normalizeKey(extracted);
    if (!groups.has(key)) groups.set(key, { suggestedName: extracted, files: [] });
    groups.get(key).files.push(filename);
  }

  return Array.from(groups.entries())
    .map(([key, g]) => ({ key, suggestedName: g.suggestedName, files: g.files.sort() }))
    .sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
}

/**
 * GET /api/organize/loose-files?path=<folder_path>
 *
 * Reads a directory and groups all loose (non-subfolder) files by inferred model name.
 * Returns: { path, groups, existingFolders, looseFileCount, unmatched }
 */
router.get('/loose-files', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path query param required' });
  const folderPath = confinedOr4xx(res, String(req.query.path));
  if (!folderPath) return;

  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch (e) {
    return res.status(404).json({ error: `Cannot read directory: ${e.message}` });
  }

  const looseFiles = [];
  const existingFolders = [];
  const unmatched = [];

  for (const entry of entries) {
    let stat;
    try { stat = fs.statSync(path.join(folderPath, entry)); } catch { continue; }
    if (stat.isDirectory()) {
      existingFolders.push(entry);
    } else if (isGroupableFile(entry)) {
      looseFiles.push(entry);
    } else {
      unmatched.push(entry);
    }
  }

  const groups = groupFilesByName(looseFiles);

  // Flag groups whose suggested name conflicts with an existing folder
  const existingKeys = new Set(existingFolders.map(normalizeKey));
  for (const g of groups) {
    g.conflicts = existingKeys.has(normalizeKey(g.suggestedName));
  }

  res.json({
    path: folderPath,
    groups,
    existingFolders,
    looseFileCount: looseFiles.length,
    unmatched,
  });
});

/** rename, falling back to copy+unlink across devices; never overwrites. */
function moveFileNoClobber(from, to) {
  if (fs.existsSync(to)) { const e = new Error(`Destination already exists: ${path.basename(to)}`); e.code = 'EEXIST'; throw e; }
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

/**
 * POST /api/organize/group-files
 * Body: { path, groups: [{name, files}], dryRun? }
 *
 * Creates subfolders and moves loose files into them.
 * dryRun=true (default) only returns the plan + bash script without touching the filesystem.
 * Always returns a bash script the user can run on the NAS directly.
 * Group and file names must be plain names (no "/", "\\", "..", NUL); existing
 * files are never overwritten.
 */
router.post('/group-files', (req, res) => {
  const { path: rawPath, groups, dryRun = true } = req.body || {};
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'groups array required' });
  const folderPath = confinedOr4xx(res, String(rawPath));
  if (!folderPath) return;

  const moves = [];
  const errors = [];
  const foldersCreated = [];
  const validGroups = [];

  for (const group of groups) {
    const name = typeof group?.name === 'string' ? group.name.trim() : group?.name;
    const files = group?.files;
    if (!name && (!Array.isArray(files) || !files.length)) continue;
    if (!isSafeSegment(name)) { errors.push({ type: 'invalid', name: String(name ?? ''), error: 'Invalid group name (no slashes, "..", or control characters)' }); continue; }
    if (!Array.isArray(files) || !files.length) continue;
    const okFiles = [];
    for (const f of files) {
      if (!isSafeSegment(f)) errors.push({ type: 'invalid', file: String(f ?? ''), group: name, error: 'Invalid file name' });
      else okFiles.push(f);
    }
    if (!okFiles.length) continue;
    validGroups.push({ name, files: okFiles });
  }

  if (!dryRun) {
    try { fs.accessSync(folderPath, fs.constants.W_OK); } catch (e) {
      return res.status(409).json({ error: `Folder is not writable (${e.code || e.message}). Use the generated script instead.`, code: e.code, readOnly: true });
    }
  }

  for (const { name, files } of validGroups) {
    const targetDir = path.join(folderPath, name);
    if (!dryRun) {
      try {
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir);
          foldersCreated.push(name);
        } else if (!fs.statSync(targetDir).isDirectory()) {
          errors.push({ type: 'mkdir', name, error: 'A file with that name already exists' });
          continue;
        }
      } catch (e) {
        errors.push({ type: 'mkdir', name, error: e.message });
        continue;
      }
    } else {
      foldersCreated.push(name);
    }

    for (const filename of files) {
      const from = path.join(folderPath, filename);
      const to   = path.join(targetDir, filename);
      moves.push({ file: filename, group: name, from, to });
      if (!dryRun) {
        try { moveFileNoClobber(from, to); }
        catch (e) { errors.push({ type: 'move', file: filename, group: name, error: e.message }); }
      }
    }
  }

  // Build a bash script for the machine that hosts the library. Every name is
  // single-quoted, so file names like "$(touch x).stl" stay inert.
  const hostPath = toHostPath(folderPath);
  const sshTarget = process.env.ORGANIZE_SSH_TARGET;
  const scriptLines = [
    '#!/bin/bash',
    `# STL Vault — Loose File Organizer`,
    sshTarget ? `# Run this on your NAS via SSH: ssh ${sshTarget.replace(/[^\w@.\-:]/g, '')}` : '# Run this in a shell on the machine that stores the library.',
    `# Generated: ${new Date().toISOString()}`,
    '',
    `cd -- ${shellQuote(hostPath)} || { echo ${shellQuote('Folder not found: ' + hostPath)}; exit 1; }`,
    '',
  ];

  for (const group of validGroups) {
    scriptLines.push(`# ── ${group.name} (${group.files.length} file${group.files.length !== 1 ? 's' : ''}) ──`);
    scriptLines.push(`mkdir -p -- ${shellQuote(group.name)}`);
    for (const filename of group.files) {
      scriptLines.push(`mv -n -- ${shellQuote(filename)} ${shellQuote(group.name + '/')}`);
    }
    scriptLines.push('');
  }

  const script = scriptLines.join('\n');

  res.json({
    dryRun,
    moves,
    foldersCreated,
    errors,
    script,
    summary: {
      groups: validGroups.length,
      files: moves.length,
      executed: dryRun ? 0 : moves.length - errors.filter(e => e.type === 'move').length,
      errors: errors.length,
    },
  });
});

// ── Folder role overrides ──────────────────────────────────────────────────
// The app's folder marks (creator | passthrough | category | model | ignore), docs/folder-roles.md.
// The same DB rows as /api/folder-roles (which also shows the _Meta/folder_roles.csv marks).

// Raw filesystem tree (bounded) for the folder-roles UI — shows the ACTUAL
// directory structure (not the indexed grouping) so misclassifications are fixable.
router.get('/fs-tree', (req, res) => {
  const base = confinedOr4xx(res, String(req.query.path || LIBRARY_PATH));
  if (!base) return;
  const maxDepth = Math.min(parseInt(req.query.depth, 10) || 3, 5);
  const MAX_CHILDREN = 300;
  let roles;
  try { roles = folderRolesLib.effectiveRoles(db, LIBRARY_PATH, librariesLib.listLibraries(LIBRARY_PATH)).merged; }
  catch { roles = new Map(); }

  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    entries = entries.filter(e => !e.name.startsWith('@') && !e.name.startsWith('#') && !e.name.startsWith('.'));
    const dirs = entries.filter(e => e.isDirectory());
    const e = roles.get(dir);
    const node = {
      name: path.basename(dir), path: dir, role: e ? e.role : null, source: e ? e.source : null, conflict: e ? e.conflict || null : null,
      genre: e ? e.genre || null : null, group: e ? e.group || null : null, tags: e ? e.tags || [] : [],
      dirCount: dirs.length, fileCount: entries.length - dirs.length, children: [],
    };
    if (depth < maxDepth) {
      for (const c of dirs.slice(0, MAX_CHILDREN)) {
        const child = walk(path.join(dir, c.name), depth + 1);
        if (child) node.children.push(child);
      }
    } else {
      node.truncated = dirs.length > 0;
    }
    return node;
  }

  const tree = walk(base, 0);
  if (!tree) return res.status(400).json({ error: `Cannot read ${base}` });
  res.json(tree);
});

/**
 * POST /api/organize/dedupe/resolve  { keepId, dropIds[] }
 * Health → X-Creator Dupes: fold the duplicates into the card that stays, as an accepted merge
 * (lib/enrich.js foldCards): a snapshot first, tags / notes / collections / queue carried over, an
 * alias so the next scan keeps them together, and Unmerge under Review → History.
 */
router.post('/dedupe/resolve', (req, res) => {
  const { keepId, dropIds } = req.body || {};
  if (!Number.isInteger(Number(keepId)) || !Array.isArray(dropIds) || !dropIds.length) {
    return res.status(400).json({ error: 'keepId and dropIds[] required' });
  }
  try {
    const r = require('./lib/enrich').foldCards(db, Number(keepId), dropIds.map(Number).filter(Number.isInteger), { reason: 'duplicate across creators (Health)' });
    res.json({ success: r.merged > 0, kept: Number(keepId), merged: r.merged, errors: r.errors, suggestionIds: r.suggestionIds });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
