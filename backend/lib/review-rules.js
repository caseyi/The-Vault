'use strict';
/**
 * lib/review-rules.js: nudges Casey gives the AI from the Review tab (docs/ai-enrichment.md §11).
 *
 * Three kinds, each for one field, optionally scoped to a creator and/or a folder (and below):
 *
 *   block  never propose `match` for the field              "Never propose 'Mist of the Jungle' as a genre"
 *   map    use `value` whenever the AI proposes `match`     "Titus Varbonus → Titus Warmhammer"
 *   set    the field of every card in scope is `value`      "Cards under Wicked Archive/Star Wars: genre Star Wars"
 *
 * Rules take effect three ways ("both", Casey Nov 2026):
 *   - at once, on what is pending: blocked proposals are rejected, mapped ones rewritten, and set
 *     rules write the value to the cards in scope (provenance "review-rule") and clear their proposals;
 *   - on every later Enrich answer, before the apply policy (transformAnswer);
 *   - as hints in the AI prompt (promptLines), so the model learns the house style.
 *
 * A set rule never overwrites model.json, a path/manifest/Drive/role value, or a value the user set or
 * accepted; deleting a set rule can clear the values it wrote that nobody changed since.
 */
const path = require('path');
const worksLib = require('./works');

const KINDS = ['block', 'map', 'set'];
/** Fields each kind may target. */
const FIELDS = {
  block: ['character', 'franchise', 'group_name', 'tags', 'name'],
  map: ['character', 'franchise', 'group_name', 'tags'],
  set: ['franchise', 'group_name', 'tags'],
};
const FIELD_LABEL = { character: 'character', franchise: 'genre', group_name: 'group', tags: 'tag', name: 'name', editions: 'edition' };
const COLUMNS = { character: 'character', franchise: 'franchise', group_name: 'group_name', tags: 'tags' };
const PROV = 'review-rule';
/** Values a set rule never replaces: explicit metadata and the user's own decisions. */
const KEEP = new Set(['sidecar', 'path', 'manifest', 'drive', 'role', 'user', 'ai-reviewed']);

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const FORMULA = /^[=+\-@\t\r]/;
function clean(v, max = 80) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || FORMULA.test(s) || /[<>]/.test(s)) return null;
  return s;
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('block','map','set')),
    field TEXT NOT NULL,
    match TEXT,
    value TEXT,
    creator TEXT,
    path TEXT,
    note TEXT,
    applied INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function shape(r) {
  return { id: r.id, kind: r.kind, field: r.field, match: r.match || null, value: r.value || null, creator: r.creator || null, path: r.path || null, note: r.note || null, applied: r.applied || 0, createdAt: r.created_at, label: describe(r) };
}

/** "Never propose 'X' as a genre (Wicked)" */
function describe(r) {
  const f = FIELD_LABEL[r.field] || r.field;
  const scope = [r.creator, r.path ? `in ${path.basename(r.path)}/` : null].filter(Boolean).join(', ');
  const tail = scope ? ` (${scope})` : '';
  if (r.kind === 'block') return `Never propose "${r.match}" as a ${f}${tail}`;
  if (r.kind === 'map') return `Use "${r.value}" when the AI says "${r.match}" (${f})${tail}`;
  return r.field === 'tags' ? `Tag every card${tail || ' (everywhere)'} "${r.value}"` : `Every card${tail || ''} has ${f} "${r.value}"`;
}

function listRules(db) {
  ensureTable(db);
  return db.prepare('SELECT * FROM review_rules ORDER BY id').all().map(shape);
}

/**
 * Validate and store a rule; same rule twice returns the existing one.
 * @param {{ kind, field, match?, value?, creator?, path?, note? }} b
 * @param {{ root?: string }} opts the library root a folder scope must sit under
 */
