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
 *   folder_roles.csv     library,path,role,genre,group,tags,note       app folder marks (docs/folder-roles.md)
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
/** A cell a spreadsheet would run as a formula (CSV injection): such rows are not exported. */
const FORMULA = /^[=+\-@\t\r]/;
const unsafeRow = (r) => r.some(c => typeof c === 'string' && FORMULA.test(c));
function toCSV(header, rows) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Groups that are teams: a group read from a folder counts only when it holds 3+ characters of the
 * creator ("Dark Nights Metal", "Watchmen"); "Axreal" above Azrael or "Iron Man 2023" is just the
 * character's own folder. Returns a predicate (card) → boolean.
 */
function teamGroups(all) {
  const members = new Map();
  for (const m of all) if (m.group_name && m.character) {
    const gk = `${m.creator_name}|${key(m.group_name)}`;
    if (!members.has(gk)) members.set(gk, new Set());
    members.get(gk).add(key(m.character).split(' ')[0]);
  }
  return (m) => {
    if (!m.group_name || !m.character) return false;
    const t = trust(m, 'group_name');
    if (!t.ok) return false;
    const gk = key(m.group_name), ck = key(m.character);
    if (gk === ck || gk.startsWith(`${ck} `) || ck.startsWith(`${gk} `)) return false; // the character's own (release) folder
    if (t.prov === 'path' && (members.get(`${m.creator_name}|${gk}`) || new Set()).size < 3) return false;
    return true;
  };
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
    if (!unsafeRow([m.character, m.franchise])) rows.push([m.character, m.franchise]);
  }
  return { rows, text: toCSV(['character', 'genre'], rows) };
}

