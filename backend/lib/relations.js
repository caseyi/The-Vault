'use strict';
/**
 * lib/relations.js — related cards and sets (docs/relations.md).
 *
 *   relations     diorama → character (features), release ↔ release (release-of),
 *                 accessory → character (accessory-of), manual links (related)
 *   sets          release packs (automatic) and themes (suggested, confirmed by Casey)
 *
 * Everything is keyed by work_key and re-resolved to ids after every scan and fold (aliases,
 * folds and release splits are followed; a key that is gone marks the row stale). Linking runs at
 * the end of each layout scan in the scan worker and on POST /api/relations/relink; it is
 * idempotent and never re-proposes what the user removed or rejected.
 */
const path = require('path');
const naming = require('./naming');
const worksLib = require('./works');

const RELATION_TYPES = ['features', 'release-of', 'accessory-of', 'related'];

// naming.normKey runs the organizer's typo fixes (a hundred regexes): memoized per fixer
const keyCaches = new WeakMap();
const DEFAULT_FIX = {};
function nkey(s, fix) {
  const owner = fix || DEFAULT_FIX;
  let c = keyCaches.get(owner);
  if (!c || c.size > 200000) keyCaches.set(owner, (c = new Map()));
  const k = String(s == null ? '' : s);
  let v = c.get(k);
  if (v === undefined) { v = naming.normKey(k, fix || undefined); c.set(k, v); }
  return v;
}
const SUGGESTION_TYPES = new Set(['relation', 'set', 'set-member']);
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const round2 = (n) => Math.round(n * 100) / 100;

function settings() {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  return {
    autoMin: num(process.env.RELATE_AUTO_MIN, 0.85),
    suggestMin: num(process.env.RELATE_SUGGEST_MIN, 0.6),
    auto: process.env.RELATE_AUTO !== '0',
  };
}

const keyOf = (card) => card.work_key || `#${card.id}`;
const baseKey = (k) => { const i = String(k).indexOf('|r:'); return i >= 0 ? String(k).slice(0, i) : String(k); };
const releaseId = (k) => { const i = String(k).indexOf('|r:'); return i >= 0 ? String(k).slice(i + 3) : null; };

// ── re-resolution by key ─────────────────────────────────────────────────────

/** Resolver over the current models table: key (+ the id it had) → { key, id } or null. */
function makeResolver(db) {
  const rows = new Map();
  const live = new Map();
  const byBase = new Map();
  for (const r of db.prepare('SELECT id, work_key, folded_into FROM models').iterate()) {
    rows.set(r.id, r);
    if (r.folded_into == null && r.work_key) {
      live.set(r.work_key, r.id);
      if (r.work_key.includes('|r:')) {
        const b = baseKey(r.work_key);
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push({ key: r.work_key, id: r.id });
      }
    }
  }
  let aliases = new Map();
  try { aliases = new Map(db.prepare('SELECT from_key, to_key FROM aliases').all().map(a => [a.from_key, a.to_key])); } catch { /* no aliases yet */ }
  const followAlias = (k) => { let cur = k; for (let i = 0; i < 8; i++) { const n = aliases.get(cur); if (!n || n === cur) break; cur = n; } return cur; };
  const followFold = (id) => {
    let r = rows.get(id);
    for (let i = 0; i < 8 && r && r.folded_into != null; i++) r = rows.get(r.folded_into);
    if (!r || r.folded_into != null) return null;
    return { key: r.work_key || `#${r.id}`, id: r.id };
  };
  function resolve(k, prevId) {
    if (!k) return prevId != null ? followFold(prevId) : null;
    if (k.startsWith('#')) { const id = Number(k.slice(1)); const r = rows.get(id); return r ? followFold(id) : null; }
    if (live.has(k)) return { key: k, id: live.get(k) };
    const b = baseKey(k), suf = k.slice(b.length);
    const b2 = followAlias(b);
    if (b2 !== b) {
      if (live.has(b2 + suf)) return { key: b2 + suf, id: live.get(b2 + suf) };
      if (live.has(b2)) return { key: b2, id: live.get(b2) };
    }
    // split into releases since: the release that kept the row, else the first
    const split = byBase.get(b2);
    if (!suf && split && split.length) {
      const same = split.find(x => x.id === prevId);
      const pick = same || [...split].sort((x, y) => x.id - y.id)[0];
      return { key: pick.key, id: pick.id };
    }
    // releases joined again
    if (suf && live.has(b2)) return { key: b2, id: live.get(b2) };
    // folded by a scan or a merge: the receiving card
    if (prevId != null) { const f = followFold(prevId); if (f && f.id !== prevId) return f; }
    return null;
  }
  return { resolve, rows, live };
}

const SOURCE_RANK = { user: 3, 'auto-reviewed': 2, auto: 1 };
const MEMBER_RANK = { removed: 4, active: 3, suggested: 2, stale: 1 };

/**
 * Re-resolve every relation, set member and pending relation/set suggestion to the cards that hold
 * their keys now. Rows whose key is gone are marked stale (removed rows stay removed).
 * @returns {{ relations: number, stale: number, members: number }} rows changed
 */