function createRule(db, b = {}, { root } = {}) {
  ensureTable(db);
  const kind = String(b.kind || '');
  if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const field = String(b.field || '');
  if (!FIELDS[kind].includes(field)) throw httpError(400, `a ${kind} rule works on ${FIELDS[kind].join(', ')}`);
  const lower = field === 'tags';
  const fix = (v) => { const c = clean(v); return c && lower ? c.toLowerCase() : c; };
  const match = kind === 'set' ? null : fix(b.match);
  const value = kind === 'block' ? null : fix(b.value);
  if (kind !== 'set' && !match) throw httpError(400, 'match (the value the AI proposes) is required');
  if (kind !== 'block' && !value) throw httpError(400, 'value is required');
  if (kind === 'map' && norm(match) === norm(value)) throw httpError(400, 'match and value are the same');
  const creator = clean(b.creator, 120);
  let dir = null;
  if (b.path) {
    dir = path.resolve(String(b.path));
    if (root && !(dir === path.resolve(root) || dir.startsWith(path.resolve(root) + path.sep))) throw httpError(400, 'path must be inside the library');
  }
  if (kind === 'set' && !creator && !dir) throw httpError(400, 'a set rule needs a creator or a folder (a library-wide value is not a rule)');
  const note = clean(b.note, 200);
  const same = db.prepare(`SELECT * FROM review_rules WHERE kind = ? AND field = ? AND COALESCE(match,'') = ? AND COALESCE(value,'') = ? AND COALESCE(creator,'') = ? AND COALESCE(path,'') = ?`)
    .get(kind, field, match || '', value || '', creator || '', dir || '');
  if (same) return shape(same);
  const id = db.prepare('INSERT INTO review_rules (kind, field, match, value, creator, path, note) VALUES (?,?,?,?,?,?,?)').run(kind, field, match, value, creator, dir, note).lastInsertRowid;
  return shape(db.prepare('SELECT * FROM review_rules WHERE id = ?').get(id));
}

/** Is a card ({ creator_name, folder_path }) inside the rule's scope? */
function inScope(rule, card) {
  if (rule.creator && norm(rule.creator) !== norm(card.creator_name)) return false;
  if (rule.path) {
    const real = worksLib.realFolder(card.folder_path || '');
    if (!(real === rule.path || real.startsWith(rule.path + path.sep))) return false;
  }
  return true;
}

/**
 * A proposed value seen through the rules for one card.
 * Scalars → { value, blocked, ruleIds }; tags (array) → { value: filtered/mapped array, blocked: [] removed, ruleIds }.
 */
function transform(rules, card, field, proposed) {
  const ruleIds = [];
  const applicable = rules.filter(r => r.field === field && inScope(r, card));
  if (field === 'tags') {
    const out = [], removed = [];
    for (const t of Array.isArray(proposed) ? proposed : [proposed]) {
      if (t == null) continue;
      const blk = applicable.find(r => r.kind === 'block' && norm(r.match) === norm(t));
      if (blk) { removed.push(t); ruleIds.push(blk.id); continue; }
      const mp = applicable.find(r => r.kind === 'map' && norm(r.match) === norm(t));
      const v = mp ? mp.value : t;
      if (mp) ruleIds.push(mp.id);
      if (!out.some(x => norm(x) === norm(v))) out.push(v);
    }
    return { value: out, blocked: removed, ruleIds };
  }
  // a set rule owns the field: the AI does not propose it for cards in scope
  const owner = applicable.find(r => r.kind === 'set');
  if (owner) return { value: proposed, blocked: true, ruleIds: [owner.id], owner };
  const blk = applicable.find(r => r.kind === 'block' && norm(r.match) === norm(proposed));
  if (blk) return { value: proposed, blocked: true, ruleIds: [blk.id] };
  const mp = applicable.find(r => r.kind === 'map' && norm(r.match) === norm(proposed));
  if (mp) return { value: mp.value, blocked: false, ruleIds: [mp.id] };
  return { value: proposed, blocked: false, ruleIds };
}

/**
 * Apply rules to one validated Enrich answer (lib/enrich.js validateResponse item), in place.
 * Blocked fields are dropped; mapped ones rewritten. Returns the ids of the rules used.
 */
