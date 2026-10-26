'use strict';
/**
 * lib/folder-roles.js: what a folder is (docs/folder-roles.md).
 *
 * Marks come from two places: each library's `_Meta/folder_roles.csv` (written by the organizer
 * skill; the app never writes it) and app marks in the DB (`folder_overrides`). The file wins.
 *
 *   loadFileRoles(metaDirs)   parse every folder_roles.csv → { files, entries }
 *   loadAppRoles(db)          the DB rows
 *   mergeRoles(file, app)     Map(abs → { path, role, genre, group, tags, note, source, conflict })
 *   roleMaps(merged)          { overrides: Map(abs → role), roleInfo: Map(abs → entry) } for the engine
 *   categoryValues(entry)     { genre, group, tags } of one category mark
 *   categoryFor(abs, …)       combined category values of every category mark above a folder
 */
const fs = require('fs');
const path = require('path');

const ROLES = ['creator', 'passthrough', 'category', 'model', 'ignore'];
const ROLE_LABEL = { creator: 'Creator', passthrough: 'Container', category: 'Category', model: 'Model', ignore: 'Ignore' };
const FILE_NAME = 'folder_roles.csv';
/** Folder / card names that say "a kind of things", not one thing (docs/folder-roles.md §4 rule 2). */
const CATEGORY_NAME = /^(?:all\b.*|heroes|enemies|allies|npcs?|monsters|terrain|scenery|bases|props|objects|busts|minis|miniatures|characters|creatures|bonus|extras|weapons|vehicles|buildings|accessories)$/i;

/** 'container' → 'passthrough'; '' / 'auto' → null; unknown → undefined. */
function normalizeRole(r) {
  if (r == null) return null;
  const s = String(r).trim().toLowerCase();
  if (!s || s === 'auto' || s === 'none') return null;
  if (s === 'container') return 'passthrough';
  return ROLES.includes(s) ? s : undefined;
}

const FORMULA = /^[=+\-@\t\r]/;
/** A short single-line value (genre, group, note); formula-looking and markup values are dropped. */
function cleanValue(v, max = 80) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || FORMULA.test(s) || /[<>]/.test(s)) return null;
  return s.slice(0, max);
}

/** "terrain|scenery" / "terrain, scenery" / ["terrain"] → ['terrain', 'scenery'] (lowercase, unique). */
function parseTags(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[|,]/);
  const out = [];
  for (const t of arr) {
    const s = cleanValue(t, 40);
    if (!s) continue;
    const l = s.toLowerCase();
    if (!out.includes(l)) out.push(l);
  }
  return out.slice(0, 20);
}

/**
 * A library-relative path ("Misc/Terrain") → absolute path, case-sensitive first, then
 * case-insensitive per segment. Null when it does not exist.
 */