function resolveAll(db, { log = () => {} } = {}) {
  const R = makeResolver(db);
  const out = { relations: 0, stale: 0, members: 0, suggestions: 0 };
  db.transaction(() => {
    const rels = db.prepare('SELECT * FROM relations').all();
    const byKey = new Map(rels.map(r => [`${r.type}\u0000${r.from_key}\u0000${r.to_key}`, r]));
    const upd = db.prepare(`UPDATE relations SET from_key = ?, to_key = ?, from_id = ?, to_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?`);
    const del = db.prepare('DELETE FROM relations WHERE id = ?');
    for (const r of rels) {
      if (!byKey.has(`${r.type}\u0000${r.from_key}\u0000${r.to_key}`) || byKey.get(`${r.type}\u0000${r.from_key}\u0000${r.to_key}`) !== r) continue; // deleted as a duplicate
      const f = R.resolve(r.from_key, r.from_id), t = R.resolve(r.to_key, r.to_id);
      let status = r.status;
      if (!f || !t || f.id === t.id) {
        if (status === 'active') { status = 'stale'; out.stale++; }
        if (status !== r.status) { upd.run(r.from_key, r.to_key, r.from_id, r.to_id, status, r.id); out.relations++; }
        continue;
      }
      let [a, b] = [f, t];
      if (r.type === 'release-of' && a.id > b.id) [a, b] = [b, a];
      if (status === 'stale') status = 'active';
      if (a.key === r.from_key && b.key === r.to_key && a.id === r.from_id && b.id === r.to_id && status === r.status) continue;
      const nk = `${r.type}\u0000${a.key}\u0000${b.key}`;
      const rk = `${r.type}\u0000${b.key}\u0000${a.key}`;
      const other = [byKey.get(nk), r.type === 'release-of' ? byKey.get(rk) : null].find(x => x && x !== r);
      if (other) {
        // two rows for one link now: removed wins, then the user's, then reviewed, then auto
        const score = (x) => (x.status === 'removed' ? 10 : 0) + (SOURCE_RANK[x.source] || 0);
        const [win, lose] = score(other) >= score(r) ? [other, r] : [r, other];
        del.run(lose.id); byKey.delete(`${lose.type}\u0000${lose.from_key}\u0000${lose.to_key}`);
        if (win === other) { out.relations++; continue; }
      }
      byKey.delete(`${r.type}\u0000${r.from_key}\u0000${r.to_key}`);
      upd.run(a.key, b.key, a.id, b.id, status, r.id);
      byKey.set(nk, { ...r, from_key: a.key, to_key: b.key });
      out.relations++;
    }

    const members = db.prepare('SELECT * FROM set_members').all();
    const mKey = new Map(members.map(m => [`${m.set_id}\u0000${m.model_key}`, m]));
    const mUpd = db.prepare('UPDATE set_members SET model_key = ?, model_id = ?, status = ? WHERE set_id = ? AND model_key = ?');
    const mDel = db.prepare('DELETE FROM set_members WHERE set_id = ? AND model_key = ?');
    for (const m of members) {
      if (mKey.get(`${m.set_id}\u0000${m.model_key}`) !== m) continue;
      const x = R.resolve(m.model_key, m.model_id);
      if (!x) {
        if (m.status === 'active' || m.status === 'suggested') { mUpd.run(m.model_key, m.model_id, 'stale', m.set_id, m.model_key); out.members++; }
        continue;
      }
      const status = m.status === 'stale' ? 'active' : m.status;
      if (x.key === m.model_key && x.id === m.model_id && status === m.status) continue;
      const other = x.key !== m.model_key ? mKey.get(`${m.set_id}\u0000${x.key}`) : null;
      if (other) {
        const [, lose] = (MEMBER_RANK[other.status] || 0) >= (MEMBER_RANK[status] || 0) ? [other, m] : [m, other];
        mDel.run(lose.set_id, lose.model_key); mKey.delete(`${lose.set_id}\u0000${lose.model_key}`);
        if (lose === m) { out.members++; continue; }
      }
      mKey.delete(`${m.set_id}\u0000${m.model_key}`);
      mUpd.run(x.key, x.id, status, m.set_id, m.model_key);
      mKey.set(`${m.set_id}\u0000${x.key}`, { ...m, model_key: x.key, model_id: x.id, status });
      out.members++;
    }

    // pending proposals follow their cards (or go)
    const pend = db.prepare(`SELECT id, type, model_id, target_id, current FROM suggestions WHERE status = 'pending' AND type IN ('relation','set-member')`).all();
    const sUpd = db.prepare('UPDATE suggestions SET model_id = ?, target_id = ?, current = ? WHERE id = ?');
    const sSup = db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`);
    for (const s of pend) {
      const cur = parseJSON(s.current, {});
      if (s.type === 'relation') {
        const f = R.resolve(cur.fromKey, s.model_id), t = R.resolve(cur.toKey, s.target_id);
        if (!f || !t || f.id === t.id) { sSup.run(s.id); out.suggestions++; continue; }
        if (f.id !== s.model_id || t.id !== s.target_id || f.key !== cur.fromKey || t.key !== cur.toKey) {
          sUpd.run(f.id, t.id, JSON.stringify({ ...cur, fromKey: f.key, toKey: t.key }), s.id); out.suggestions++;
        }
      } else {
        const x = R.resolve(cur.modelKey, s.model_id);
        if (!x) { sSup.run(s.id); out.suggestions++; continue; }
        if (x.id !== s.model_id || x.key !== cur.modelKey) { sUpd.run(x.id, null, JSON.stringify({ ...cur, modelKey: x.key }), s.id); out.suggestions++; }
      }
    }
  })();
  if (out.stale) log('info', `Related cards: ${out.stale} link(s) lost a card (stale)`);
  return out;
}

// ── names ────────────────────────────────────────────────────────────────────

/** nickname (normalized) → full names (normalized); both directions are looked up */
const NICKNAMES = {
  'chewie': ['chewbacca'], 'mando': ['mandalorian'], 'vader': ['darth vader'],
  'obi wan': ['obi wan kenobi'], 'obiwan': ['obi wan kenobi'], 'ben kenobi': ['obi wan kenobi'], 'old ben kenobi': ['obi wan kenobi'],
  'ahsoka': ['ahsoka tano'], 'ashoka': ['ahsoka tano'], 'grogu': ['grogu', 'baby yoda', 'child'], 'baby yoda': ['grogu'], 'child': ['grogu'],
  'bo katan': ['bo katan kryze'], 'spidey': ['spiderman', 'spider man'], 'cap': ['captain america'], 'tony': ['iron man', 'tony stark'],
  'bucky': ['winter soldier'], 'bp': ['black panther'], 'ca': ['captain america'], 'kenobi': ['obi wan kenobi'], 'boba': ['boba fett'],
  'r2': ['r2d2'], 'threepio': ['c3po'], 'logan': ['wolverine'], 'jean': ['jean grey'], 'peter parker': ['spiderman'],
  'bruce banner': ['hulk'], 'banner': ['hulk'], 'thanos comic': ['thanos'], 'electra': ['elektra'],
  'han': ['han solo'], 'luke': ['luke skywalker'], 'leia': ['princess leia', 'leia organa'], 'anakin': ['anakin skywalker'], 'padme': ['padme amidala'],
  'dooku': ['count dooku'], 'grievous': ['general grievous'], 'maul': ['darth maul'], 'sidious': ['darth sidious', 'emperor palpatine'], 'palpatine': ['emperor palpatine', 'darth sidious'],
  'windu': ['mace windu'], 'qui gon': ['qui gon jinn'], 'armorer': ['the armorer'], 'sabertooth': ['sabretooth'], 'prof x': ['professor x'], 'xavier': ['professor x'],
};
const NICK = new Map();
for (const [nick, fulls] of Object.entries(NICKNAMES)) {
  const k = nkey(nick);
  for (const f of fulls) {
    const fk = nkey(f);
    if (!NICK.has(k)) NICK.set(k, new Set());
    NICK.get(k).add(fk);
    if (!NICK.has(fk)) NICK.set(fk, new Set());
    NICK.get(fk).add(k);
  }
}

// words dropped from a diorama title before it is split (edition and filler words)
const DIO_FILLER = /\b(?:dioramas?|dio|bases?|complete|scenes?|set|version|poster|platform|display|stained\s+glass|sculptures?|statues?|busts?|stls?|term|patreon|rocks?\s+fused|ref)\b/gi;
const MONTH_WORDS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
const QUALIFIERS = /\b(rotj|esb|anh|tfa|mcu|comics?|classic|netflix|new\s+hope|original)\b/gi;
const YEAR_RE = /\b(20[12]\d)\b/g;
const SPLIT_RE = /\s+(?:and|vs\.?|v|versus|with)\s+|\s*[&\/+,]\s*/i;

/** "Luke and Vader ROTJ 2024 Dio" → { names: ['Luke', 'Vader'], years: ['2024'], quals: ['rotj'] } */
function splitTitle(title) {
  let s = String(title || '').replace(/\([^)]*\)/g, (m) => ` ${m.slice(1, -1)} `).replace(/_/g, ' ');
  const years = [...s.matchAll(YEAR_RE)].map(m => m[1]);
  const quals = [...s.matchAll(QUALIFIERS)].map(m => m[1].toLowerCase().replace(/\s+/g, ''));
  s = s.replace(YEAR_RE, ' ').replace(QUALIFIERS, ' ').replace(DIO_FILLER, ' ').replace(MONTH_WORDS, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s?(?:mm|cm)?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const names = s.split(SPLIT_RE).map(x => x.replace(/^[\s\-:]+|[\s\-:]+$/g, '').trim()).filter(x => x && !naming.isGenericText(x));
  return { names, years, quals };
}

// accessory words (2.3); vehicles are never accessories
const ACC_WORDS = new Set(['blaster', 'blasters', 'rifle', 'rifles', 'pistol', 'pistols', 'lightsaber', 'lightsabers', 'saber', 'sabers', 'helmet', 'helmets',
  'shield', 'shields', 'hammer', 'hammers', 'sword', 'swords', 'axe', 'axes', 'staff', 'staffs', 'weapon', 'weapons', 'mask', 'masks', 'gun', 'guns', 'cannon', 'cannons']);
const VEHICLE_WORDS = new Set(['ship', 'speeder', 'podracer', 'fighter', 'starfighter', 'starfigther', 'falcon', 'wing', 'tie', 'crest', 'destroyer', 'bike', 'shuttle',
  'lambda', 'cruiser', 'car', 'delorean', 'tank', 'walker', 'slave', 'fluttercraft', 'hawk', 'class']);
const fixWords = (() => {
  const fx = naming.makeFixer();
  const cache = new Map();
  return (s) => {
    const k = String(s || '');
    let v = cache.get(k);
    if (!v) { v = fx(k.toLowerCase()).replace(/['’´`]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean); if (cache.size > 100000) cache.clear(); cache.set(k, v); }
    return v;
  };
})();

function isAccessoryCard(c) {
  if (c.kind === 'diorama' || c.kind === 'tool') return false;
  const w = fixWords(c.baseName);
  if (w.some(x => VEHICLE_WORDS.has(x))) return false;
  if (c.editions.length && c.editions.every(e => e === 'Accessory')) return true;
  // "Black Mask" with a Sculpture and a Bust is a character, not a mask
  if (c.editions.includes('Sculpture') || c.editions.includes('Bust')) return false;
  return w.some(x => ACC_WORDS.has(x));
}
const isFigure = (c) => c.kind !== 'diorama' && c.kind !== 'tool' && !c.accessory;
const hasFigureEdition = (c) => c.editions.includes('Sculpture') || c.editions.includes('Bust');

// ── linking ──────────────────────────────────────────────────────────────────

