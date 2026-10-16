'use strict';
/**
 * lib/organizer-export.js — what the Vault learned, in the stl-library-organizer's own formats
 * (docs/ai-enrichment.md §7). The app never moves files: moves.csv is a proposal the organizer
 * plans and Casey reviews.
 *
 *   genre_map.csv        character,genre               organizer --map
 *   filing_rules.csv     kind,key,value (fix|group|genre) file_inbox.py rules; keys like its key()
 *   model_json.ndjson    {library, rel, model}         sidecar pass (organizer model.json schema)
 *   moves.csv            library,from_rel,to_rel,reason,confidence   gold layout proposals
 *
 * Only trustworthy values leave the app: provenance sidecar, path, manifest, user (userFields),
 * ai-reviewed, and ai when it was auto-applied with confidence >= 0.9. A studio work's character
 * parsed from its delivered file names counts when a manifest product confirms the card
 * (confidence exact/name/sidecar); its group is the folder holding it (path).
 */
const path = require('path');
const worksLib = require('./works');

const AI_EXPORT_MIN = 0.9;
const STUDIO_ROOTS = new Set(['wicked', 'wicked archive', 'b3dserk', 'sw3d', 'star wars 3d models', 'zez']);
const CREATOR_FOLDER = { 'B3DSERK': 'B3DSERK', 'SW3D': 'SW3D', 'Wicked': 'Wicked', 'ZEZ': 'ZEZ' };
const TYPE_OF = { Sculpture: 'Sculpture', Bust: 'Bust', Accessory: 'Accessory', Diorama: 'Diorama' };

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
/** file_inbox.py key(): lowercase, punctuation → space, collapsed. */
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** SMB/AFP-safe folder name (organizer rule: strip \ / : * ? " < > | and trailing spaces/dots). */
const safeSeg = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(header, rows) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Trust of one field on a card: { ok, confidence, prov }. */
function trust(m, f) {
  const attr = parseJSON(m.attribution, {});
  const user = new Set(Array.isArray(attr.userFields) ? attr.userFields : []);
  if (user.has(f)) return { ok: true, confidence: 1, prov: 'user' };
  const prov = (attr.fields || {})[f] || null;
  if (prov === 'sidecar' || prov === 'path' || prov === 'manifest' || prov === 'ai-reviewed') return { ok: true, confidence: prov === 'ai-reviewed' ? 0.95 : 1, prov };
  if (prov === 'ai') {
    const c = (attr.ai || {})[f];
    return { ok: typeof c === 'number' && c >= AI_EXPORT_MIN, confidence: typeof c === 'number' ? c : 0, prov };
  }
  if (f === 'character' && prov === 'parse' && ['exact', 'name', 'sidecar'].includes(m.confidence)) return { ok: true, confidence: 0.9, prov };
  // a studio work's group comes from the folder that holds it (finalizeWorks): path provenance
  if (f === 'group_name' && !prov && m.group_name && (m.kind === 'work' || m.kind === 'diorama')) return { ok: true, confidence: 0.9, prov: 'path' };
  return { ok: false, confidence: 0, prov };
}

function cards(db, since) {
  const params = [];
  let where = `(m.hidden IS NULL OR m.hidden = 0) AND m.folded_into IS NULL AND COALESCE(m.kind, 'model') != 'tool'`;
  if (since) { where += ' AND m.updated_at >= ?'; params.push(String(since).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '')); }
  return db.prepare(`SELECT m.*, c.name AS creator_name FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE ${where} ORDER BY c.name, m.name`).all(...params);
}

/** genre_map.csv: character,genre set by AI (>= 0.9), review or the user, not already in genre_map. */
function genreMap(db, { since, metaSummary } = {}) {
  const known = new Set(Object.keys((metaSummary && metaSummary.genreMap) || {}).map(key));
  const rows = [], seen = new Set();
  for (const m of cards(db, since)) {
    if (!m.character || !m.franchise) continue;
    const t = trust(m, 'franchise');
    if (!t.ok || !['user', 'ai-reviewed', 'ai'].includes(t.prov)) continue;
    const k = key(m.character);
    if (!k || known.has(k) || seen.has(k)) continue;
    seen.add(k);
    rows.push([m.character, m.franchise]);
  }
  return { rows, text: toCSV(['character', 'genre'], rows) };
}