/** filing_rules.csv: fix (alias from → to), group (character key → group), genre (group key → genre). */
function filingRules(db, { since, metaSummary } = {}) {
  const rules = (metaSummary && metaSummary.rules) || {};
  const have = (kind, k) => Object.prototype.hasOwnProperty.call(rules[kind] || {}, k);
  const rows = [];
  const seen = new Set();
  const push = (kind, k, v) => {
    const id = `${kind}|${k}`;
    if (!k || !v || seen.has(id) || have(kind, k) || unsafeRow([kind, k, v])) return;
    seen.add(id); rows.push([kind, k, v]);
  };
  const aliasWhere = since ? 'WHERE created_at >= ?' : '';
  for (const a of db.prepare(`SELECT * FROM aliases ${aliasWhere} ORDER BY id`).all(...(since ? [String(since).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '')] : []))) {
    const from = key(a.from_name), toKey = key(a.to_name);
    if (!from || !toKey || from === toKey) continue;
    // file_inbox.py fixname() replaces the phrase inside longer names: "poison" → "poison ivy" would
    // turn "Poison Ivy" into "poison ivy Ivy". Only real typo fixes become rules.
    const fw = new Set(from.split(' ')), tw = new Set(toKey.split(' '));
    if ([...fw].every(w => tw.has(w)) || [...tw].every(w => fw.has(w))) continue;
    push('fix', from, String(a.to_name).trim().toLowerCase()); // keeps "jor-el" spelled as the organizer writes it
  }
  const groupGenre = new Map(); // group key → Map(genre → n)
  const all = cards(db, since);
  const isTeam = teamGroups(all);
  for (const m of all) {
    if (m.group_name && m.character) {
      const tg = { ok: isTeam(m) };
      if (tg.ok) push('group', key(m.character), m.group_name);
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
function exportableFolders(db, since, libraries, owners = folderOwners(db)) {
  const doubtful = inReview(db);
  const out = [];
  for (const m of studioWorks(db, since)) {
    const tc = trust(m, 'character'), tg = trust(m, 'franchise');
    if (!m.character || !m.franchise || !tc.ok || !tg.ok || doubtful.has(m.id) || unsafeRow([m.character, m.franchise, m.group_name || ''])) continue;
    for (const g of workFolders(db, m, libraries)) {
      if (!g.rel || !g.type || !ownFolder(owners, g.dir, m.id)) continue;
      out.push({ m, g, tc, tg });
    }
  }
  return out;
}

/** model_json.ndjson: one line per work folder, the organizer's model.json schema. */
function modelJson(db, { since, libraries } = {}) {
  const isTeam = teamGroups(cards(db, null));
  const lines = [];
  for (const { m, g } of exportableFolders(db, since, libraries)) {
    {
      const model = {
        studio: m.studio, creator: m.creator_name, genre: m.franchise, character: m.character, type: g.type,
        files: [...new Set(g.files)].sort(), source: m.source || '', claim_url: m.source === 'gumroad' ? (m.source_url || '') : '', release_term: m.release_term || '',
      };
      if (isTeam(m)) model.group = m.group_name;
      lines.push({ library: g.library, rel: g.rel, model });
    }
  }
  return { rows: lines, text: lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '') };
}

/**
 * Each library's studio root: the top folder its studio works live in ("Wicked Archive" on
 * Dagobah, "Wicked" on Endor). Moves stay inside it rather than inventing new top folders.
 */
function studioRoots(db, libraries) {
  const counts = new Map(); // library → Map(root → n)
  for (const r of db.prepare(`SELECT f.filepath FROM model_files f JOIN models m ON m.id = f.model_id WHERE m.kind IN ('work','diorama') AND m.studio IS NOT NULL AND m.folded_into IS NULL`).iterate()) {
    const lr = libRel(path.dirname(r.filepath), libraries);
    if (!lr) continue;
    const first = lr.rel.split('/')[0];
    if (!STUDIO_ROOTS.has(String(first).toLowerCase())) continue;
    if (!counts.has(lr.library)) counts.set(lr.library, new Map());
    const m = counts.get(lr.library);
    m.set(first, (m.get(first) || 0) + 1);
  }
  const best = new Map();
  for (const [lib, m] of counts) best.set(lib, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return best;
}

/** The card's character folder name: the release label too when the character has several ("Moon Knight (2026)"). */
function characterSeg(m) {
  const ch = safeSeg(m.character || m.name);
  if (!String(m.work_key || '').includes('|r:')) return ch;
  const label = (String(m.name || '').match(/\(([^)]+)\)\s*$/) || [])[1] || String(m.work_key).split('|r:')[1];
  return label && label !== 'base' ? `${ch} (${safeSeg(label)})` : ch;
}

/**
 * Gold-layout path: Root/Genre/[Group/]Character/Type, dioramas Root/Genre/_Dioramas/Title.
 * Root is the folder's own studio root when it is in one, else the library's; null when neither exists.
 */
function goldPath(m, g, ctx = {}) {
  const first = g.rel.split('/')[0] || '';
  const creatorSeg = STUDIO_ROOTS.has(first.toLowerCase()) ? first : (ctx.roots ? ctx.roots.get(g.library) : (CREATOR_FOLDER[m.creator_name] || safeSeg(m.creator_name)));
  if (!creatorSeg) return null;
  const genre = safeSeg(m.franchise);
  if (m.kind === 'diorama') return [creatorSeg, genre, '_Dioramas', characterSeg(m)].join('/');
  const parts = [creatorSeg, genre];
  const team = ctx.isTeam ? ctx.isTeam(m) : (m.group_name && trust(m, 'group_name').ok && key(m.group_name) !== key(m.character));
  if (team) parts.push(safeSeg(m.group_name));
  parts.push(characterSeg(m), g.type);
  return parts.join('/');
}

/** moves.csv: proposals for off-layout studio works only; never applied by the app. */
function moves(db, { since, libraries } = {}) {
  const rows = [];
  const owners = folderOwners(db);
  const list = exportableFolders(db, since, libraries, owners);
  const ctx = { roots: studioRoots(db, libraries), isTeam: teamGroups(cards(db, null)) };
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
      let to = goldPath(m, g, ctx);
      if (!to) continue; // no studio root in that library to file it under
      if (types.length > 1) to = to.split('/').slice(0, -1).join('/');
      if (to.split('/').some(seg => !seg)) continue; // an empty segment: not a real place
      if (to.toLowerCase() === g.rel.toLowerCase()) continue;
      // the destination already holds another card's files: moving there would mix them
      if (!ownFolder(owners, path.join(g.root, ...to.split('/')), m.id)) continue;
      const segs = g.rel.split('/');
      const reasons = [];
      if (!segs.some(s => key(s) === key(m.franchise))) reasons.push('not under its genre folder');
      if (!segs.some(s => key(s) === key(m.character))) reasons.push('no character folder');
      if (types.length > 1) reasons.push(`holds ${types.join(' + ')}: split by type`);
      else if (key(segs[segs.length - 1]) !== key(g.type) && m.kind !== 'diorama') reasons.push('no type folder');
      if (/^gumroad downloads$/i.test(segs[0])) reasons.push('store download folder');
      const confidence = Math.round(Math.min(tc.confidence, tg.confidence) * 100) / 100;
      const row = [g.library, g.rel, to, reasons.join('; ') || 'off the gold layout', confidence];
      if (!unsafeRow(row)) rows.push(row);
    }
  }
  // two folders proposed for the same destination: neither row is safe
  const dest = new Map();
  for (const r of rows) { const k = `${r[0]}|${String(r[2]).toLowerCase()}`; dest.set(k, (dest.get(k) || 0) + 1); }
  const kept = rows.filter(r => dest.get(`${r[0]}|${String(r[2]).toLowerCase()}`) === 1);
  return { rows: kept, dropped: rows.length - kept.length, text: toCSV(['library', 'from_rel', 'to_rel', 'reason', 'confidence'], kept) };
}