function loadCards(db) {
  const rows = db.prepare(`SELECT m.id, m.name, m.character, m.work_key, COALESCE(m.kind, 'model') AS kind, m.editions, m.folder_path, m.hidden,
      m.release_term, m.release_label, m.products, m.creator_id, c.name AS creator, c.folder_path AS creator_folder
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.folded_into IS NULL`).all();
  return rows.map(r => {
    const baseName = String(r.character || r.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || String(r.name || '');
    return { ...r, key: keyOf(r), base: baseKey(keyOf(r)), rel: releaseId(r.work_key || ''), editions: parseJSON(r.editions, []), baseName,
      real: worksLib.realFolder(r.folder_path || '') };
  });
}

/** Folders holding each card's files: Map(card id → [dir]). */
function loadFileDirs(db) {
  const out = new Map();
  const sep = path.sep;
  let lastId = null, lastDir = null, list = null;
  for (const r of db.prepare('SELECT model_id, filepath FROM model_files').all()) {
    const fp = r.filepath;
    const d = fp.slice(0, fp.lastIndexOf(sep)) || sep;
    if (r.model_id === lastId && d === lastDir) continue;
    lastId = r.model_id; lastDir = d;
    list = out.get(r.model_id);
    if (!list) out.set(r.model_id, (list = []));
    if (!list.includes(d)) list.push(d);
  }
  return out;
}

/** Card counts per folder: a card counts in every folder holding one of its files, and every folder above. */
function folderCounts(cards, dirsOf) {
  const n = new Map();
  for (const c of cards) {
    const seen = new Set();
    for (const start of dirsOf(c.id)) {
      for (let d = start, i = 0; i < 40 && !seen.has(d); i++) { seen.add(d); const up = path.dirname(d); if (up === d) break; d = up; }
    }
    if (!seen.size && c.real) for (let d = c.real, i = 0; i < 40 && !seen.has(d); i++) { seen.add(d); const up = path.dirname(d); if (up === d) break; d = up; }
    for (const d of seen) n.set(d, (n.get(d) || 0) + 1);
  }
  return n;
}

const commonDepth = (a, b) => { const x = a.split(path.sep), y = b.split(path.sep); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };

/**
 * Index of one creator's figures for name matching (2.1 step 2).
 */
function creatorIndex(cards, { fix, aliases }) {
  const byName = new Map(), byCompact = new Map(), byWord = new Map();
  const list = [];
  for (const c of cards) {
    const nk = nkey(c.baseName, fix);
    if (!nk) continue;
    c.nameKey = nk;
    c.compact = nk.replace(/\s+/g, '');
    c.stemSet = wordSet(c.baseName, fix);
    list.push(c);
    const add = (m, k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
    add(byName, nk); add(byCompact, c.compact);
    const ws = nk.split(' ');
    add(byWord, `f:${ws[0]}`); if (ws.length > 1) add(byWord, `l:${ws[ws.length - 1]}`);
  }
  return { byName, byCompact, byWord, list, aliases, fix };
}

/** Groups of candidate cards by name key (several cards of one name = releases / kinds). */
const groupByName = (cards) => { const m = new Map(); for (const c of cards) { if (!m.has(c.nameKey)) m.set(c.nameKey, []); m.get(c.nameKey).push(c); } return [...m.values()]; };

/**
 * Match one name to the creator's figures. Returns { groups: [[card…]], rule, conf, why } or null.
 * strict: only exact, alias and nickname rules (shortened names, minis).
 */
function matchName(name, idx, { strict = false, creator, accept = () => true } = {}) {
  const segKey = nkey(name, idx.fix);
  if (!segKey) return null;
  const compact = segKey.replace(/\s+/g, '');
  const ok = (arr) => (arr || []).filter(accept);
  const done = (cards, rule, conf, why) => (cards.length ? { groups: groupByName(cards), rule, conf, why } : null);
  // exact
  let r = done([...new Set([...ok(idx.byName.get(segKey)), ...ok(idx.byCompact.get(compact))])], 'exact', 0.95, (c) => `'${name}' is ${c.baseName}`);
  if (r) return r;
  // alias table (confirmed merges): "<creator>|work|<key>" → another key
  if (idx.aliases && creator) {
    for (const kind of ['work', 'model', 'release-item']) {
      const to = idx.aliases.get(`${creator}|${kind}|${segKey}`);
      if (!to) continue;
      const tk = String(to).split('|').slice(2).join('|');
      r = done(ok(idx.byName.get(tk)), 'alias', 0.95, (c) => `'${name}' was merged into ${c.baseName}`);
      if (r) return r;
    }
  }
  const shortName = compact.length < 4;
  // same words (naming.stems, but whole words: a shared prefix is not enough): "Kestis Cal", "Batman Statue"
  if (!strict && !shortName) {
    const st = wordSet(name, idx.fix);
    if (st.size) {
      const hits = idx.list.filter(c => accept(c) && c.stemSet.size === st.size && [...st].every(x => c.stemSet.has(x)));
      r = done(hits, 'stem', 0.85, (c) => `'${name}' has the same words as ${c.baseName}`);
      if (r) return r;
    }
  }
  // nickname list
  const nk = NICK.get(segKey);
  if (nk) {
    const hits = [];
    for (const full of nk) for (const c of [...ok(idx.byName.get(full)), ...ok(idx.byCompact.get(full.replace(/\s+/g, '')))]) if (!hits.includes(c)) hits.push(c);
    r = done(hits, 'nickname', 0.8, (c) => `'${name}' is a nickname of ${c.baseName}`);
    if (r) return r;
  }
  if (strict || shortName) return null;
  // edit distance <= 2 for names of 6+ letters
  if (compact.length >= 6) {
    let best = 3; let hits = [];
    for (const c of idx.list) {
      if (!accept(c) || Math.abs(c.compact.length - compact.length) > 2 || c.compact.length < 6) continue;
      const d = worksLib.editDistance(c.compact, compact, 2);
      if (d <= 2 && d < best) { best = d; hits = [c]; } else if (d <= 2 && d === best) hits.push(c);
    }
    r = done(hits, 'edit', 0.7, (c) => `'${name}' is a near spelling of ${c.baseName}`);
    if (r) return r;
  }
  // first or last name, when only one character of the creator has it
  if (!segKey.includes(' ') && segKey.length >= 4) {
    const hits = [...ok(idx.byWord.get(`f:${segKey}`)), ...ok(idx.byWord.get(`l:${segKey}`))].filter(c => c.nameKey.includes(' '));
    const groups = groupByName([...new Set(hits)]);
    if (groups.length === 1) return { groups, rule: 'first-last', conf: 0.65, why: (c) => `'${name}' is the first or last name of ${c.baseName}` };
    if (groups.length > 1) return { groups, rule: 'first-last', conf: 0.65, why: (c) => `'${name}' is the first or last name of ${c.baseName}`, ambiguous: true };
  }
  return null;
}

const LOOSE_RULES = new Set(['stem', 'edit', 'first-last']);

/** Significant words of a name (as naming.stems, whole words). */
function wordSet(name, fix) {
  return new Set(nkey(name, fix).split(' ').filter(w => w.length > 2 && !naming.GENERIC_WORDS.has(w)));
}

/**
 * A name that matched nothing ("Hulk Avengers", "The Witcher Geralt", "Sub Zero Spine Rip"): the
 * longest run of its words that is exactly a character (exact, alias, nickname); the words left
 * over pick the release ("Avengers" → Hulk (Avenger)).
 */
function matchPart(name, idx, opts) {
  const words = String(name).split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const part = words.slice(i, i + n).join(' ');
      if (nkey(part, idx.fix).replace(/\s+/g, '').length < 3) continue;
      const m = matchName(part, idx, { ...opts, strict: true });
      if (m && m.groups.length === 1) {
        const rest = [...words.slice(0, i), ...words.slice(i + n)].map(w => nkey(w, idx.fix)).filter(Boolean);
        return { ...m, rule: 'part', conf: Math.min(m.conf, 0.75), rest, why: (c) => `'${part}' (in '${name}') is ${c.baseName}` };
      }
    }
  }
  return null;
}

/**
 * The evidence folder of a card (2.1 step 3): the nearest folder at or above its files that holds
 * 2..12 cards; never a genre, studio, container, creator or library folder.
 */