function transformAnswer(rules, card, ans) {
  const used = new Set();
  if (!rules || !rules.length || !ans) return used;
  for (const f of ['character', 'franchise', 'group_name', 'tags', 'name']) {
    const a = ans[f];
    if (!a) continue;
    const t = transform(rules, card, f, a.v);
    t.ruleIds.forEach(id => used.add(id));
    if (f === 'tags') { if (!t.value.length) delete ans[f]; else a.v = t.value; continue; }
    if (t.blocked) delete ans[f]; else a.v = t.value;
  }
  return used;
}

/** Prompt lines for the AI (house style), at most `max` rules. */
function promptLines(rules, max = 40) {
  return (rules || []).slice(0, max).map(r => `- ${describe(r)}`);
}

const CARD_COLS = `m.id, m.name, m.folder_path, m.character, m.franchise, m.group_name, m.tags, m.attribution, c.name AS creator_name`;

function provOf(card, f) {
  const attr = parseJSON(card.attribution, {});
  if ((Array.isArray(attr.userFields) ? attr.userFields : []).includes(f)) return 'user';
  return (attr.fields || {})[f] || null;
}

/** Cards in a rule's scope (visible ones). */
function cardsInScope(db, rule) {
  const where = ['m.folded_into IS NULL', 'COALESCE(m.hidden, 0) = 0'], params = [];
  if (rule.creator) { where.push('LOWER(c.name) = LOWER(?)'); params.push(rule.creator); }
  if (rule.path) { where.push(`(m.folder_path = ? OR m.folder_path LIKE ? ESCAPE '\\' OR m.folder_path LIKE ? ESCAPE '\\')`); const e = rule.path.replace(/[\\%_]/g, '\\$&'); params.push(rule.path, `${e}/%`, `${e}#%`); }
  return db.prepare(`SELECT ${CARD_COLS} FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE ${where.join(' AND ')}`).all(...params).filter(c => inScope(rule, c));
}