/** filing_rules.csv: fix (alias from → to), group (character key → group), genre (group key → genre). */
function filingRules(db, { since, metaSummary } = {}) {
  const rules = (metaSummary && metaSummary.rules) || {};
  const have = (kind, k) => Object.prototype.hasOwnProperty.call(rules[kind] || {}, k);
  const rows = [];
  const seen = new Set();
  const push = (kind, k, v) => { const id = `${kind}|${k}`; if (!k || !v || seen.has(id) || have(kind, k)) return; seen.add(id); rows.push([kind, k, v]); };
  const aliasWhere = since ? 'WHERE created_at >= ?' : '';
  for (const a of db.prepare(`SELECT * FROM aliases ${aliasWhere} ORDER BY id`).all(...(since ? [String(since).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '')] : []))) {
    const from = key(a.from_name), to = key(a.to_name);
    if (from && to && from !== to) push('fix', from, to);
  }
  const groupGenre = new Map(); // group key → Map(genre → n)
  const all = cards(db, since);
  // a group read from a folder is a team only when it holds several characters ("Dark Nights
  // Metal", "Watchmen"); "Axreal" above Azrael is just a character folder
  const members = new Map();
  for (const m of all) if (m.group_name && m.character) {
    const gk = `${m.creator_name}|${key(m.group_name)}`;
    if (!members.has(gk)) members.set(gk, new Set());
    members.get(gk).add(key(m.character).split(' ')[0]);
  }
  for (const m of all) {
    if (m.group_name && m.character) {
      let tg = trust(m, 'group_name');
      if (tg.ok && tg.prov === 'path' && (members.get(`${m.creator_name}|${key(m.group_name)}`) || new Set()).size < 3) tg = { ok: false };
      if (tg.ok && key(m.group_name) !== key(m.character)) push('group', key(m.character), m.group_name);
      if (tg.ok && m.franchise && trust(m, 'franchise').ok) {
        const gk = key(m.group_name);
        if (!groupGenre.has(gk)) groupGenre.set(gk, new Map());
        const g = groupGenre.get(gk);
        g.set(m.franchise, (g.get(m.franchise) || 0) + 1);
      }
    }
  }
  for (const [gk, g] of groupGenre) {
    const [best, n] = [...g.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...g.values()].reduce((s, x) => s + x, 0);
    if (n / total >= 0.8) push('genre', gk, best); // only a clear majority
  }
  return { rows, text: toCSV(['kind', 'key', 'value'], rows) };
}

/** Library label and library-relative path for an absolute path. */
function libRel(abs, libraries) {
  let best = null;
  for (const l of libraries || []) if (abs === l.path || abs.startsWith(l.path + path.sep)) { if (!best || l.path.length > best.path.length) best = l; }
  if (!best) return null;
  return { library: best.name, rel: path.relative(best.path, abs).split(path.sep).join('/'), root: best.path };
}

/** Sorted [dir, Set(model ids with files directly in it)], for "is this folder the work's own?" */
function folderOwners(db) {
  const owners = new Map();
  for (const r of db.prepare('SELECT model_id, filepath FROM model_files').iterate()) {
    const d = path.dirname(r.filepath);
    if (!owners.has(d)) owners.set(d, new Set());
    owners.get(d).add(r.model_id);
  }
  return [...owners.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/** True when no other card has files in `dir` or below it (binary search over the sorted dirs). */
function ownFolder(owners, dir, id) {
  let lo = 0, hi = owners.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (owners[mid][0] < dir) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < owners.length; i++) {
    const [d, ids] = owners[i];
    if (d !== dir && !d.startsWith(dir + path.sep)) { if (d > dir + path.sep + '\uffff') break; continue; }
    for (const x of ids) if (x !== id) return false;
  }
  return true;
}
/** Cards whose character or genre waits in the review list: their values are in doubt. */
function inReview(db) {
  return new Set(db.prepare(`SELECT DISTINCT model_id FROM suggestions WHERE status = 'pending' AND (type = 'merge' OR field IN ('character', 'franchise'))`).all().map(r => r.model_id));
}

/** Per studio work: its folders grouped by library + edition (type), with the files there. */
function workFolders(db, m, libraries) {
  const files = db.prepare('SELECT filename, filepath, edition, library FROM model_files WHERE model_id = ?').all(m.id);
  const groups = new Map();
  for (const f of files) {
    const lr = libRel(path.dirname(f.filepath), libraries);
    if (!lr) continue;
    const type = m.kind === 'diorama' ? 'Diorama' : (TYPE_OF[f.edition] || null);
    const k = `${lr.library}|${type || ''}`;
    if (!groups.has(k)) groups.set(k, { library: lr.library, root: lr.root, type, dirs: new Set(), files: [] });
    const g = groups.get(k);
    g.dirs.add(path.dirname(f.filepath));
    g.files.push(f.filename);
  }
  return [...groups.values()].map(g => {
    const dir = worksLib.commonDir([...g.dirs]);
    return { ...g, dir, rel: path.relative(g.root, dir).split(path.sep).join('/') };
  });
}

function studioWorks(db, since) {
  return cards(db, since).filter(m => (m.kind === 'work' || m.kind === 'diorama') && m.studio);
}

/**
 * Studio works with trustworthy character + genre, nothing about them in review, and each of their
 * folders that holds only their files (a model.json or a folder move must not catch another card).
 */
function exportableFolders(db, since, libraries) {
  const owners = folderOwners(db);
  const doubtful = inReview(db);
  const out = [];
  for (const m of studioWorks(db, since)) {
    const tc = trust(m, 'character'), tg = trust(m, 'franchise');
    if (!m.character || !m.franchise || !tc.ok || !tg.ok || doubtful.has(m.id)) continue;
    for (const g of workFolders(db, m, libraries)) {
      if (!g.rel || !g.type || !ownFolder(owners, g.dir, m.id)) continue;
      out.push({ m, g, tc, tg });
    }
  }
  return out;
}

/** model_json.ndjson: one line per work folder, the organizer's model.json schema. */
function modelJson(db, { since, libraries } = {}) {
  const lines = [];
  for (const { m, g } of exportableFolders(db, since, libraries)) {
    {
      const model = {
        studio: m.studio, creator: m.creator_name, genre: m.franchise, character: m.character, type: g.type,
        files: [...new Set(g.files)].sort(), source: m.source || '', claim_url: m.source === 'gumroad' ? (m.source_url || '') : '', release_term: m.release_term || '',
      };
      if (m.group_name && trust(m, 'group_name').ok) model.group = m.group_name;
      lines.push({ library: g.library, rel: g.rel, model });
    }
  }
  return { rows: lines, text: lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '') };
}