function evidenceFolder(card, counts, excluded, dirsOf) {
  const dirs = dirsOf(card.id);
  const start = dirs.length ? worksLib.commonDir(dirs) : card.real;
  if (!start) return null;
  for (let d = start, i = 0; i < 12; i++) {
    if (excluded(d)) return null;
    const n = counts.get(d) || 0;
    if (n > 12) return null;
    if (n >= 2) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Pick one card among releases / kinds of one name: same qualifier > same term > same year > nearest folder. */
function pickRelease(group, from, filesOf) {
  if (group.length === 1) return group[0];
  const fromYears = new Set(from.years || []);
  if (from.release_term) fromYears.add(from.release_term.slice(0, 4));
  const quals = new Set(from.quals || []);
  const fromDirs = [from.real, ...(from.id ? filesOf(from.id) : [])].filter(Boolean);
  let best = null, bs = -1;
  for (const c of group) {
    let s = 0;
    const rid = c.rel ? c.rel.toLowerCase() : '';
    if (rid && (quals.has(rid) || fromYears.has(rid))) s += 1000;
    if (c.release_term && from.release_term && c.release_term === from.release_term) s += 500;
    else {
      const cy = c.release_term ? c.release_term.slice(0, 4) : (/^\d{4}/.test(rid) ? rid.slice(0, 4) : null);
      if (cy && fromYears.has(cy)) s += 250;
    }
    let depth = 0;
    for (const d of filesOf(c.id)) for (const e of fromDirs) depth = Math.max(depth, commonDepth(d, e));
    s += depth;
    if (c.kind === 'work') s += 0.5; // a studio character card beats a stray model of the same name
    if (s > bs || (s === bs && c.id < best.id)) { best = c; bs = s; }
  }
  return best;
}

const underDir = (dirs, folder) => dirs.some(d => d === folder || d.startsWith(folder + path.sep));

/**
 * Every automatic link the rules find now: Map(linkKey → { type, from, to, conf, why }).
 */
function computeLinks(db, cards, { fix, log = () => {} } = {}) {
  const out = new Map();
  const add = (type, a, b, conf, why) => {
    if (!a || !b || a.id === b.id) return;
    let from = a, to = b;
    if (type === 'release-of' && from.id > to.id) [from, to] = [to, from];
    const k = `${type}\u0000${from.key}\u0000${to.key}`;
    const prev = out.get(k);
    if (!prev || prev.conf < conf) out.set(k, { type, from, to, conf: type === 'release-of' ? 1 : round2(Math.min(0.99, conf)), why });
  };
  const live = cards.filter(c => c.kind !== 'tool');
  // 2.2 release-of: cards split by splitReleases share the key before "|r:"
  const byBase = new Map();
  for (const c of live) if (c.rel) { if (!byBase.has(c.base)) byBase.set(c.base, []); byBase.get(c.base).push(c); }
  for (const list of byBase.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add('release-of', list[i], list[j], 1, 'releases of one character');
  }

  let aliases = new Map();
  try { aliases = new Map(db.prepare('SELECT from_key, to_key FROM aliases').all().map(a => [a.from_key, a.to_key])); } catch { /* none */ }
  const fileDirs = loadFileDirs(db);
  const filesOf = (id) => fileDirs.get(id) || [];
  const counts = folderCounts(cards, filesOf);
  const creatorFolders = new Set(cards.map(c => c.creator_folder).filter(Boolean));
  const root = process.env.LIBRARY_PATH || '/library';
  const excluded = (d) => {
    const b = path.basename(d);
    return creatorFolders.has(d) || !!naming.canonicalGenre(b) || !!naming.canonicalCreator(b) || worksLib.TRANSPARENT.has(b.toLowerCase())
      || d === root || path.dirname(d) === root || !d.startsWith(root + path.sep) || d === path.dirname(d);
  };

  const byCreator = new Map();
  for (const c of live) { const k = c.creator || ''; if (!byCreator.has(k)) byCreator.set(k, []); byCreator.get(k).push(c); }
  for (const [creator, list] of byCreator) {
    for (const c of list) c.accessory = isAccessoryCard(c);
    const figures = list.filter(isFigure);
    const idx = creatorIndex(figures, { fix, aliases });
    const studio = naming.STUDIO_CREATORS.has(creator);

    // 2.1 dioramas → characters
    for (const dio of list.filter(c => c.kind === 'diorama')) {
      const t = splitTitle(dio.baseName);
      const from = { ...dio, years: [...t.years, ...splitTitle(path.basename(dio.real || '')).years], quals: t.quals };
      const folder = evidenceFolder(dio, counts, excluded, filesOf);
      const prods = parseJSON(dio.products, []).map(p => nkey(p && p.name || '', fix)).filter(Boolean);
      const dioKey = nkey(t.names.join(' '), fix);
      for (const name of t.names) {
        let m = matchName(name, idx, { creator, strict: false });
        if (!m) m = matchPart(name, idx, { creator });
        if (!m) continue;
        const from2 = m.rest ? { ...from, quals: [...from.quals, ...m.rest] } : from;
        let groups = m.groups;
        if (LOOSE_RULES.has(m.rule) && groups.length > 1 && folder) {
          const near = groups.filter(g => g.some(c => underDir(filesOf(c.id), folder)));
          if (near.length) groups = near;
        }
        if (groups.length > 1 && (LOOSE_RULES.has(m.rule) || m.ambiguous)) continue; // several characters: none is sure
        for (const g of groups.slice(0, 2)) {
          const c = pickRelease(g, from2, filesOf);
          let conf = m.conf;
          const why = [m.why(c)];
          if (folder && underDir(filesOf(c.id), folder)) { conf += 0.15; why.push(`same folder ${path.basename(folder)}`); }
          if (prods.some(p => (dioKey && p.includes(dioKey)) && p.includes(c.nameKey))) { conf += 0.1; why.push('a product names both'); }
          add('features', dio, c, conf, why.join('; '));
        }
      }
    }

    // 2.3 accessories → characters with a Sculpture or Bust edition
    const targets = figures.filter(hasFigureEdition);
    const tIdx = creatorIndex(targets, { fix, aliases });
    for (const acc of list.filter(c => c.accessory)) {
      const strict = !studio;
      const from = { ...acc, years: splitTitle(acc.baseName).years, quals: [] };
      // "Luke and Leia Helmet": each name; "Thor's Hammer": no possessive; "Light Sabers": one word
      const parts = String(acc.baseName).replace(/\blight\s*sabers?\b/gi, ' saber ').split(SPLIT_RE);
      for (const part of parts) {
        const words = fixWords(part).filter(w => !ACC_WORDS.has(w) && !/^\d+$/.test(w) && !naming.GENERIC_WORDS.has(w));
        if (!words.length) continue;
        const shown = words.join(' ');
        let m = matchName(shown, tIdx, { creator, strict });
        let prefix = false;
        for (let n = words.length - 1; !m && n >= 1; n--) { m = matchName(words.slice(0, n).join(' '), tIdx, { creator, strict: true }); prefix = !!m; }
        if (!m || m.groups.length !== 1) continue;
        const c = pickRelease(m.groups[0], from, filesOf);
        if (c.id === acc.id) continue;
        add('accessory-of', acc, c, m.conf - (prefix ? 0.05 : 0), `${m.why(c)}${prefix ? ' (start of the name)' : ''}`);
      }
    }
  }
  return out;
}

/**
 * Write the links: confident ones become auto relations, the rest go to the review queue.
 * Removed/rejected links are never re-proposed; auto links the rules no longer find go away.
 */
function reconcile(db, links, { log = () => {} } = {}) {
  const S = settings();
  const res = { added: 0, updated: 0, dropped: 0, suggested: 0, superseded: 0 };
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM relations').all();
    const idx = new Map();
    for (const r of rows) {
      idx.set(`${r.type}\u0000${r.from_key}\u0000${r.to_key}`, r);
      if (r.type === 'release-of') idx.set(`${r.type}\u0000${r.to_key}\u0000${r.from_key}`, r);
    }
    const pend = db.prepare(`SELECT id, field, current FROM suggestions WHERE type = 'relation' AND status = 'pending'`).all();
    const pIdx = new Map();
    for (const p of pend) { const c = parseJSON(p.current, {}); pIdx.set(`${p.field}\u0000${c.fromKey}\u0000${c.toKey}`, p); }
    const ins = db.prepare(`INSERT INTO relations (type, from_id, to_id, from_key, to_key, source, confidence, status, reason) VALUES (?,?,?,?,?, 'auto', ?, 'active', ?)`);
    const upd = db.prepare(`UPDATE relations SET from_id = ?, to_id = ?, confidence = ?, reason = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`);
    const touch = db.prepare(`UPDATE relations SET from_id = ?, to_id = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`);
    const del = db.prepare('DELETE FROM relations WHERE id = ?');
    const sIns = db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, target_id, confidence, reason, source, status) VALUES (?, 'relation', ?, ?, ?, ?, ?, ?, 'scan', 'pending')`);
    const sUpd = db.prepare('UPDATE suggestions SET model_id = ?, target_id = ?, confidence = ?, reason = ? WHERE id = ?');
    const seen = new Set(), seenP = new Set();
    for (const [k, l] of links) {
      const row = idx.get(k);
      const autoOk = l.type === 'release-of' || (S.auto && l.conf >= S.autoMin);
      if (row) {
        seen.add(row.id);
        if (row.status === 'removed') continue;
        if (row.source === 'auto') {
          if (!autoOk) { del.run(row.id); res.dropped++; }
          else {
            if (row.from_id !== l.from.id || row.to_id !== l.to.id || row.confidence !== l.conf || row.reason !== l.why || row.status !== 'active') { upd.run(l.from.id, l.to.id, l.conf, l.why, row.id); res.updated++; }
            continue;
          }
        } else {
          if (row.status !== 'active' || row.from_id !== l.from.id || row.to_id !== l.to.id) touch.run(l.from.id, l.to.id, row.id);
          continue;
        }
      }
      if (autoOk) { ins.run(l.type, l.from.id, l.to.id, l.from.key, l.to.key, l.conf, l.why); res.added++; continue; }
      if (l.conf < S.suggestMin) continue;
      const p = pIdx.get(k);
      if (p) { seenP.add(p.id); sUpd.run(l.from.id, l.to.id, l.conf, l.why, p.id); continue; }
      sIns.run(l.from.id, l.type, JSON.stringify({ fromKey: l.from.key, toKey: l.to.key }), JSON.stringify(l.type), l.to.id, l.conf, l.why);
      res.suggested++;
    }
    // auto links the rules no longer find (both cards still here): gone
    for (const r of rows) {
      if (r.source !== 'auto' || seen.has(r.id) || r.status !== 'active') continue;
      del.run(r.id); res.dropped++;
    }
    const sup = db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`);
    for (const p of pend) {
      if (seenP.has(p.id)) continue;
      const c = parseJSON(p.current, {});
      const k = `${p.field}\u0000${c.fromKey}\u0000${c.toKey}`;
      const l = links.get(k);
      if (l && !(l.type === 'release-of' || (S.auto && l.conf >= S.autoMin)) && l.conf >= S.suggestMin) continue;
      sup.run(p.id); res.superseded++;
    }
  })();
  return res;
}

// ── sets ─────────────────────────────────────────────────────────────────────

const setKeyOf = (creator, kind, name) => `${creator || ''}|${kind}|${nkey(name) || worksLib.slugify(String(name || '')) || 'set'}`;

/**
 * Release sets from the scan's works (7.2): every release pack is a `release` set of its creator
 * holding its release-item cards. A full scan drops members (and automatic sets) it no longer
 * finds; a scoped scan only adds.
 */