function resolveRel(root, rel) {
  const segs = String(rel || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
  if (!segs.length || segs.some(s => s === '..' || s === '.')) return null;
  const exact = path.join(root, ...segs);
  try { if (fs.statSync(exact).isDirectory()) return exact; } catch { /* try case-insensitively */ }
  let cur = root;
  for (const seg of segs) {
    let names;
    try { names = fs.readdirSync(cur, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return null; }
    const hit = names.find(n => n === seg) || names.find(n => n.toLowerCase() === seg.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

/**
 * Parse one folder_roles.csv. `root` is the library folder (the folder holding _Meta).
 * @returns {{ entries: object[], errors: string[], rows: number }}
 */
function readRolesFile(file, root) {
  const { parseCSV } = require('./meta');
  const out = { entries: [], errors: [], rows: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch (e) { out.errors.push(`cannot read: ${e.message}`); return out; }
  const rows = parseCSV(text);
  if (!rows.length) return out;
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  if (col('path') === -1 || col('role') === -1) { out.errors.push('header must name the columns "path" and "role"'); return out; }
  const get = (r, n) => { const i = col(n); return i === -1 ? '' : String(r[i] ?? '').trim(); };
  const seen = new Map();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // the header is row 1
    const rawRole = get(r, 'role');
    if (!rawRole) return; // blank role: ignored
    out.rows++;
    const role = normalizeRole(rawRole);
    const rel = get(r, 'path').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rel) { out.errors.push(`row ${line}: no path`); return; }
    if (role === undefined) { out.errors.push(`row ${line}: unknown role "${rawRole}" (${rel})`); return; }
    if (role === null) return;
    const abs = resolveRel(root, rel);
    if (!abs) { out.errors.push(`row ${line}: path not found: ${rel}`); return; }
    const e = {
      path: abs, rel: path.relative(root, abs).split(path.sep).join('/'), role,
      genre: role === 'category' ? cleanValue(get(r, 'genre')) : null,
      group: role === 'category' ? cleanValue(get(r, 'group')) : null,
      tags: role === 'category' ? parseTags(get(r, 'tags')) : [],
      note: cleanValue(get(r, 'note'), 200) || '', source: 'file', line,
    };
    if (seen.has(abs)) { out.errors.push(`row ${line}: ${rel} is listed again (row ${seen.get(abs).line}); the later row wins`); out.entries.splice(out.entries.indexOf(seen.get(abs)), 1); }
    seen.set(abs, e);
    out.entries.push(e);
  });
  return out;
}

/**
 * Every `_Meta/folder_roles.csv` under the given _Meta directories.
 * @returns {{ files: {dir, root, path, rows, errors}[], entries: object[] }}
 */
function loadFileRoles(metaDirs = []) {
  const files = [];
  const entries = [];
  for (const dir of [...new Set(metaDirs)]) {
    const file = path.join(dir, FILE_NAME);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const root = path.dirname(dir);
    const r = readRolesFile(file, root);
    files.push({ dir, root, path: file, rows: r.rows, errors: r.errors });
    entries.push(...r.entries);
  }
  return { files, entries };
}

/** App marks (DB). Old databases without the new columns still work. */
function loadAppRoles(db) {
  let rows;
  try { rows = db.prepare('SELECT path, role, genre, grp, tags, note FROM folder_overrides').all(); }
  catch {
    try { rows = db.prepare('SELECT path, role FROM folder_overrides').all(); } catch { return []; }
  }
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const role = normalizeRole(r.role);
    if (!role) continue;
    let tags = [];
    try { tags = parseTags(JSON.parse(r.tags || '[]')); } catch { tags = parseTags(r.tags); }
    out.push({ path: r.path, role, genre: r.genre || null, group: r.grp || null, tags, note: r.note || '', source: 'app' });
  }
  return out;
}

const sameMark = (a, b) => a.role === b.role && (a.role !== 'category'
  || ((a.genre || '') === (b.genre || '') && (a.group || '') === (b.group || '') && (a.tags || []).join('|') === (b.tags || []).join('|')));

/**
 * Effective mark per absolute path: the file row if present, else the app row. A file row that
 * differs from an app row on the same path records `conflict: { role, genre?, group?, tags? }`
 * (the app's value, shown in the UI).
 */
function mergeRoles(fileEntries = [], appEntries = []) {
  const out = new Map();
  for (const a of appEntries) out.set(a.path, { ...a, conflict: null });
  for (const f of fileEntries) {
    const a = out.get(f.path);
    let conflict = null;
    if (a && a.source === 'app' && !sameMark(a, f)) {
      conflict = { role: a.role };
      if (a.role === 'category') Object.assign(conflict, { genre: a.genre, group: a.group, tags: a.tags });
    }
    const { line, ...rest } = f;
    out.set(f.path, { ...rest, conflict });
  }
  return out;
}

function roleMaps(merged) {
  const overrides = new Map();
  const roleInfo = new Map();
  for (const [p, e] of merged) { overrides.set(p, e.role); roleInfo.set(p, e); }
  return { overrides, roleInfo };
}

/**
 * Genre / group / tags of one category mark. With no genre and no group given, the folder name is
 * the genre when it is a known genre, else the group (tags are added either way).
 */
function categoryValues(e, isGenre = () => null) {
  if (!e || e.role !== 'category') return null;
  const tags = Array.isArray(e.tags) ? e.tags : [];
  // tags add to the folder's name meaning; a genre or group given replaces it
  if (e.genre || e.group) return { genre: e.genre || null, group: e.group || null, tags };
  const name = path.basename(e.path);
  const g = isGenre(name);
  return g ? { genre: g, group: null, tags } : { genre: null, group: name.replace(/_+/g, ' ').trim(), tags };
}

/**
 * Combined category values for a folder: every category mark at or above `dir` (up to `stop`).
 * The nearest genre wins, the nearest group wins, tags union. Null when no category applies.
 */
function categoryFor(dir, roleInfo, isGenre, stop = path.parse(dir).root) {
  if (!roleInfo || !roleInfo.size || !dir) return null;
  let genre = null, group = null, any = false;
  const tags = [];
  for (let d = dir; ; d = path.dirname(d)) {
    const e = roleInfo.get(d);
    if (e && e.role === 'category') {
      const v = categoryValues(e, isGenre);
      any = true;
      if (!genre && v.genre) genre = v.genre;
      if (!group && v.group) group = v.group;
      for (const t of v.tags) if (!tags.includes(t)) tags.push(t);
    }
    if (d === stop || d === path.dirname(d) || d.length <= stop.length) break;
  }
  return any ? { genre, group, tags } : null;
}

/** "Folder roles: 3 categories, 1 model, 2 ignored (file 4, app 2)" */
function summaryLine(merged, exists = () => true) {
  const n = { creator: 0, passthrough: 0, category: 0, model: 0, ignore: 0 };
  let file = 0, app = 0;
  for (const e of merged.values()) {
    if (!exists(e.path)) continue;
    n[e.role]++;
    if (e.source === 'file') file++; else app++;
  }
  if (!file && !app) return null;
  const plural = (k, one, many) => (n[k] ? `${n[k]} ${n[k] === 1 ? one : many}` : null);
  const parts = [plural('creator', 'creator', 'creators'), plural('passthrough', 'container', 'containers'), plural('category', 'category', 'categories'),
    plural('model', 'model', 'models'), n.ignore ? `${n.ignore} ignored` : null].filter(Boolean);
  return `Folder roles: ${parts.join(', ')} (file ${file}, app ${app})`;
}

/** _Meta folders of a library root: the root's own and each library's. */
function metaDirsFor(root, libs = []) {
  return [...new Set([path.join(root, '_Meta'), ...libs.map(l => path.join(l.path, '_Meta'))])];
}

/** The library holding `abs` and the path relative to it ('/' separators). */
function libRel(abs, libs = []) {
  let best = null;
  for (const l of libs) if (abs === l.path || abs.startsWith(l.path + path.sep)) { if (!best || l.path.length > best.path.length) best = l; }
  if (!best) return { library: null, rel: abs, root: null };
  return { library: best.name, rel: path.relative(best.path, abs).split(path.sep).join('/'), root: best.path };
}

/**
 * Every effective mark of a library root: its _Meta files (root and each library) over the DB.
 * @returns {{ merged: Map, files: object[] }}
 */
function effectiveRoles(db, root, libs = []) {
  const fr = loadFileRoles(metaDirsFor(root, libs));
  return { merged: mergeRoles(fr.entries, loadAppRoles(db)), files: fr.files };
}

module.exports = {
  effectiveRoles, CATEGORY_NAME,
  ROLES, ROLE_LABEL, FILE_NAME, normalizeRole, parseTags, cleanValue, resolveRel, readRolesFile, loadFileRoles, loadAppRoles,
  mergeRoles, roleMaps, categoryValues, categoryFor, summaryLine, metaDirsFor, libRel,
};