/** Gold-layout path: Creator/Genre/[Group/]Character/Type, dioramas Creator/Genre/_Dioramas/Title. */
function goldPath(m, g) {
  const first = g.rel.split('/')[0] || '';
  const creatorSeg = STUDIO_ROOTS.has(first.toLowerCase()) ? first : (CREATOR_FOLDER[m.creator_name] || safeSeg(m.creator_name));
  const genre = safeSeg(m.franchise);
  if (m.kind === 'diorama') return [creatorSeg, genre, '_Dioramas', safeSeg(m.character || m.name)].join('/');
  const parts = [creatorSeg, genre];
  if (m.group_name && trust(m, 'group_name').ok && key(m.group_name) !== key(m.character)) parts.push(safeSeg(m.group_name));
  parts.push(safeSeg(m.character), g.type);
  return parts.join('/');
}

/** moves.csv: proposals for off-layout studio works only; never applied by the app. */
function moves(db, { since, libraries } = {}) {
  const rows = [];
  const list = exportableFolders(db, since, libraries);
  const typesIn = new Map(); // "<work>|<library>|<dir>" → types held there
  for (const { m, g } of list) {
    const k = `${m.id}|${g.library}|${g.rel}`;
    if (!typesIn.has(k)) typesIn.set(k, []);
    typesIn.get(k).push(g.type);
  }
  const done = new Set();
  for (const { m, g, tc, tg } of list) {
    const k = `${m.id}|${g.library}|${g.rel}`;
    if (done.has(k)) continue;
    done.add(k);
    const types = typesIn.get(k);
    {
      // one folder holding several types (Sculpture + Bust): move it to the character folder;
      // the organizer's plan splits it into type folders
      let to = goldPath(m, g);
      if (types.length > 1) to = to.split('/').slice(0, -1).join('/');
      if (to.toLowerCase() === g.rel.toLowerCase()) continue;
      const segs = g.rel.split('/');
      const reasons = [];
      if (!segs.some(s => key(s) === key(m.franchise))) reasons.push('not under its genre folder');
      if (!segs.some(s => key(s) === key(m.character))) reasons.push('no character folder');
      if (types.length > 1) reasons.push(`holds ${types.join(' + ')}: split by type`);
      else if (key(segs[segs.length - 1]) !== key(g.type) && m.kind !== 'diorama') reasons.push('no type folder');
      if (/^gumroad downloads$/i.test(segs[0])) reasons.push('store download folder');
      const confidence = Math.round(Math.min(tc.confidence, tg.confidence) * 100) / 100;
      rows.push([g.library, g.rel, to, reasons.join('; ') || 'off the gold layout', confidence]);
    }
  }
  return { rows, text: toCSV(['library', 'from_rel', 'to_rel', 'reason', 'confidence'], rows) };
}

const FILES = {
  'genre_map.csv': { fn: genreMap, type: 'text/csv; charset=utf-8' },
  'filing_rules.csv': { fn: filingRules, type: 'text/csv; charset=utf-8' },
  'model_json.ndjson': { fn: modelJson, type: 'application/x-ndjson; charset=utf-8' },
  'moves.csv': { fn: moves, type: 'text/csv; charset=utf-8' },
};

module.exports = { FILES, genreMap, filingRules, modelJson, moves, toCSV, csvCell, key, trust, goldPath, AI_EXPORT_MIN };