function syncReleaseSets(db, works, { scope = null } = {}) {
  const packs = new Map();
  for (const w of works || []) {
    if (!w.release || w.kind !== 'release-item') continue;
    const k = setKeyOf(w.creator, 'release', w.release.label);
    if (!packs.has(k)) packs.set(k, { key: k, creator: w.creator, name: w.release.label, term: w.release.term || null, members: new Map(), paths: new Set() });
    const p = packs.get(k);
    p.members.set(w.key, w.rowId || null);
    p.paths.add(w.release.path);
    if (!p.term && w.release.term) p.term = w.release.term;
  }
  const res = { sets: 0, added: 0, removed: 0 };
  const creators = new Set([...packs.values()].map(p => p.creator));
  db.transaction(() => {
    const existing = new Map(db.prepare(`SELECT * FROM sets WHERE kind = 'release'`).all().map(s => [s.key, s]));
    const ins = db.prepare(`INSERT INTO sets (creator, name, kind, key, term, source, status, info) VALUES (?, ?, 'release', ?, ?, 'auto', 'active', ?)`);
    const upd = db.prepare(`UPDATE sets SET name = CASE WHEN source = 'user' THEN name ELSE ? END, term = ?, info = ?, updated_at = datetime('now') WHERE id = ?`);
    const mIns = db.prepare(`INSERT INTO set_members (set_id, model_key, model_id, via, status, confidence) VALUES (?, ?, ?, 'release', 'active', 1)
      ON CONFLICT(set_id, model_key) DO UPDATE SET model_id = COALESCE(excluded.model_id, model_id), status = CASE WHEN status = 'removed' THEN status ELSE 'active' END`);
    for (const p of packs.values()) {
      const info = JSON.stringify({ paths: [...p.paths].slice(0, 8) });
      let s = existing.get(p.key);
      if (!s) { const id = ins.run(p.creator, p.name, p.key, p.term, info).lastInsertRowid; s = { id }; res.sets++; }
      else upd.run(p.name, p.term, info, s.id);
      for (const [k, id] of p.members) { mIns.run(s.id, k, id); res.added++; }
      if (!scope) {
        const keys = new Set(p.members.keys());
        for (const m of db.prepare(`SELECT model_key FROM set_members WHERE set_id = ? AND via = 'release'`).all(s.id)) {
          if (!keys.has(m.model_key)) { db.prepare('DELETE FROM set_members WHERE set_id = ? AND model_key = ?').run(s.id, m.model_key); res.removed++; }
        }
      }
    }
    if (!scope) {
      for (const s of existing.values()) {
        if (packs.has(s.key) || s.source !== 'auto' || s.status !== 'active') continue;
        db.prepare('DELETE FROM sets WHERE id = ?').run(s.id);
        db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE set_id = ? AND status = 'pending'`).run(s.id);
        res.removed++;
      }
    } else {
      void creators;
    }
  })();
  return res;
}

// theme tokens (7.3)
const RELEASE_WORDS = new Set(['tale', 'part', 'pack', 'bonus', 'extra', 'extras', 'supported', 'unsupported', 'supports', 'support', 'presupported', 'myairbridge', 'welcome',
  'leap', 'howl', 'idle', 'stand', 'stance', 'sit', 'run', 'jump', 'fly', 'fight', 'attack', 'crouch', 'scream', 'ready', 'rest', 'swing', 'turn', 'descend', 'sprint', 'climb',
  'roost', 'suspend', 'play', 'pose', 'walk', 'charge', 'flail', 'couple', 'mother', 'vol', 'volume', 'bundle', 'collection', 'remaster', 'remastered', 'stl', 'stls', 'files',
  'month', 'release', 'patreon', 'tribe', 'heroes', 'hero', 'monsters', 'monster', 'minis', 'miniatures', 'miniature', 'bust', 'busts', 'base', 'bases', 'unit', 'units',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'with', 'from', 'tabletop', 'collector', 'version', 'female', 'male',
  'mini', 'figure', 'figures', 'campaign', 'floor', 'tome', 'chapter', 'renders', 'render', 'images', 'free', 'gift', 'promo', 'sample', 'update', 'fixed', 'new']);
const IRREGULAR = { mice: 'mouse', geese: 'goose', wolves: 'wolf', dwarves: 'dwarf', elves: 'elf', women: 'woman', men: 'man', teeth: 'tooth', feet: 'foot', lice: 'louse' };

function isFillerToken(t, creatorWords) {
  if (t.length < 4 || /\d/.test(t)) return true;
  for (const f of [t, `${t}s`, `${t}es`]) if (worksLib.PRODUCT_FILLER.has(f) || RELEASE_WORDS.has(f) || naming.GENERIC_WORDS.has(f)) return true;
  for (const c of creatorWords) if (c === t || (c.length >= 6 && Math.abs(c.length - t.length) <= 2 && worksLib.editDistance(c, t, 2) <= 2)) return true;
  return false;
}

/** Label → [{ word (original), key (normalized) or null }], camelCase split ("DinoTopia" → Dino Topia). */
function labelWords(label) {
  // "Archvillain Society Vol. XI": the series name is the subscription, not a theme
  return String(label || '').replace(/^myairbridge[-_\s]*/i, '').replace(/^.*\bvol(?:ume)?\.?\s+[ivxlcdm\d]+\b/i, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ')
    .split(/\s+/).filter(Boolean).map(w => {
      const k = nkey(w);
      return { word: w.replace(/[^\w'’]+/g, ''), key: k && !k.includes(' ') ? k.replace(/\d+$/, '') : (k || null) };
    });
}

/** Theme keys of one source: kept tokens, adjacent pairs (as a compact key), with their display names. */
function sourceTokens(label, creatorWords) {
  const words = labelWords(label);
  const kept = words.map(w => (w.key && !isFillerToken(w.key, creatorWords) ? w : null));
  const keys = new Map(); // key → display
  for (let i = 0; i < kept.length; i++) {
    const a = kept[i];
    if (!a) continue;
    if (!keys.has(a.key)) keys.set(a.key, { display: [a.word], pair: false });
    const b = kept[i + 1];
    if (b) {
      const pk = a.key + b.key;
      if (!keys.has(pk) || keys.get(pk).pair) keys.set(pk, { display: [a.word, b.word], pair: true, parts: [a.key, b.key] });
    }
  }
  return keys;
}
const titleWord = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const relatedWord = (token, word) => {
  if (word === token || word.length < 4) return false;
  const w = IRREGULAR[word] || word;
  return w.slice(0, 4) === token.slice(0, 4);
};

/**
 * Theme proposals (7.3) for every creator with release sets. Returns
 * [{ creator, key, name, releases: [setId], members: Map(cardId → {via, conf}), counts }].
 */
function computeThemes(db, cards) {
  const releaseSets = db.prepare(`SELECT id, creator, name, term FROM sets WHERE kind = 'release' AND status = 'active'`).all();
  if (!releaseSets.length) return [];
  const members = db.prepare(`SELECT sm.set_id, sm.model_id FROM set_members sm JOIN sets s ON s.id = sm.set_id
    WHERE s.kind = 'release' AND s.status = 'active' AND sm.status = 'active' AND sm.model_id IS NOT NULL`).all();
  const relMembers = new Map();
  const inRelease = new Set();
  for (const m of members) { if (!relMembers.has(m.set_id)) relMembers.set(m.set_id, []); relMembers.get(m.set_id).push(m.model_id); inRelease.add(m.model_id); }
  const cardById = new Map(cards.map(c => [c.id, c]));
  const byCreator = new Map();
  for (const s of releaseSets) { if (!byCreator.has(s.creator)) byCreator.set(s.creator, []); byCreator.get(s.creator).push(s); }
  // accepted themes keep collecting cards with their word, whatever the thresholds say now
  const accepted = new Map();
  for (const t of db.prepare(`SELECT creator, name, info FROM sets WHERE kind = 'theme' AND status = 'active' AND source != 'user'`).all()) {
    const tok = parseJSON(t.info, {}).token;
    if (tok) { if (!accepted.has(t.creator)) accepted.set(t.creator, new Map()); accepted.get(t.creator).set(tok, t.name); }
  }
  const themes = [];
  for (const [creator, rsets] of byCreator) {
    const forced = accepted.get(creator) || new Map();
    const creatorWords = new Set(nkey(creator).split(' ').filter(Boolean).map(w => w.replace(/\d+$/, '')));
    const releaseItemNames = new Set();
    for (const s of rsets) for (const id of relMembers.get(s.id) || []) { const c = cardById.get(id); if (c) releaseItemNames.add(nkey(c.baseName)); }
    const loose = cards.filter(c => c.creator === creator && !inRelease.has(c.id) && c.kind !== 'tool' && c.kind !== 'release-item');
    const sources = [];
    for (const s of rsets) sources.push({ id: `r${s.id}`, release: s, label: s.name, toks: sourceTokens(s.name, creatorWords) });
    for (const c of loose) {
      const counted = !releaseItemNames.has(nkey(c.baseName)); // a loose copy of a release item does not count
      sources.push({ id: `c${c.id}`, card: c, label: c.baseName, toks: sourceTokens(c.baseName, creatorWords), counted });
    }
    const counted = sources.filter(s => s.release || s.counted);
    const total = counted.length;
    const occ = new Map(); // key → { sources: Set, release: bool, displays: [{display, pair, release}] }
    for (const s of counted) {
      for (const [k, t] of s.toks) {
        if (!occ.has(k)) occ.set(k, { key: k, sources: new Set(), release: false, displays: [], pair: true });
        const o = occ.get(k);
        o.sources.add(s.id);
        if (s.release) o.release = true;
        if (!t.pair) o.pair = false;
        o.displays.push({ display: t.display, pair: t.pair, release: !!s.release });
      }
    }
    const max = Math.max(2, Math.floor(total * 0.25));
    let cand = [...occ.values()].filter(o => forced.has(o.key) || (o.sources.size >= 2 && o.release && o.sources.size <= max));
    const subset = (a, b) => [...a].every(x => b.has(x));
    // a pair theme inside another theme's sources is dropped; themes with the same sources are one
    cand = cand.filter(o => forced.has(o.key) || !(o.pair && cand.some(p => p !== o && subset(o.sources, p.sources))));
    const bySig = new Map();
    for (const o of cand) {
      const sig = [...o.sources].sort().join(',');
      const prev = bySig.get(sig);
      if (!prev || (o.pair && !prev.pair) || (o.pair === prev.pair && o.key.length > prev.key.length)) bySig.set(sig, o);
    }
    for (const o of cand) if (forced.has(o.key) && ![...bySig.values()].includes(o)) bySig.set(`forced:${o.key}`, o);
    const usedNames = new Set();
    for (const o of [...bySig.values()].sort((a, b) => a.sources.size - b.sources.size || a.key.localeCompare(b.key))) {
      // name: the most complete form in a label (a pair "Archduke Mousin" over "Mousin"); a name
      // already taken by a narrower theme ("Silent Coin" for 'silent') leaves 'coin' its own word
      const pairsWith = [...occ.values()].filter(p => p.pair && p !== o && p.displays.some(d => d.pair) && p.displays[0].display.some(w => nkey(w).replace(/\d+$/, '') === o.key) && subset(p.sources, o.sources));
      let display = null;
      const relPair = pairsWith.filter(p => p.release).sort((a, b) => b.sources.size - a.sources.size)[0];
      if (relPair) display = relPair.displays.find(d => d.release && d.pair) || relPair.displays[0];
      if (!display) display = o.displays.find(d => d.pair && d.release) || o.displays.find(d => d.pair) || o.displays[0];
      let name = forced.get(o.key) || display.display.map(titleWord).join(' ');
      if (usedNames.has(name.toLowerCase())) name = (o.displays.find(d => !d.pair) || o.displays[0]).display.map(titleWord).join(' ');
      if (usedNames.has(name.toLowerCase())) continue;
      usedNames.add(name.toLowerCase());
      const tokenParts = o.pair ? null : o.key;
      const mem = new Map();
      const releases = [];
      for (const s of sources) {
        if (!s.toks.has(o.key)) continue;
        if (s.release) {
          releases.push(s.release.id);
          for (const id of relMembers.get(s.release.id) || []) if (!mem.has(id)) mem.set(id, { via: 'release', conf: 0.9 });
        } else if (!mem.has(s.card.id)) mem.set(s.card.id, { via: 'auto', conf: 0.8 });
      }
      if (tokenParts) {
        // one-word themes: related words (mice / mouse for mousin) at lower confidence
        for (const s of sources) {
          if (s.release || mem.has(s.card.id)) continue;
          const ws = labelWords(s.label).map(w => w.key).filter(Boolean);
          if (ws.some(w => relatedWord(tokenParts, w))) mem.set(s.card.id, { via: 'auto', conf: 0.6 });
        }
      }
      const looseN = [...mem.values()].filter(m => m.via !== 'release').length;
      themes.push({ creator, key: setKeyOf(creator, 'theme', o.key), token: o.key, name, releases, members: mem, counts: { cards: mem.size, releases: releases.length, loose: looseN } });
    }
  }
  return themes;
}

/** Store theme proposals: suggested sets + one 'set' suggestion each; set-member suggestions for accepted themes. */
function syncThemes(db, themes, cards) {
  const res = { suggested: 0, members: 0, dropped: 0 };
  const cardById = new Map(cards.map(c => [c.id, c]));
  db.transaction(() => {
    const existing = new Map(db.prepare(`SELECT * FROM sets WHERE kind = 'theme'`).all().map(s => [s.key, s]));
    const produced = new Set();
    const mGet = db.prepare('SELECT * FROM set_members WHERE set_id = ?');
    const mIns = db.prepare(`INSERT INTO set_members (set_id, model_key, model_id, via, status, confidence) VALUES (?,?,?,?,?,?)
      ON CONFLICT(set_id, model_key) DO NOTHING`);
    const mUpd = db.prepare('UPDATE set_members SET model_id = ?, via = ?, confidence = ? WHERE set_id = ? AND model_key = ?');
    const mDel = db.prepare('DELETE FROM set_members WHERE set_id = ? AND model_key = ?');
    const pendSet = db.prepare(`SELECT * FROM suggestions WHERE type = 'set' AND set_id = ? AND status = 'pending'`);
    const pendMem = db.prepare(`SELECT * FROM suggestions WHERE type = 'set-member' AND set_id = ? AND status = 'pending'`);
    const sup = db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`);
    for (const t of themes) {
      produced.add(t.key);
      let s = existing.get(t.key);
      if (s && s.status === 'removed') continue; // rejected or deleted: never again
      const info = JSON.stringify({ token: t.token, releases: t.releases, counts: t.counts });
      if (!s) {
        const id = db.prepare(`INSERT INTO sets (creator, name, kind, key, source, status, info) VALUES (?, ?, 'theme', ?, 'auto', 'suggested', ?)`).run(t.creator, t.name, t.key, info).lastInsertRowid;
        s = { id, status: 'suggested', source: 'auto', name: t.name };
      } else if (s.status === 'suggested') {
        db.prepare(`UPDATE sets SET name = CASE WHEN source = 'user' THEN name ELSE ? END, info = ?, updated_at = datetime('now') WHERE id = ?`).run(t.name, info, s.id);
      }
      const have = new Map(mGet.all(s.id).map(m => [m.model_key, m]));
      const want = new Map();
      for (const [id, m] of t.members) { const c = cardById.get(id); if (c) want.set(c.key, { c, ...m }); }
      if (s.status === 'suggested') {
        for (const [k, w] of want) {
          const h = have.get(k);
          if (!h) mIns.run(s.id, k, w.c.id, w.via, 'suggested', w.conf);
          else if (h.status === 'suggested' || h.status === 'stale') mUpd.run(w.c.id, w.via, w.conf, s.id, k);
        }
        for (const [k, h] of have) if (!want.has(k) && h.status === 'suggested' && h.via !== 'user') mDel.run(s.id, k);
        const cover = [...want.values()][0];
        if (!cover) continue;
        const p = pendSet.get(s.id);
        const reason = `'${t.name}' in ${t.counts.releases} release${t.counts.releases === 1 ? '' : 's'}${t.counts.loose ? ` and ${t.counts.loose} other card${t.counts.loose === 1 ? '' : 's'}` : ''}`;
        if (p) db.prepare('UPDATE suggestions SET model_id = ?, proposed = ?, reason = ?, current = ? WHERE id = ?').run(cover.c.id, JSON.stringify(t.name), reason, JSON.stringify({ key: t.key }), p.id);
        else {
          const rejected = db.prepare(`SELECT 1 FROM suggestions WHERE type = 'set' AND set_id = ? AND status = 'rejected'`).get(s.id);
          if (rejected) continue;
          db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, set_id, confidence, reason, source, status) VALUES (?, 'set', 'theme', ?, ?, ?, ?, ?, 'scan', 'pending')`)
            .run(cover.c.id, JSON.stringify({ key: t.key }), JSON.stringify(t.name), s.id, 0.75, reason);
          res.suggested++;
        }
      } else if (s.status === 'active') {
        // an accepted theme: newly found cards are proposed one by one
        const pend = new Map(pendMem.all(s.id).map(p => [parseJSON(p.current, {}).modelKey, p]));
        for (const [k, w] of want) {
          const h = have.get(k);
          if (h && h.status !== 'stale' && h.status !== 'suggested') continue;
          if (!h) mIns.run(s.id, k, w.c.id, w.via, 'suggested', w.conf);
          if (pend.has(k)) { pend.delete(k); continue; }
          db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, set_id, confidence, reason, source, status) VALUES (?, 'set-member', 'theme', ?, ?, ?, ?, ?, 'scan', 'pending')`)
            .run(w.c.id, JSON.stringify({ modelKey: k }), JSON.stringify(s.name), s.id, w.conf, `'${w.c.baseName}' matches the theme ${s.name}`);
          res.members++;
        }
        for (const p of pend.values()) { sup.run(p.id); const k = parseJSON(p.current, {}).modelKey; const h = have.get(k); if (h && h.status === 'suggested') mDel.run(s.id, k); }
      }
    }
    // proposals the library no longer supports
    for (const s of existing.values()) {
      if (produced.has(s.key) || s.status !== 'suggested' || s.source !== 'auto') continue;
      for (const p of db.prepare(`SELECT id FROM suggestions WHERE set_id = ? AND status = 'pending'`).all(s.id)) sup.run(p.id);
      db.prepare('DELETE FROM sets WHERE id = ?').run(s.id);
      res.dropped++;
    }
  })();
  return res;
}

