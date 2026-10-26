'use strict';
/**
 * lib/suspects.js: folders that probably need a role (docs/folder-roles.md §4).
 *
 * Rule-based and cheap: computed from the cards and their files in the DB (plus an fs existence
 * check of each result). First matching rule wins per folder; strongest first, 200 at most.
 *
 *   mixed          a card spread over 8+ immediate sub-folders, or 20+ folders (not a studio work)
 *   category-name  a card named like a genre or a category word (Heroes, Terrain, "All …")
 *   tiny-siblings  a folder whose child folders produced 6+ cards of 1-2 files with part names
 *   creator-name   a folder inside a container whose name is a known creator or studio
 */
const fs = require('fs');
const path = require('path');
const naming = require('./naming');
const worksLib = require('./works');
const folderRoles = require('./folder-roles');
const { VARIANT_DIR, isExtVariantName } = require('./discovery');

const MAX = 200;
const SETTING = 'suspects_dismissed';
const PART_NAME = /^(?:(?:l|r|left|right|upper|lower|front|back)[\s_-]*)?(?:arms?|legs?|heads?|torso|base|body|hands?|feet|foot|wings?|tail|cape|hair|chest|back|neck|eyes?|shoulders?|hips?|belt|weapon|sword|shield|parts?|pieces?|piece\s*\d+|part\s*\d+)(?:[\s_-]*(?:l|r|left|right|\d+))*$/i;
const CONTAINER_NAME = /^(?:gumroad(?:\s+downloads?)?|downloads?|_unsorted|unsorted|imports?|to[\s_-]?sort|patreon|backups?|temp|tmp)$/i;
const NO_MEANING = /^(?:stl[\s_-]?archive|3d[\s_-]?prints?|library|libraries|downloads?|stuff|new folder|untitled)$/i;

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

function dismissedSet(db) {
  const v = parseJSON(typeof db.getSetting === 'function' ? db.getSetting(SETTING) : null, []);
  return new Set(Array.isArray(v) ? v : []);
}

function dismiss(db, p, undo = false) {
  const set = dismissedSet(db);
  if (undo) set.delete(p); else set.add(p);
  db.setSetting(SETTING, JSON.stringify([...set].slice(-2000)));
}

/**
 * @param {object} db
 * @param {{ libs?: object[], roles?: Map, dismissed?: boolean, exists?: (p) => boolean }} opts
 *   roles: effective marks (lib/folder-roles.js mergeRoles); marked folders are left out
 */