/** Write a set rule's value to the cards in scope. Returns how many cards changed. */
function applySetRule(db, rule) {
  let n = 0;
  const f = rule.field;
  for (const card of cardsInScope(db, rule)) {
    const prov = provOf(card, f);
    if (KEEP.has(prov)) continue;
    const attr = parseJSON(card.attribution, {});
    const removed = new Set((Array.isArray(attr.removedTags) ? attr.removedTags : []).map(norm));
    let next;
    if (f === 'tags') {
      const have = parseJSON(card.tags, []);
      if (removed.has(norm(rule.value)) || have.some(t => norm(t) === norm(rule.value))) continue;
      next = JSON.stringify([...have, rule.value]);
    } else {
      if (norm(card[COLUMNS[f]]) === norm(rule.value) && prov === PROV) continue;
      next = rule.value;
    }
    attr.fields = { ...(attr.fields || {}) };
    if (f !== 'tags') attr.fields[f] = PROV;
    if (attr.ai && f !== 'tags') { delete attr.ai[f]; if (!Object.keys(attr.ai).length) delete attr.ai; }
    attr.rules = { ...(attr.rules || {}), [f]: rule.id };
    db.prepare(`UPDATE models SET ${COLUMNS[f]} = ?, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(next, JSON.stringify(attr), card.id);
    n++;
  }
  return n;
}

/**
 * Run every rule over the pending review list (and set rules over their cards).
 * @returns {{ rejected, rewritten, superseded, cardsSet }}
 */
function applyRules(db, { rules: given } = {}) {
  ensureTable(db);
  const rules = given || db.prepare('SELECT * FROM review_rules ORDER BY id').all();
  const res = { rejected: 0, rewritten: 0, superseded: 0, cardsSet: 0 };
  if (!rules.length) return res;
  const used = new Map();
  const bump = (ids, k = 1) => ids.forEach(id => used.set(id, (used.get(id) || 0) + k));
  db.transaction(() => {
    for (const r of rules.filter(x => x.kind === 'set')) { const n = applySetRule(db, r); res.cardsSet += n; bump([r.id], n); }
    const pend = db.prepare(`SELECT s.id, s.type, s.field, s.current, s.proposed, m.id AS model_id, m.name, m.folder_path, m.character, m.franchise, m.group_name, m.tags, c.name AS creator_name FROM suggestions s JOIN models m ON m.id = s.model_id LEFT JOIN creators c ON c.id = m.creator_id
      WHERE s.status = 'pending' AND s.type IN ('field', 'rename')`).all();
    const reject = db.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = datetime('now'), reason = ? WHERE id = ?`);
    const supersede = db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id = ?`);
    const rewrite = db.prepare('UPDATE suggestions SET proposed = ?, reason = ? WHERE id = ?');
    for (const s of pend) {
      const f = s.field;
      const proposed = parseJSON(s.proposed, s.proposed);
      const t = transform(rules, s, f, proposed);
      if (!t.ruleIds.length) continue;
      bump(t.ruleIds);
      const why = `rule: ${describe(rules.find(r => r.id === t.ruleIds[0]))}`.slice(0, 300);
      if (f === 'tags') {
        if (!t.value.length) { if (t.blocked.length) { reject.run(why, s.id); res.rejected++; } else { supersede.run(s.id); res.superseded++; } continue; }
        const have = parseJSON(s.tags, []).map(norm);
        const left = t.value.filter(v => !have.includes(norm(v)));
        if (!left.length) { supersede.run(s.id); res.superseded++; continue; }
        if (JSON.stringify(left) !== JSON.stringify(proposed)) { rewrite.run(JSON.stringify(left), why, s.id); res.rewritten++; }
        continue;
      }
      if (t.owner) { supersede.run(s.id); res.superseded++; continue; }
      if (t.blocked) { reject.run(why, s.id); res.rejected++; continue; }
      if (norm(t.value) !== norm(proposed)) {
        // the card already has the mapped value: nothing left to propose
        if (norm(s[f === 'name' ? 'name' : COLUMNS[f]]) === norm(t.value)) { supersede.run(s.id); res.superseded++; continue; }
        // another pending proposal for the card already says the same
        rewrite.run(JSON.stringify(t.value), why, s.id); res.rewritten++;
      }
    }
    const upd = db.prepare('UPDATE review_rules SET applied = applied + ? WHERE id = ?');
    for (const [id, n] of used) if (n) upd.run(n, id);
  })();
  return res;
}

/**
 * Remove a rule. `revert` (set rules) clears the values it wrote that nobody changed since.
 * @returns {{ id, reverted }}
 */
function deleteRule(db, id, { revert = false } = {}) {
  ensureTable(db);
  const r = db.prepare('SELECT * FROM review_rules WHERE id = ?').get(id);
  if (!r) throw httpError(404, 'Rule not found');
  let reverted = 0;
  db.transaction(() => {
    if (revert && r.kind === 'set') {
      const f = r.field;
      const rows = db.prepare(`SELECT id, tags, ${COLUMNS[f]} AS v, attribution FROM models WHERE attribution LIKE ?`).all(`%"rules"%`);
      for (const m of rows) {
        const attr = parseJSON(m.attribution, {});
        if (!attr.rules || attr.rules[f] !== r.id) continue;
        delete attr.rules[f];
        if (!Object.keys(attr.rules).length) delete attr.rules;
        let next;
        if (f === 'tags') {
          next = JSON.stringify(parseJSON(m.tags, []).filter(t => norm(t) !== norm(r.value)));
        } else {
          if ((attr.fields || {})[f] !== PROV || norm(m.v) !== norm(r.value)) { db.prepare('UPDATE models SET attribution = ? WHERE id = ?').run(JSON.stringify(attr), m.id); continue; }
          delete attr.fields[f];
          next = null;
        }
        db.prepare(`UPDATE models SET ${COLUMNS[f]} = ?, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(next, JSON.stringify(attr), m.id);
        reverted++;
      }
    }
    db.prepare('DELETE FROM review_rules WHERE id = ?').run(id);
  })();
  return { id, reverted };
}

function loadRules(db) {
  try { ensureTable(db); return db.prepare('SELECT * FROM review_rules ORDER BY id').all(); } catch { return []; }
}

module.exports = {
  KINDS, FIELDS, PROV, ensureTable, listRules, createRule, deleteRule, applyRules, applySetRule, transform, transformAnswer,
  promptLines, describe, inScope, loadRules,
};