/**
 * Re-resolve, link, and refresh sets. `works` (the scan's plan) refreshes release sets; without it
 * (POST /api/relations/relink) the stored release sets are used.
 */
function autoLink(db, { works = null, scope = null, fix = null, log = () => {} } = {}) {
  const t0 = Date.now();
  const out = {};
  if (works) out.releaseSets = syncReleaseSets(db, works, { scope });
  out.resolved = resolveAll(db, { log });
  const cards = loadCards(db);
  const links = computeLinks(db, cards, { fix: fix || undefined, log });
  out.links = reconcile(db, links, { log });
  const themes = computeThemes(db, cards);
  out.themes = syncThemes(db, themes, cards);
  out.ms = Date.now() - t0;
  const n = (t) => [...links.values()].filter(l => l.type === t).length;
  log('info', `Related cards: ${n('features')} diorama link(s), ${n('release-of')} release link(s), ${n('accessory-of')} accessory link(s)` +
    `${out.links.suggested ? `, ${out.links.suggested} new to review` : ''}; ${themes.length} theme(s) found (${out.ms} ms)`);
  return out;
}

// ── decisions (review queue) ─────────────────────────────────────────────────

function cardRow(db, id) { return db.prepare('SELECT id, name, work_key, folded_into FROM models WHERE id = ?').get(id); }