function computeSuspects(db, { libs = [], roles = new Map(), dismissed: withDismissed = false, exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } } } = {}) {
  const cards = db.prepare(`SELECT m.id, m.name, m.folder_path, COALESCE(m.kind, 'model') AS kind, m.work_key, m.file_count, c.name AS creator
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.folded_into IS NULL AND (m.hidden IS NULL OR m.hidden = 0)`).all();
  const byId = new Map(cards.map(c => [c.id, { ...c, real: worksLib.realFolder(c.folder_path || ''), dirs: new Map(), files: 0 }]));
  for (const r of db.prepare('SELECT model_id, filepath FROM model_files').iterate()) {
    const c = byId.get(r.model_id);
    if (!c || !r.filepath) continue;
    const d = path.dirname(r.filepath);
    c.dirs.set(d, (c.dirs.get(d) || 0) + 1);
    c.files++;
  }
  const libPaths = new Set(libs.map(l => l.path));
  const creators = new Set();
  for (const r of db.prepare('SELECT name FROM creators').all()) if (r.name && !/^(?:unsorted|_tools)$/i.test(r.name)) creators.add(r.name.toLowerCase());
  const dismissedNow = dismissedSet(db);
  const found = new Map(); // folder → item (first rule wins)
  const add = (item) => {
    if (found.has(item.path) || roles.has(item.path)) return;
    found.set(item.path, item);
  };
  const isStudio = (c) => c.kind === 'work' || c.kind === 'diorama';

  // variant / support / scale / media folders are parts of one model, not different things
  const variantName = (n) => VARIANT_DIR.test(n.trim()) || isExtVariantName(n);
  const subsOf = (c) => {
    const subs = new Map();
    for (const [d, n] of c.dirs) if (d.startsWith(c.real + path.sep)) {
      const s = d.slice(c.real.length + 1).split(path.sep)[0];
      if (!variantName(s)) subs.set(s, (subs.get(s) || 0) + n);
    }
    return subs;
  };

  // 1. mixed cards (studio works span folders by design: one character's sculpture, bust, variants)
  for (const c of byId.values()) {
    if (!c.real || !c.files || isStudio(c)) continue;
    const subs = subsOf(c);
    if (subs.size >= 8 || c.dirs.size >= 20) {
      const base = path.basename(c.real);
      const plain = libPaths.has(c.real) || NO_MEANING.test(base.trim()) || naming.isGenericText(base);
      const sample = [...subs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([k]) => k);
      const folders = Math.max(subs.size, c.dirs.size);
      add({ path: c.real, rule: 'mixed', suggestedRole: plain ? 'passthrough' : 'category',
        reason: `Card "${c.name}" holds ${c.files} files from ${folders} sub-folders`, confidence: Math.min(0.9, 0.6 + folders / 100),
        cardId: c.id, cardName: c.name, files: c.files, folders, sample });
    }
  }
  // 2. category-looking card names (a "Bases" folder with one base is just a part of its model)
  for (const c of byId.values()) {
    if (!c.real || isStudio(c)) continue;
    const base = path.basename(c.real).trim();
    const hit = [base, String(c.name || '').trim()].find(n => folderRoles.CATEGORY_NAME.test(n) || naming.canonicalGenre(n));
    if (!hit) continue;
    const subs = subsOf(c);
    if (subs.size < 2 && c.files < 4) continue;
    add({ path: c.real, rule: 'category-name', suggestedRole: 'category',
      reason: naming.canonicalGenre(hit) ? `Card "${c.name}" is named like a genre` : `Card "${c.name}" is named like a category of things`,
      confidence: subs.size >= 2 ? 0.75 : 0.5, cardId: c.id, cardName: c.name, files: c.files, folders: subs.size, sample: [...subs.keys()].slice(0, 5) });
  }
  // 3. many tiny sibling cards with part names
  const byParent = new Map();
  for (const c of byId.values()) {
    if (!c.real || c.files > 2 || c.files < 1 || isStudio(c)) continue;
    const base = path.basename(c.real).replace(/[_]+/g, ' ').trim();
    if (!(PART_NAME.test(base) || naming.isGenericText(base))) continue;
    const parent = path.dirname(c.real);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(c);
  }
  for (const [parent, list] of byParent) {
    if (list.length < 6 || libPaths.has(parent)) continue;
    const files = list.reduce((t, c) => t + c.files, 0);
    add({ path: parent, rule: 'tiny-siblings', suggestedRole: 'model',
      reason: `${list.length} tiny cards (1-2 files each) look like parts of one model`, confidence: Math.min(0.85, 0.6 + list.length / 40),
      cardId: list[0].id, cardName: list[0].name, files, folders: list.length, sample: list.slice(0, 5).map(c => path.basename(c.real)) });
  }
  // 4. creator-looking folder inside a container
  const seen = new Set();
  for (const c of byId.values()) {
    if (!c.real) continue;
    const lib = [...libPaths].filter(l => c.real === l || c.real.startsWith(l + path.sep)).sort((a, b) => b.length - a.length)[0] || null;
    const segs = (lib ? path.relative(lib, c.real) : c.real).split(path.sep).filter(Boolean);
    let base = lib || path.sep;
    for (let i = 0; i < segs.length - 1; i++) {
      const parent = path.join(base, ...segs.slice(0, i));
      const name = segs[i];
      const child = segs[i + 1];
      if (!(CONTAINER_NAME.test(name.trim()) || worksLib.TRANSPARENT.has(name.trim().toLowerCase()))) continue;
      const p = path.join(parent, name, child);
      if (seen.has(p)) continue;
      seen.add(p);
      const alias = naming.canonicalCreator(child);
      const known = (alias && naming.STUDIO_CREATORS.has(alias)) || creators.has(child.toLowerCase()) || (alias && creators.has(alias.toLowerCase()));
      if (!known || (c.creator && (c.creator.toLowerCase() === child.toLowerCase() || (alias && c.creator === alias)))) continue;
      add({ path: p, rule: 'creator-name', suggestedRole: 'creator',
        reason: `"${child}" inside "${name}" is the name of a known creator`, confidence: 0.7,
        cardId: c.id, cardName: c.name, files: c.files, folders: 0, sample: [] });
    }
  }

  const out = [];
  for (const item of found.values()) {
    const isDismissed = dismissedNow.has(item.path);
    if (isDismissed && !withDismissed) continue;
    if (!exists(item.path)) continue;
    const lr = folderRoles.libRel(item.path, libs);
    out.push({ path: item.path, library: lr.library, rel: lr.rel, name: path.basename(item.path), reason: item.reason, rule: item.rule,
      suggestedRole: item.suggestedRole, confidence: Math.round(item.confidence * 100) / 100, cardId: item.cardId ?? null, cardName: item.cardName ?? null,
      files: item.files, folders: item.folders, sample: item.sample, dismissed: isDismissed });
  }
  out.sort((a, b) => b.confidence - a.confidence || b.files - a.files || a.path.localeCompare(b.path));
  return out.slice(0, MAX);
}

module.exports = { computeSuspects, dismiss, dismissedSet, PART_NAME, SETTING };