/**
 * folder_roles.csv: the app's folder marks in the _Meta/folder_roles.csv format, with a leading
 * library column so the organizer can merge each row into that library's file. Marks outside
 * every library are left out.
 */
function folderRolesFile(db, { since, libraries } = {}) {
  let list;
  try {
    list = db.prepare(`SELECT path, role, genre, grp, tags, note, COALESCE(updated_at, created_at) AS at FROM folder_overrides ORDER BY path`).all();
  } catch { list = []; }
  const rows = [];
  for (const r of list) {
    if (since && r.at && r.at < String(since).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '')) continue;
    const lr = libRel(r.path, libraries);
    if (!lr || !lr.rel) continue;
    const tags = parseJSON(r.tags, []);
    const row = [lr.library, lr.rel, r.role, r.genre || '', r.grp || '', Array.isArray(tags) ? tags.join('|') : '', r.note || ''];
    if (!unsafeRow(row)) rows.push(row);
  }
  return { rows, text: toCSV(['library', 'path', 'role', 'genre', 'group', 'tags', 'note'], rows) };
}

/** relations.csv / sets.csv: related cards and sets (docs/relations.md §4) */
const relationsFile = (db, ctx = {}) => require('./relations').exportRelations(db, ctx, { libRel, toCSV, unsafeRow });
const setsFile = (db, ctx = {}) => require('./relations').exportSets(db, ctx, { libRel, toCSV, unsafeRow });

const FILES = {
  'genre_map.csv': { fn: genreMap, type: 'text/csv; charset=utf-8' },
  'filing_rules.csv': { fn: filingRules, type: 'text/csv; charset=utf-8' },
  'model_json.ndjson': { fn: modelJson, type: 'application/x-ndjson; charset=utf-8' },
  'moves.csv': { fn: moves, type: 'text/csv; charset=utf-8' },
  'folder_roles.csv': { fn: folderRolesFile, type: 'text/csv; charset=utf-8' },
  'relations.csv': { fn: relationsFile, type: 'text/csv; charset=utf-8' },
  'sets.csv': { fn: setsFile, type: 'text/csv; charset=utf-8' },
};

module.exports = { FILES, relationsFile, setsFile, genreMap, filingRules, modelJson, moves, folderRolesFile, toCSV, csvCell, key, trust, goldPath, characterSeg, studioRoots, teamGroups, AI_EXPORT_MIN };