/** Create or reactivate a relation (manual or accepted). Returns the row. */
function upsertRelation(db, { type, fromId, toId, source = 'user', confidence = null, reason = null }) {
  if (!RELATION_TYPES.includes(type)) { const e = new Error(`type must be one of ${RELATION_TYPES.join(', ')}`); e.status = 400; throw e; }
  const a = cardRow(db, fromId), b = cardRow(db, toId);
  if (!a || !b) { const e = new Error('Card not found'); e.status = 404; throw e; }
  if (a.id === b.id) { const e = new Error('A card cannot be linked to itself'); e.status = 400; throw e; }
  if (a.folded_into != null || b.folded_into != null) { const e = new Error('A merged card cannot be linked; link the card it was merged into'); e.status = 400; throw e; }
  let [f, t] = [a, b];
  if (type === 'release-of' && f.id > t.id) [f, t] = [t, f];
  const fk = keyOf(f), tk = keyOf(t);
  const row = db.prepare('SELECT * FROM relations WHERE type = ? AND ((from_key = ? AND to_key = ?) OR (? AND from_key = ? AND to_key = ?))')
    .get(type, fk, tk, type === 'release-of' ? 1 : 0, tk, fk);
  if (row) {
    db.prepare(`UPDATE relations SET from_id = ?, to_id = ?, status = 'active', source = ?, confidence = COALESCE(?, confidence), reason = COALESCE(?, reason), updated_at = datetime('now') WHERE id = ?`)
      .run(row.from_key === fk ? f.id : t.id, row.from_key === fk ? t.id : f.id, source, confidence, reason, row.id);
    return db.prepare('SELECT * FROM relations WHERE id = ?').get(row.id);
  }
  const id = db.prepare(`INSERT INTO relations (type, from_id, to_id, from_key, to_key, source, confidence, status, reason) VALUES (?,?,?,?,?,?,?, 'active', ?)`)
    .run(type, f.id, t.id, fk, tk, source, confidence, reason).lastInsertRowid;
  return db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

/** Remove a relation: remembered (status removed), never re-proposed with the same keys. */
function removeRelation(db, id) {
  const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
  if (!row) return null;
  db.transaction(() => {
    db.prepare(`UPDATE relations SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = datetime('now') WHERE type = 'relation' AND status = 'pending' AND field = ? AND model_id = ? AND target_id = ?`).run(row.type, row.from_id, row.to_id);
  })();
  return db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

/** Remember a rejected link (a removed row with the proposal's keys). */
function rememberRejected(db, s) {
  const cur = parseJSON(s.current, {});
  const type = s.field;
  if (!RELATION_TYPES.includes(type) || !cur.fromKey || !cur.toKey) return;
  db.prepare(`INSERT INTO relations (type, from_id, to_id, from_key, to_key, source, confidence, status, reason) VALUES (?,?,?,?,?, 'auto', ?, 'removed', ?)
    ON CONFLICT(type, from_key, to_key) DO UPDATE SET status = 'removed', updated_at = datetime('now')`)
    .run(type, s.model_id, s.target_id, cur.fromKey, cur.toKey, s.confidence, s.reason);
}

/**
 * Accept or reject one relation / set / set-member suggestion (called by enrich.decide).
 * @returns {'accepted'|'rejected'}
 */
function decideSuggestion(db, s, decision) {
  const mark = (status) => db.prepare(`UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?`).run(status, s.id);
  let out = decision === 'accept' ? 'accepted' : 'rejected';
  db.transaction(() => {
    if (s.type === 'relation') {
      if (decision === 'reject') rememberRejected(db, s);
      else {
        const cur = parseJSON(s.current, {});
        upsertRelation(db, { type: s.field, fromId: s.model_id, toId: s.target_id, source: 'auto-reviewed', confidence: s.confidence, reason: s.reason });
        void cur;
      }
      mark(out);
    } else if (s.type === 'set') {
      const set = db.prepare('SELECT * FROM sets WHERE id = ?').get(s.set_id);
      if (!set) throw new Error('set not found');
      if (decision === 'reject') {
        db.prepare(`UPDATE sets SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(set.id);
      } else {
        db.prepare(`UPDATE sets SET status = 'active', source = CASE WHEN source = 'auto' THEN 'auto-reviewed' ELSE source END, updated_at = datetime('now') WHERE id = ?`).run(set.id);
        db.prepare(`UPDATE set_members SET status = 'active' WHERE set_id = ? AND status = 'suggested'`).run(set.id);
      }
      mark(out);
    } else if (s.type === 'set-member') {
      const cur = parseJSON(s.current, {});
      const set = db.prepare('SELECT * FROM sets WHERE id = ?').get(s.set_id);
      if (!set) throw new Error('set not found');
      const k = cur.modelKey;
      const st = decision === 'accept' ? 'active' : 'removed';
      db.prepare(`INSERT INTO set_members (set_id, model_key, model_id, via, status, confidence) VALUES (?, ?, ?, 'auto', ?, ?)
        ON CONFLICT(set_id, model_key) DO UPDATE SET status = excluded.status, model_id = excluded.model_id`).run(set.id, k, s.model_id, st, s.confidence);
      mark(out);
    }
  })();
  return out;
}

// ── read side ────────────────────────────────────────────────────────────────

let thumbsLib = null;
function thumbOf(m) {
  if (!thumbsLib) thumbsLib = require('./thumbs');
  const imgs = parseJSON(m.images, []);
  const t = m.thumbnail_path || imgs[0] || null;
  return t ? thumbsLib.thumbUrl(t, 480) : null;
}
const CARD_COLS = `m.id, m.name, COALESCE(m.kind, 'model') AS kind, m.thumbnail_path, m.images, m.editions, m.release_label, m.release_term, m.hidden, m.folded_into, c.name AS creator_name`;
function shapeCard(m, rel = null) {
  const out = { id: m.id, name: m.name, kind: m.kind || 'model', creator_name: m.creator_name || null, thumb_url: thumbOf(m), editions: parseJSON(m.editions, []), release_label: m.release_label || null };
  if (rel) Object.assign(out, { relationId: rel.id, source: rel.source, confidence: rel.confidence == null ? null : rel.confidence });
  return out;
}
function cardsByIds(db, ids) {
  const out = new Map();
  const list = [...new Set(ids)].filter(x => x != null);
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    for (const m of db.prepare(`SELECT ${CARD_COLS} FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id IN (${part.map(() => '?').join(',')})`).all(...part)) out.set(m.id, m);
  }
  return out;
}
const visible = (m) => m && m.folded_into == null && !m.hidden;

/** Sets a card is an active member of (release/theme) + diorama sets; chips for the detail page. */
function setChipsFor(db, ids) {
  const out = new Map(ids.map(id => [id, []]));
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT sm.model_id, s.id, s.kind, s.name, s.term FROM set_members sm JOIN sets s ON s.id = sm.set_id
      WHERE sm.status = 'active' AND s.status = 'active' AND sm.model_id IN (${ph}) ORDER BY s.kind, s.name`).all(...ids)) {
    out.get(r.model_id).push({ id: r.id, kind: r.kind, name: r.name, term: r.term || null });
  }
  for (const r of db.prepare(`SELECT r.from_id, r.to_id, d.name FROM relations r JOIN models d ON d.id = r.from_id JOIN models f ON f.id = r.to_id
      WHERE r.type = 'features' AND r.status = 'active' AND d.folded_into IS NULL AND COALESCE(d.hidden, 0) = 0 AND f.folded_into IS NULL AND COALESCE(f.hidden, 0) = 0
      AND (r.from_id IN (${ph}) OR r.to_id IN (${ph}))`).all(...ids, ...ids)) {
    for (const id of [r.from_id, r.to_id]) {
      const list = out.get(id);
      if (list && !list.some(x => x.id === `diorama-${r.from_id}`)) list.push({ id: `diorama-${r.from_id}`, kind: 'diorama', name: r.name, term: null });
    }
  }
  return out;
}

/** GET /api/models list badges: one grouped query per page. */
function relBadges(db, ids) {
  const out = new Map(ids.map(id => [id, { dioramas: 0, features: 0, releases: 0, accessories: 0, sets: [] }]));
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(`SELECT r.type, r.from_id, r.to_id FROM relations r JOIN models a ON a.id = r.from_id JOIN models b ON b.id = r.to_id
      WHERE r.status = 'active' AND (r.from_id IN (${ph}) OR r.to_id IN (${ph}))
      AND a.folded_into IS NULL AND b.folded_into IS NULL AND COALESCE(a.hidden, 0) = 0 AND COALESCE(b.hidden, 0) = 0`).all(...ids, ...ids);
  } catch { return out; }
  for (const r of rows) {
    const f = out.get(r.from_id), t = out.get(r.to_id);
    if (r.type === 'features') { if (f) f.features++; if (t) t.dioramas++; }
    else if (r.type === 'release-of') { if (f) f.releases++; if (t) t.releases++; }
    else if (r.type === 'accessory-of') { if (t) t.accessories++; }
  }
  const chips = setChipsFor(db, ids);
  for (const [id, list] of chips) out.get(id).sets = list.slice(0, 3).map(({ id: sid, kind, name }) => ({ id: sid, kind, name }));
  return out;
}

/** GET /api/models/:id additions: related, relatedPending, siblings (from release-of). */
function relatedFor(db, model) {
  const id = model.id;
  const rows = db.prepare(`SELECT * FROM relations WHERE status = 'active' AND (from_id = ? OR to_id = ?)`).all(id, id);
  const cards = cardsByIds(db, rows.flatMap(r => [r.from_id, r.to_id]));
  const related = { dioramas: [], characters: [], releases: [], accessories: [], accessoryOf: [], other: [], sets: [] };
  const siblings = [];
  for (const r of rows) {
    const otherId = r.from_id === id ? r.to_id : r.from_id;
    const o = cards.get(otherId);
    if (!visible(o)) continue;
    const card = shapeCard(o, r);
    if (r.type === 'features') (r.to_id === id ? related.dioramas : related.characters).push(card);
    else if (r.type === 'release-of') { related.releases.push(card); siblings.push({ id: o.id, name: o.name, release_term: o.release_term || null, release_label: o.release_label || null, editions: parseJSON(o.editions, []) }); }
    else if (r.type === 'accessory-of') (r.to_id === id ? related.accessories : related.accessoryOf).push(card);
    else related.other.push(card);
  }
  for (const k of Object.keys(related)) if (Array.isArray(related[k])) related[k].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  siblings.sort((a, b) => String(a.release_term || '').localeCompare(String(b.release_term || '')) || String(a.name).localeCompare(String(b.name)));
  related.sets = (setChipsFor(db, [id]).get(id) || []).map(s => ({ ...s, label: `${s.kind === 'release' ? 'Release' : s.kind === 'theme' ? 'Theme' : 'Diorama'}: ${s.name}${s.kind === 'release' && s.term ? ` (${s.term})` : ''}` }));
  return { related, siblings };
}

/** Pending relation / set suggestions that concern one card (the detail's relatedPending). */
function pendingFor(db, modelId, shapeSuggestion) {
  const rows = db.prepare(`SELECT * FROM suggestions WHERE status = 'pending' AND (
      (type = 'relation' AND (model_id = ? OR target_id = ?)) OR (type = 'set-member' AND model_id = ?)
      OR (type = 'set' AND set_id IN (SELECT set_id FROM set_members WHERE model_id = ? AND status = 'suggested'))) ORDER BY confidence DESC, id`).all(modelId, modelId, modelId, modelId);
  const cache = new Map();
  return rows.map(r => shapeSuggestion(db, r, cache));
}

/** Extra fields of relation / set suggestions in the review list. */
function shapeSuggestionExtra(db, r, out, card) {
  if (r.type === 'relation') { out.target = card(r.target_id); return out; }
  const set = r.set_id ? db.prepare('SELECT id, name, kind, creator, status, info FROM sets WHERE id = ?').get(r.set_id) : null;
  out.setId = r.set_id || null;
  out.set = set ? { id: set.id, name: set.name, kind: set.kind, creator: set.creator, status: set.status } : null;
  if (r.type === 'set' && set) {
    const mem = db.prepare(`SELECT model_id, via, status FROM set_members WHERE set_id = ? AND status IN ('suggested','active') AND model_id IS NOT NULL ORDER BY CASE via WHEN 'release' THEN 0 ELSE 1 END, rowid`).all(set.id);
    const cards = cardsByIds(db, mem.slice(0, 12).map(m => m.model_id));
    out.members = mem.slice(0, 12).map(m => cards.get(m.model_id)).filter(Boolean).map(m => shapeCard(m));
    const info = parseJSON(set.info, {});
    const loose = mem.filter(m => m.via !== 'release').length;
    out.counts = { cards: mem.length, releases: Array.isArray(info.releases) ? info.releases.length : 0, loose };
  }
  return out;
}

// ── filters (GET /api/models, /api/export) ───────────────────────────────────

const ACTIVE_EDGE = (alias = 'r', a = 'ra', b = 'rb') => `${alias}.status = 'active' AND ${a}.folded_into IS NULL AND COALESCE(${a}.hidden, 0) = 0 AND ${b}.folded_into IS NULL AND COALESCE(${b}.hidden, 0) = 0`;
const EDGE_FROM = `FROM relations r JOIN models ra ON ra.id = r.from_id JOIN models rb ON rb.id = r.to_id`;

/** The set of a card: itself, its dioramas, their figures, the figures' releases and accessories. */
function relatedSet(db, id) {
  const edges = db.prepare(`SELECT r.type, r.from_id, r.to_id ${EDGE_FROM} WHERE ${ACTIVE_EDGE()}`).all();
  const by = (type, side, x) => edges.filter(e => e.type === type && e[side] === x);
  const out = new Set([id]);
  const figures = new Set([id]);
  const dioramas = new Set(by('features', 'to_id', id).map(e => e.from_id));
  if (by('features', 'from_id', id).length) dioramas.add(id);
  for (const e of by('accessory-of', 'from_id', id)) figures.add(e.to_id);
  for (const d of dioramas) { out.add(d); for (const e of by('features', 'from_id', d)) figures.add(e.to_id); }
  for (const f of [...figures]) {
    out.add(f);
    for (const e of edges) if (e.type === 'release-of' && (e.from_id === f || e.to_id === f)) out.add(e.from_id === f ? e.to_id : e.from_id);
  }
  for (const f of [...out]) for (const e of by('accessory-of', 'to_id', f)) out.add(e.from_id);
  return [...out];
}

function setMemberIds(db, setId) {
  const m = String(setId).match(/^diorama-(\d+)$/);
  if (m) {
    const d = Number(m[1]);
    return [d, ...db.prepare(`SELECT r.to_id ${EDGE_FROM} WHERE r.type = 'features' AND r.from_id = ? AND ${ACTIVE_EDGE()}`).all(d).map(r => r.to_id)];
  }
  return db.prepare(`SELECT model_id FROM set_members WHERE set_id = ? AND status = 'active' AND model_id IS NOT NULL`).all(Number(setId)).map(r => r.model_id);
}

const on = (v) => v === '1' || v === 'true' || v === 1 || v === true;

/** Adds the relation / set filters of docs/relations.md §4 to a models query (alias m). */
function addFilters(db, q, where, params) {
  if (!q) return;
  let hasTables = true;
  try { db.prepare('SELECT 1 FROM relations LIMIT 1').get(); } catch { hasTables = false; }
  if (!hasTables) return;
  if (on(q.inDiorama) || on(q.hasDiorama)) where.push(`m.id IN (SELECT r.to_id ${EDGE_FROM} WHERE r.type = 'features' AND ${ACTIVE_EDGE()})`);
  if (on(q.features)) where.push(`m.id IN (SELECT r.from_id ${EDGE_FROM} WHERE r.type = 'features' AND ${ACTIVE_EDGE()})`);
  if (on(q.hasRelations)) where.push(`(m.id IN (SELECT r.from_id ${EDGE_FROM} WHERE ${ACTIVE_EDGE()}) OR m.id IN (SELECT r.to_id ${EDGE_FROM} WHERE ${ACTIVE_EDGE()}))`);
  if (on(q.hasReleases)) where.push(`(m.id IN (SELECT r.from_id ${EDGE_FROM} WHERE r.type = 'release-of' AND ${ACTIVE_EDGE()}) OR m.id IN (SELECT r.to_id ${EDGE_FROM} WHERE r.type = 'release-of' AND ${ACTIVE_EDGE()}))`);
  if (on(q.hasAccessories)) where.push(`m.id IN (SELECT r.to_id ${EDGE_FROM} WHERE r.type = 'accessory-of' AND ${ACTIVE_EDGE()})`);
  if (q.relatedTo && /^\d+$/.test(String(q.relatedTo))) {
    const ids = relatedSet(db, Number(q.relatedTo));
    where.push(`m.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (q.set != null && q.set !== '' && /^(?:\d+|diorama-\d+)$/.test(String(q.set))) {
    const ids = setMemberIds(db, q.set);
    if (ids.length) { where.push(`m.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); } else where.push('0');
  }
  const inSet = q.inSet ? String(q.inSet) : '';
  const memberSql = (kind) => `m.id IN (SELECT sm.model_id FROM set_members sm JOIN sets s ON s.id = sm.set_id WHERE sm.status = 'active' AND s.status = 'active'${kind ? ` AND s.kind = '${kind}'` : ''})`;
  const dioSql = `(m.id IN (SELECT r.to_id ${EDGE_FROM} WHERE r.type = 'features' AND ${ACTIVE_EDGE()}) OR m.id IN (SELECT r.from_id ${EDGE_FROM} WHERE r.type = 'features' AND ${ACTIVE_EDGE()}))`;
  if (inSet === 'release') where.push(memberSql('release'));
  else if (inSet === 'theme') where.push(memberSql('theme'));
  else if (inSet === 'diorama') where.push(dioSql);
  else if (inSet === 'any') where.push(`(${memberSql(null)} OR ${dioSql})`);
  if (on(q.noTheme)) where.push(`m.id NOT IN (SELECT sm.model_id FROM set_members sm JOIN sets s ON s.id = sm.set_id WHERE sm.status = 'active' AND s.status = 'active' AND s.kind = 'theme' AND sm.model_id IS NOT NULL)`);
}

const FILTER_PILLS = ['inDiorama', 'features', 'hasReleases', 'hasAccessories', 'hasRelations'];

/** GET /api/relations/summary */
function summary(db) {
  const out = { byType: {}, bySource: {}, byStatus: {}, dioramas: { total: 0, linked: 0 }, filters: {}, sets: { release: 0, theme: 0, suggested: 0 }, pending: { relation: 0, set: 0, 'set-member': 0 } };
  for (const t of RELATION_TYPES) out.byType[t] = 0;
  for (const r of db.prepare('SELECT type, source, status, COUNT(*) n FROM relations GROUP BY type, source, status').all()) {
    out.byStatus[r.status] = (out.byStatus[r.status] || 0) + r.n;
    if (r.status === 'active') { out.byType[r.type] = (out.byType[r.type] || 0) + r.n; out.bySource[r.source] = (out.bySource[r.source] || 0) + r.n; }
  }
  out.dioramas.total = db.prepare(`SELECT COUNT(*) n FROM models WHERE kind = 'diorama' AND folded_into IS NULL AND COALESCE(hidden, 0) = 0`).get().n;
  out.dioramas.linked = db.prepare(`SELECT COUNT(DISTINCT r.from_id) n ${EDGE_FROM} WHERE r.type = 'features' AND ra.kind = 'diorama' AND ${ACTIVE_EDGE()}`).get().n;
  for (const p of FILTER_PILLS) {
    const where = ['m.folded_into IS NULL', 'COALESCE(m.hidden, 0) = 0'], params = [];
    addFilters(db, { [p]: '1' }, where, params);
    out.filters[p] = db.prepare(`SELECT COUNT(*) n FROM models m WHERE ${where.join(' AND ')}`).get(...params).n;
  }
  for (const r of db.prepare(`SELECT kind, status, COUNT(*) n FROM sets GROUP BY kind, status`).all()) {
    if (r.status === 'active') out.sets[r.kind] = (out.sets[r.kind] || 0) + r.n;
    else if (r.status === 'suggested') out.sets.suggested += r.n;
  }
  out.sets.diorama = out.dioramas.linked;
  for (const r of db.prepare(`SELECT type, COUNT(*) n FROM suggestions WHERE status = 'pending' AND type IN ('relation','set','set-member') GROUP BY type`).all()) out.pending[r.type] = r.n;
  out.settings = settings();
  return out;
}

// ── organizer export ─────────────────────────────────────────────────────────

function exportRelations(db, { libraries } = {}, { libRel, toCSV, unsafeRow }) {
  const rows = [];
  let list = [];
  try {
    list = db.prepare(`SELECT r.type, r.source, a.name AS from_name, a.folder_path AS from_path, a.library AS lib, b.name AS to_name, b.folder_path AS to_path
      FROM relations r JOIN models a ON a.id = r.from_id JOIN models b ON b.id = r.to_id
      WHERE r.status = 'active' AND a.folded_into IS NULL AND b.folded_into IS NULL ORDER BY r.type, a.name, b.name`).all();
  } catch { list = []; }
  for (const r of list) {
    const fa = libRel(worksLib.realFolder(r.from_path || ''), libraries), ta = libRel(worksLib.realFolder(r.to_path || ''), libraries);
    const row = [r.type, (fa && fa.library) || r.lib || '', fa ? fa.rel : '', ta ? ta.rel : '', r.from_name, r.to_name, r.source];
    if (!unsafeRow(row)) rows.push(row);
  }
  return { rows, text: toCSV(['type', 'library', 'from_rel', 'to_rel', 'from_name', 'to_name', 'source'], rows) };
}

function exportSets(db, { libraries } = {}, { libRel, toCSV, unsafeRow }) {
  const rows = [];
  let list = [];
  try {
    list = db.prepare(`SELECT s.creator, s.kind, s.name, m.name AS member_name, m.folder_path, m.library FROM sets s JOIN set_members sm ON sm.set_id = s.id JOIN models m ON m.id = sm.model_id
      WHERE s.status = 'active' AND sm.status = 'active' AND m.folded_into IS NULL ORDER BY s.creator, s.kind, s.name, m.name`).all();
  } catch { list = []; }
  for (const r of list) {
    const lr = libRel(worksLib.realFolder(r.folder_path || ''), libraries);
    const row = [r.creator || '', r.kind, r.name, (lr && lr.library) || r.library || '', lr ? lr.rel : '', r.member_name];
    if (!unsafeRow(row)) rows.push(row);
  }
  return { rows, text: toCSV(['creator', 'kind', 'name', 'library', 'rel', 'member_name'], rows) };
}

module.exports = {
  RELATION_TYPES, SUGGESTION_TYPES, settings, keyOf, baseKey, makeResolver, resolveAll, splitTitle, matchName, creatorIndex, isAccessoryCard,
  loadCards, computeLinks, reconcile, syncReleaseSets, computeThemes, syncThemes, autoLink, upsertRelation, removeRelation, decideSuggestion,
  shapeCard, cardsByIds, setChipsFor, relBadges, relatedFor, pendingFor, shapeSuggestionExtra, relatedSet, setMemberIds, addFilters, summary,
  exportRelations, exportSets, sourceTokens, labelWords, CARD_COLS, visible, FILTER_PILLS, EDGE_FROM, ACTIVE_EDGE, setKeyOf,
};
