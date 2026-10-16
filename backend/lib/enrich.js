'use strict';
/**
 * lib/enrich.js — AI enrichment (docs/ai-enrichment.md).
 *
 * A cheap text pass fills structured fields (character, genre, group, editions, tags), proposes
 * renames and same-character merges, and records everything it does:
 *
 *   selectCards()      candidates by scope, with the evidence signature that lets re-runs skip
 *                      unchanged cards (models.enrichment.sig)
 *   buildEvidence()    the compact JSON sent per card (§3)
 *   systemPrompt()     genres, groups in use, the organizer's typo rules, the output contract
 *   validateResponse() strict per-item JSON validation (unknown ids, bad confidences, bad types)
 *   planActions()      the apply policy + protection rules (§2): empty + high confidence → write,
 *                      anything else worth showing → the review list
 *   runEnrich()        batches of 40, optional vision fallback, enrich_log for undo
 *   decide()/undoRun() the review list and per-run undo
 *   estimate()         token and USD estimate from the real evidence sizes
 *
 * The Claude client is injected (lib/claude.js callClaudeAPI by default; ENRICH_FAKE=1 swaps in
 * tests/fixtures/enrich-fake.js, a dev-only stand-in so the UI can be demoed without a key).
 */
const crypto = require('crypto');
const path = require('path');
const naming = require('./naming');
const similar = require('./similar');
const worksLib = require('./works');
const { foldInto } = require('./fold');

const PROMPT_VERSION = 'enrich-v1';
const BATCH_SIZE = 40;
const TAG_CAP = 12;
const EDITIONS = ['Sculpture', 'Bust', 'Accessory', 'Diorama'];
const TEXT_FIELDS = ['character', 'franchise', 'group_name', 'editions', 'name', 'tags'];
const COLUMNS = { character: 'character', franchise: 'franchise', group_name: 'group_name', editions: 'editions', name: 'name', tags: 'tags' };
/** Provenances never overwritten automatically (§2): model.json, the genre folder, the creator's manifest, organizer rules, Drive. */
const PROTECTED = new Set(['sidecar', 'path', 'manifest', 'rules', 'drive', 'user', 'ai-reviewed']);
/** …and these are not even proposed again: explicit metadata, or a value the user set or accepted. */
const NO_SUGGEST = new Set(['sidecar', 'user', 'ai-reviewed']);
const CHARS_PER_TOKEN = 3.5;        // compact JSON with names; measured ≈3.3-3.8 on real evidence
const OUT_TOKENS_PER_ITEM = 70;     // answer item: the fake model's compact JSON is ~44 tokens on real cards; real answers add reasons and spacing
const IMAGE_TOKENS = 1600;          // one render, Claude caps images near 1.15 MP ≈ 1,600 tokens
const VISION_OUT_TOKENS = 110;

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
/** "Wicked|work|daredevil|r:2026-03" → { base: "Wicked|work|daredevil", release: "2026-03" } */
function releaseOf(workKey) {
  const k = String(workKey || '');
  const i = k.indexOf('|r:');
  return i === -1 ? { base: k || null, release: null } : { base: k.slice(0, i), release: k.slice(i + 3) };
}
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const round2 = (n) => Math.round(n * 100) / 100;

function thresholds() {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d; };
  return { auto: num(process.env.ENRICH_AUTO_MIN, 0.8), suggest: num(process.env.ENRICH_SUGGEST_MIN, 0.5) };
}

function fakeEnabled() { return process.env.ENRICH_FAKE === '1'; }

/** The Claude client: callClaudeAPI(apiKey, body, { timeoutMs, signal }) → API JSON. */
function getClient(log = () => {}) {
  if (fakeEnabled()) {
    log('warn', '⚠ ENRICH_FAKE=1: answers come from the dev fake model (tests/fixtures/enrich-fake.js), NOT from Claude. Never use this in production.');
    // eslint-disable-next-line global-require
    return require('../tests/fixtures/enrich-fake').callClaudeAPI;
  }
  // resolved per call so tests can jest.mock('../lib/claude')
  // eslint-disable-next-line global-require
  return (...args) => require('./claude').callClaudeAPI(...args);
}

// ── candidates ───────────────────────────────────────────────────────────────

const CARD_SQL = `
  SELECT m.id, m.name, COALESCE(m.kind, 'model') AS kind, m.creator_id, c.name AS creator_name, c.folder_path AS creator_folder,
         m.studio, m.library, m.libraries, m.folder_path, m.character, m.franchise, m.group_name, m.editions, m.tags,
         m.name_locked, m.attribution, m.products, m.release_term, m.release_label, m.confidence, m.thumbnail_path,
         m.enrichment, m.work_key, m.has_chitubox, m.has_lychee, m.updated_at
  FROM models m LEFT JOIN creators c ON c.id = m.creator_id
  WHERE (m.hidden IS NULL OR m.hidden = 0) AND m.folded_into IS NULL AND COALESCE(m.kind, 'model') != 'tool'`;

/** Scope → SQL. scope: all | unattributed | creator | ids (ids also works with any scope). */
function scopeWhere({ scope = 'all', creator, ids } = {}) {
  const where = [], params = [];
  if (scope === 'unattributed') where.push(`(m.confidence IS NULL OR m.confidence IN ('none','path'))`);
  if ((scope === 'creator' || creator) && creator) {
    if (/^\d+$/.test(String(creator))) { where.push('m.creator_id = ?'); params.push(Number(creator)); }
    else { where.push('c.name = ?'); params.push(String(creator)); }
  }
  const idList = Array.isArray(ids) ? ids : String(ids || '').split(',');
  const nums = idList.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (scope === 'ids' || nums.length) {
    if (!nums.length) where.push('0');
    else { where.push(`m.id IN (${nums.map(() => '?').join(',')})`); params.push(...nums); }
  }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

function filesByModel(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT model_id, filename FROM model_files WHERE model_id IN (${part.map(() => '?').join(',')})`).all(...part)) {
      if (!out.has(r.model_id)) out.set(r.model_id, []);
      out.get(r.model_id).push(r.filename);
    }
  }
  return out;
}

/**
 * Key used for near-duplicate detection (variant words and numbers stripped). Display names only:
 * they change through user renames, not automatic writes, so other cards' evidence stays stable.
 */
function charKey(card, prefix) {
  return similar.normalizeForSimilarity(card.name, card.creator_name, prefix) || norm(card.name);
}

/**
 * Up to 5 local near-duplicate character names of the same creator per card (merge candidates):
 * the same key, a typo away (Geral/Geralt, Doct Oct/Doc Ock), or one name inside the other
 * (Poison / Poison Ivy, Jay Garrick / Flash Jay Garrick).
 * @param {object[]} cards every visible card of the creators involved
 * @returns {Map<number, {id:number, name:string, score:number}[]>}
 */
function nearDuplicates(cards) {
  const prefixes = similar.creatorPrefixes(cards);
  const byCreator = new Map();
  for (const c of cards) {
    const k = charKey(c, prefixes.get(c.creator_id ?? c.creator_name ?? ''));
    if (!k) continue;
    const toks = k.split(' ').filter(Boolean);
    const entry = { c, k, compact: k.replace(/ /g, ''), toks: new Set(toks) };
    if (!byCreator.has(c.creator_id)) byCreator.set(c.creator_id, []);
    byCreator.get(c.creator_id).push(entry);
  }
  const out = new Map();
  for (const list of byCreator.values()) {
    const index = new Map(); // token / 3-char prefix → entries
    const add = (key, e) => { if (!index.has(key)) index.set(key, []); index.get(key).push(e); };
    for (const e of list) {
      for (const t of e.toks) if (t.length >= 3) add(`t:${t}`, e);
      if (e.compact.length >= 3) add(`p:${e.compact.slice(0, 3)}`, e);
    }
    for (const e of list) {
      const pool = new Set();
      for (const t of e.toks) if (t.length >= 3) for (const x of index.get(`t:${t}`) || []) pool.add(x);
      for (const x of index.get(`p:${e.compact.slice(0, 3)}`) || []) pool.add(x);
      const scored = [];
      for (const x of pool) {
        if (x === e) continue;
        // two releases of one character are not duplicates (Daredevil 2025 vs Daredevil Netflix)
        const rx = releaseOf(x.c.work_key), re = releaseOf(e.c.work_key);
        if ((rx.release || re.release) && rx.release !== re.release) continue;
        let score = 0;
        if (x.compact === e.compact) score = 1;
        else {
          const [small, big] = x.toks.size <= e.toks.size ? [x, e] : [e, x];
          const subset = small.toks.size && [...small.toks].every(t => big.toks.has(t)) && [...small.toks].some(t => t.length >= 4);
          if (subset) score = 0.8 + 0.1 * (small.compact.length / big.compact.length);
          else {
            const maxLen = Math.max(x.compact.length, e.compact.length);
            if (maxLen >= 5) {
              const d = similar.boundedLevenshtein(x.compact, e.compact, Math.max(1, Math.floor(maxLen * 0.3)));
              if (d !== Infinity) score = 1 - d / maxLen;
            }
          }
        }
        if (score >= 0.7) scored.push({ id: x.c.id, name: x.c.name, score: round2(score) });
      }
      scored.sort((a, b) => b.score - a.score || a.id - b.id);
      if (scored.length) out.set(e.c.id, scored.slice(0, 5));
    }
  }
  return out;
}

// ── evidence ─────────────────────────────────────────────────────────────────

const VARIANT_PAREN = /\s*[([][^)\]]*(?:support|piece|pose|image|render|info|stl|chitubox|lychee|lys|hollow|solid|fdm|resin|scale)[^)\]]*[)\]]/gi;
const IMAGE_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/i;

/** Up to 8 distinct file-name stems, variants stripped ("B3DSERK - Alan Scott Bust 390mm"). */
function fileStems(files, fix) {
  const seen = new Set(), named = [], plain = [];
  for (const f of files || []) {
    if (IMAGE_RE.test(f)) continue;
    const stem = naming.cleanStem(String(f).replace(/\.[a-z0-9]{1,8}$/i, '')).replace(VARIANT_PAREN, '')
      .replace(/[\s_-]+(?:pre[\s_-]?)?supported$|[\s_-]+unsupported$|[\s_-]+(?:no[\s_-]?)?supports?$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!stem) continue;
    const p = naming.parseName(stem, { fix });
    const label = (p.generic ? stem : [p.creator && p.prefixed ? p.creator : null, p.character, p.edition].filter(Boolean).join(' ')) || stem;
    const k = norm(label);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    (p.generic ? plain : named).push(label.slice(0, 60));
  }
  return [...named, ...plain].slice(0, 8);
}

/** Path segments below the creator's folder ("DC", "Lanterns", "Star Sapphire"). */
function pathSegments(card, libraryRoot) {
  const real = worksLib.realFolder(card.folder_path || '');
  let rel = null;
  if (card.creator_folder && (real === card.creator_folder || real.startsWith(card.creator_folder + path.sep))) rel = path.relative(card.creator_folder, real);
  else if (libraryRoot && real.startsWith(libraryRoot + path.sep)) rel = path.relative(libraryRoot, real).split(path.sep).slice(2).join(path.sep);
  else rel = path.basename(real);
  return String(rel || '').split(path.sep).filter(Boolean).slice(-6).map(s => s.slice(0, 60));
}

/**
 * Compact evidence for one card (§3). `prov` per field: user | sidecar | path | manifest | drive |
 * rules | parse | ai | ai-reviewed | scan. Keys with no value are left out to save tokens.
 */
function buildEvidence(card, files, ctx = {}) {
  const attr = parseJSON(card.attribution, {});
  const fields = attr.fields || {};
  const user = new Set(Array.isArray(attr.userFields) ? attr.userFields : []);
  const prov = (f) => (user.has(f) ? 'user' : fields[f] || 'scan');
  const cur = { name: card.name };
  for (const f of ['character', 'franchise', 'group_name']) if (!empty(card[f])) cur[f] = [card[f], prov(f)];
  const eds = parseJSON(card.editions, []);
  if (eds.length) cur.editions = eds;
  const tags = parseJSON(card.tags, []);
  if (tags.length) cur.tags = tags.slice(0, TAG_CAP);
  const ev = { id: card.id, kind: card.kind || 'model', creator: card.creator_name || null };
  if (card.studio && card.studio !== card.creator_name) ev.studio = card.studio;
  if (card.library) ev.lib = card.library;
  ev.cur = cur;
  const segs = pathSegments(card, ctx.libraryRoot);
  if (segs.length) ev.path = segs;
  const stems = fileStems(files, ctx.fix);
  if (stems.length) ev.files = stems;
  const prods = parseJSON(card.products, []).map(p => p && p.name).filter(Boolean);
  if (prods.length) ev.products = [...new Set(prods)].slice(0, 4).map(s => s.slice(0, 90));
  const terms = new Set();
  if (card.release_term || card.release_label) terms.add([card.release_term, card.release_label].filter(Boolean).join(' '));
  for (const p of parseJSON(card.products, [])) if (p && p.termLabel) terms.add(p.termLabel);
  if (terms.size) ev.terms = [...terms].slice(0, 3);
  const conflicts = Array.isArray(attr.conflicts) ? attr.conflicts : [];
  if (conflicts.length) {
    ev.conflicts = conflicts.slice(0, 3).map(c => (typeof c === 'string' ? c
      : `${c.field}: ${Object.entries(c).filter(([k]) => k !== 'field').map(([k, v]) => `${k.replace(/Value$/, '')}=${v}`).join(', ')}`).slice(0, 90));
  }
  const sim = ctx.similar && ctx.similar.get(card.id);
  if (sim && sim.length) ev.similar = sim.map(s => ({ id: s.id, name: s.name }));
  const rel = releaseOf(card.work_key);
  if (rel.release) {
    ev.release = rel.release;
    const sib = ctx.siblings && ctx.siblings.get(rel.base);
    const others = (sib || []).filter(s => s.id !== card.id).map(s => s.name);
    if (others.length) ev.siblings = others.slice(0, 5);
  }
  return ev;
}

function evidenceSig(ev, mode = 'full') {
  return crypto.createHash('sha1').update(`${PROMPT_VERSION}|${mode}|${JSON.stringify(ev)}`).digest('hex').slice(0, 16);
}

/**
 * Cards for a run or an estimate, their evidence, and which can be skipped as unchanged.
 * @returns {{ cards: object[], skipped: number, total: number }} cards carry .ev and .sig
 */
function selectCards(db, opts = {}, ctx = {}) {
  const { sql, params } = scopeWhere(opts);
  const rows = db.prepare(`${CARD_SQL}${sql} ORDER BY c.name, m.name`).all(...params);
  const mode = opts.tagsOnly ? 'tags' : 'full';
  if (!rows.length) return { cards: [], skipped: 0, total: 0 };
  // near-duplicates are looked for among ALL visible cards of the creators in scope
  const creatorIds = [...new Set(rows.map(r => r.creator_id).filter(v => v != null))];
  let pool = rows;
  if (creatorIds.length) {
    pool = [];
    for (let i = 0; i < creatorIds.length; i += 500) {
      const part = creatorIds.slice(i, i + 500);
      pool.push(...db.prepare(`${CARD_SQL} AND m.creator_id IN (${part.map(() => '?').join(',')})`).all(...part));
    }
  }
  const sim = opts.tagsOnly ? new Map() : nearDuplicates(pool);
  const files = filesByModel(db, rows.map(r => r.id));
  const siblings = new Map(); // base work_key → release cards
  for (const c of pool) {
    const r = releaseOf(c.work_key);
    if (!r.release) continue;
    if (!siblings.has(r.base)) siblings.set(r.base, []);
    siblings.get(r.base).push({ id: c.id, name: c.name });
  }
  const evCtx = { ...ctx, similar: sim, siblings };
  const cards = [];
  let skipped = 0;
  for (const r of rows) {
    r.ev = buildEvidence(r, files.get(r.id) || [], evCtx);
    r.sig = evidenceSig(r.ev, mode);
    const prev = parseJSON(r.enrichment, {});
    if (!opts.force && (mode === 'tags' ? prev.tagsSig : prev.sig) === r.sig) { skipped++; continue; }
    cards.push(r);
  }
  return { cards, skipped, total: rows.length };
}

// ── prompt ───────────────────────────────────────────────────────────────────

/**
 * Prompt context: known genres, the groups already used per genre, and the organizer's typo rules.
 * @param {object} db
 * @param {{ rules?: object, genreMap?: object }} metaSummary
 */
function promptContext(db, metaSummary = {}) {
  const genres = new Set(naming.GENRES);
  for (const r of db.prepare(`SELECT franchise, COUNT(*) n FROM models WHERE franchise IS NOT NULL AND franchise != '' AND folded_into IS NULL GROUP BY franchise HAVING n >= 3`).all()) genres.add(r.franchise);
  for (const g of Object.values(metaSummary.genreMap || {})) genres.add(g);
  for (const g of Object.values((metaSummary.rules || {}).genre || {})) genres.add(g);
  const groups = {};
  for (const r of db.prepare(`SELECT franchise, group_name, COUNT(*) n FROM models WHERE group_name IS NOT NULL AND group_name != '' AND franchise IS NOT NULL AND folded_into IS NULL GROUP BY franchise, group_name ORDER BY n DESC`).all()) {
    if (!groups[r.franchise]) groups[r.franchise] = [];
    if (groups[r.franchise].length < 15) groups[r.franchise].push(r.group_name);
  }
  const fixes = Object.entries((metaSummary.rules || {}).fix || {}).slice(0, 40).map(([a, b]) => `${a}→${b}`);
  return { genres: [...genres], groups, fixes };
}

function systemPrompt(pc, { tagsOnly = false } = {}) {
  const groupLines = Object.entries(pc.groups || {}).map(([g, list]) => `- ${g}: ${list.join(', ')}`).join('\n');
  return `You catalogue "The Vault", a library of 3D-printable models (statues, busts, dioramas, tabletop miniatures).
For each card you get compact JSON evidence: id, kind (work = one character's sculpture/bust, diorama, release-item = one item of a monthly pack, model = a folder), creator, current values with provenance (cur.<field> = [value, provenance]), folder segments below the creator (path), file-name stems (files), matched store products, release terms, attribution conflicts, and near-duplicate cards of the same creator (similar).

Return ONLY a JSON array, one object per card, no prose:
{"id":<card id>,
 "character":{"v":"canonical public name","c":0.0-1.0},
 "franchise":{"v":"genre","c":..},
 "group_name":{"v":"sub-franchise or team","c":..},
 "editions":{"v":["Sculpture"|"Bust"|"Accessory"|"Diorama"],"c":..},
 "name":{"v":"better display name","c":..},
 "tags":{"v":["theme:...","type:...","scale:...","tech:...", "plain tag"],"c":..},
 "merge":{"into":<id from similar>,"c":..},
 "needs_vision":true|false,
 "why":"one short reason"}
Rules:
- Leave out a field when you have nothing to add or it is already right. Never echo current values.
- c is your confidence that the value is correct (0-1). Use >= 0.9 only when the evidence is unambiguous.
- character: the canonical public name ("Ra's al Ghul", "Doctor Octopus"), not a file name; skip it for generic items (terrain, packs, bases).
- franchise is the genre. Prefer one of: ${pc.genres.join('; ')}. A new genre is allowed but rare.
- group_name: team or sub-franchise inside the genre (X-Men, Justice League, Jurassic Park). Groups in use:
${groupLines || '- (none yet)'}
- editions: only when cur.editions is missing.
- name: only when the current name is broken (typo, store prefix, "Term", "for", stray numbers).
- tags: up to 6 lowercase theme/descriptive tags; facets type:, theme:, scale:, tech: are welcome. No creator names, no genre names.
- merge: only when this card and a "similar" card are the SAME character and edition set from the same creator (a typo or a split folder). Point to the better-named card. Different versions (1966 vs 1989, Zombie, Red Son) are NOT merges.
- release / siblings: the creator released this character more than once; each release is its own card ("Daredevil (2025)", "Daredevil (Netflix)"). Never merge releases, never rename the "(…)" part away, and keep the character the same across siblings.
- needs_vision: true when only the render could tell what this is.
- Known typo fixes: ${(pc.fixes || []).join(', ') || 'none'}.${tagsOnly ? '\nThis run only uses "tags"; other fields may be left out.' : ''}`;
}

function userPrompt(evs) {
  return `Cards (${evs.length}):\n${evs.map(e => JSON.stringify(e)).join('\n')}`;
}

// ── response validation ──────────────────────────────────────────────────────

function extractJSON(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  const o = t.indexOf('{'), p = t.lastIndexOf('}');
  const cands = [];
  if (a !== -1 && b > a) cands.push(t.slice(a, b + 1));
  if (o !== -1 && p > o) cands.push(t.slice(o, p + 1));
  for (const c of cands) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  throw new Error('response is not valid JSON');
}

const cleanStr = (v, max = 80) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim().replace(/\s+/g, ' ') : null);

/**
 * Validate a batch answer. Never throws for item-level problems; they are reported in `errors`.
 * @param {string} text model output
 * @param {Map<number, object>|Set<number>} batch ids sent (Map id → evidence to check merge targets)
 * @returns {{ items: Map<number, object>, errors: string[] }}
 */
function validateResponse(text, batch) {
  const errors = [];
  const items = new Map();
  let data;
  try { data = extractJSON(text); } catch (e) { return { items, errors: [`malformed JSON: ${e.message}`], fatal: true }; }
  if (!Array.isArray(data)) data = data && Array.isArray(data.items) ? data.items : (data && typeof data === 'object' && data.id != null ? [data] : null);
  if (!data) return { items, errors: ['expected a JSON array of items'], fatal: true };
  const ids = batch instanceof Map ? batch : new Map([...batch].map(id => [id, null]));
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') { errors.push('item is not an object'); continue; }
    const id = Number(raw.id);
    if (!ids.has(id)) { errors.push(`unknown id ${raw.id}`); continue; }
    if (items.has(id)) { errors.push(`duplicate id ${id}`); continue; }
    const out = { id };
    for (const f of TEXT_FIELDS) {
      if (raw[f] == null) continue;
      const fv = raw[f];
      const c = fv && typeof fv === 'object' ? Number(fv.c ?? fv.confidence) : NaN;
      if (!Number.isFinite(c) || c < 0 || c > 1) { errors.push(`${id}.${f}: confidence out of range (${fv && (fv.c ?? fv.confidence)})`); continue; }
      const v = fv.v ?? fv.value;
      let val = null;
      if (f === 'editions') {
        const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
        const mapped = arr.map(x => EDITIONS.find(e => e.toLowerCase() === String(x).trim().toLowerCase().replace(/^accessories$/, 'accessory')));
        if (arr.length && mapped.every(Boolean)) val = EDITIONS.filter(e => mapped.includes(e));
      } else if (f === 'tags') {
        const arr = Array.isArray(v) ? v : [];
        const tags = [...new Set(arr.map(x => (typeof x === 'string' ? x.trim().toLowerCase().replace(/\s+/g, ' ') : '')).filter(x => x && x.length <= 40))];
        if (tags.length) val = tags.slice(0, TAG_CAP);
      } else val = cleanStr(v, f === 'name' ? 100 : 80);
      if (val == null) { errors.push(`${id}.${f}: invalid value`); continue; }
      out[f] = { v: val, c };
    }
    if (raw.merge != null) {
      const into = Number(raw.merge.into ?? raw.merge.target);
      const c = Number(raw.merge.c ?? raw.merge.confidence);
      const ev = ids.get(id);
      const allowed = ev ? Array.isArray(ev.similar) && ev.similar.some(s => s.id === into) : ids.has(into);
      if (!Number.isInteger(into) || into === id || !allowed) errors.push(`${id}.merge: target ${raw.merge.into} is not one of its similar cards`);
      else if (!Number.isFinite(c) || c < 0 || c > 1) errors.push(`${id}.merge: confidence out of range`);
      else out.merge = { into, c };
    }
    if (raw.needs_vision === true) out.needs_vision = true;
    const why = cleanStr(raw.why ?? raw.reason, 300);
    if (why) out.why = why;
    items.set(id, out);
  }
  return { items, errors };
}

// ── policy ───────────────────────────────────────────────────────────────────

/** Current value + provenance of a field on a card row. */
function fieldState(card, f) {
  const attr = parseJSON(card.attribution, {});
  const user = new Set(Array.isArray(attr.userFields) ? attr.userFields : []);
  let value = card[COLUMNS[f]];
  if (f === 'editions' || f === 'tags') value = parseJSON(value, []);
  let prov = user.has(f) ? 'user' : (attr.fields || {})[f] || null;
  if (f === 'name' && card.name_locked) prov = 'user';
  return { value, prov };
}

const sameValue = (a, b) => (Array.isArray(a) || Array.isArray(b)
  ? JSON.stringify([...(a || [])].map(norm).sort()) === JSON.stringify([...(b || [])].map(norm).sort())
  : norm(a) === norm(b));

/**
 * The apply policy (§2) for one validated answer.
 * @param {object} card row from selectCards (with attribution etc.)
 * @param {object} ans validated item
 * @param {{ auto:number, suggest:number, isKnownGenre:(g)=>boolean, rejected:(type, field, proposed, targetId)=>boolean, tagsOnly?:boolean, source?:string }} ctx
 * @returns {{ apply: {field, value, c}[], suggest: object[] }}
 */
function planActions(card, ans, ctx) {
  const apply = [], suggest = [];
  const source = ctx.source || 'text';
  const why = ans.why || null;
  const fields = ctx.tagsOnly ? ['tags'] : ['character', 'franchise', 'group_name', 'editions', 'name', 'tags'];
  for (const f of fields) {
    const a = ans[f];
    if (!a) continue;
    const { value: cur, prov } = fieldState(card, f);
    if (f === 'tags') {
      const have = new Set((cur || []).map(norm));
      const add = a.v.filter(t => !have.has(norm(t))).slice(0, Math.max(0, TAG_CAP - (cur || []).length));
      if (!add.length) continue;
      const min = ctx.tagsOnly ? ctx.suggest : ctx.auto; // generate-tags clients expect tags applied
      if (a.c >= min) apply.push({ field: 'tags', value: [...(cur || []), ...add], added: add, c: a.c });
      else if (a.c >= ctx.suggest && !ctx.rejected('field', 'tags', JSON.stringify(add))) suggest.push({ type: 'field', field: 'tags', current: cur || [], proposed: add, confidence: a.c, reason: why, source });
      continue;
    }
    if (f === 'name' ? String(cur || '').trim() === a.v : sameValue(cur, a.v)) continue;
    if (NO_SUGGEST.has(prov)) continue; // model.json, the user's own value or one they accepted
    if (f === 'name') {
      if (a.c >= ctx.suggest && !ctx.rejected('rename', 'name', a.v)) suggest.push({ type: 'rename', field: 'name', current: card.name, proposed: a.v, confidence: a.c, reason: why, source });
      continue;
    }
    if (f === 'editions' && !empty(cur)) continue; // only proposed when parsing found none
    const isNewGenre = f === 'franchise' && !ctx.isKnownGenre(a.v);
    if (empty(cur) && a.c >= ctx.auto && !PROTECTED.has(prov) && !isNewGenre) apply.push({ field: f, value: a.v, c: a.c });
    else if (a.c >= ctx.suggest && !ctx.rejected('field', f, f === 'editions' ? JSON.stringify(a.v) : a.v)) {
      suggest.push({ type: 'field', field: f, current: cur, proposed: a.v, confidence: a.c, reason: why || (isNewGenre ? 'new genre' : null), source });
    }
  }
  if (!ctx.tagsOnly && ans.merge && ans.merge.c >= ctx.suggest && !ctx.rejected('merge', null, null, ans.merge.into)) {
    suggest.push({ type: 'merge', field: null, current: null, proposed: null, targetId: ans.merge.into, confidence: ans.merge.c, reason: why, source });
  }
  return { apply, suggest };
}

/** Text answer weak on character/genre where the card has neither (§4) → a render may help. */
function wantsVision(card, ans, suggestMin) {
  if (ans && ans.needs_vision) return true;
  return ['character', 'franchise'].some(f => empty(fieldState(card, f).value) && !(ans && ans[f] && ans[f].c >= suggestMin));
}

/** Combine a text and a vision answer: per field the more confident one wins. */
function combineAnswers(text, vision) {
  if (!vision) return { ans: text, sources: {} };
  const out = { ...(text || {}), id: (text || vision).id };
  const sources = {};
  for (const f of [...TEXT_FIELDS, 'merge']) {
    const v = vision[f];
    if (v && (!out[f] || v.c > out[f].c)) { out[f] = v; sources[f] = 'vision'; }
  }
  if (vision.why) out.why = vision.why;
  delete out.needs_vision;
  return { ans: out, sources };
}

// ── writes ───────────────────────────────────────────────────────────────────

function setAttrField(attr, f, prov, c) {
  attr.fields = { ...(attr.fields || {}) };
  if (prov) attr.fields[f] = prov; else delete attr.fields[f];
  if (prov === 'ai' && c != null) attr.ai = { ...(attr.ai || {}), [f]: round2(c) };
  else if (attr.ai) { delete attr.ai[f]; if (!Object.keys(attr.ai).length) delete attr.ai; }
  return attr;
}

const toColumn = (f, v) => (f === 'editions' || f === 'tags' ? JSON.stringify(v || []) : (empty(v) ? null : v));

/** Write one field automatically (provenance "ai") and log it for undo. */
function applyAuto(db, card, act, runId) {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(card.id);
  const { value: old, prov } = fieldState(row, act.field);
  const attr = setAttrField(parseJSON(row.attribution, {}), act.field, act.field === 'tags' ? (prov || 'ai') : 'ai', act.field === 'tags' ? null : act.c);
  db.prepare(`UPDATE models SET ${COLUMNS[act.field]} = ?, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(toColumn(act.field, act.value), JSON.stringify(attr), card.id);
  db.prepare('INSERT INTO enrich_log (run_id, model_id, field, old_value, new_value, old_provenance) VALUES (?,?,?,?,?,?)')
    .run(runId, card.id, act.field, JSON.stringify(old ?? null), JSON.stringify(act.value), prov);
  card.attribution = JSON.stringify(attr);
  card[COLUMNS[act.field]] = toColumn(act.field, act.value);
}

/** Store a suggestion; an identical pending one is kept, an older different one is superseded. */
function addSuggestion(db, card, s, runId) {
  const proposed = s.proposed == null ? null : JSON.stringify(s.proposed);
  const current = s.current == null || (Array.isArray(s.current) && !s.current.length) ? null : JSON.stringify(s.current);
  if (s.type === 'merge') {
    const dup = db.prepare(`SELECT id FROM suggestions WHERE model_id = ? AND type = 'merge' AND target_id = ? AND status = 'pending'`).get(card.id, s.targetId);
    if (dup) return false;
    // the reverse proposal (target → this card) already waits: one is enough
    if (db.prepare(`SELECT id FROM suggestions WHERE model_id = ? AND type = 'merge' AND target_id = ? AND status = 'pending'`).get(s.targetId, card.id)) return false;
  } else {
    const pend = db.prepare(`SELECT id, proposed FROM suggestions WHERE model_id = ? AND type = ? AND field = ? AND status = 'pending'`).all(card.id, s.type, s.field);
    if (pend.some(p => p.proposed === proposed)) return false;
    if (pend.length) db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE id IN (${pend.map(() => '?').join(',')})`).run(...pend.map(p => p.id));
  }
  db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, target_id, confidence, reason, source, run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(card.id, s.type, s.field, current, proposed, s.targetId || null, round2(s.confidence), s.reason || null, s.source || 'text', runId);
  return true;
}

/** Was the same proposal rejected before for this card? (§2 "reject memory") */
function rejectedLookup(db, modelId) {
  const rows = db.prepare(`SELECT type, field, proposed, target_id FROM suggestions WHERE model_id = ? AND status = 'rejected'`).all(modelId);
  return (type, field, proposed, targetId) => rows.some(r => r.type === type && (type === 'merge'
    ? r.target_id === targetId
    : r.field === field && norm(parseJSON(r.proposed, r.proposed)) === norm(typeof proposed === 'string' && proposed.startsWith('[') ? parseJSON(proposed, proposed) : proposed)));
}

function isKnownGenreFn(pc) {
  const set = new Set((pc.genres || []).map(g => g.toLowerCase()));
  return (g) => set.has(String(g).toLowerCase()) || !!naming.canonicalGenre(g);
}

// ── run ──────────────────────────────────────────────────────────────────────

function apiText(parsed) {
  return (parsed && parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/**
 * Run enrichment over selected cards.
 * @param {object} o
 *   db, cards (from selectCards), runId, model, apiKey, client, promptCtx, vision (bool), tagsOnly,
 *   log(level,msg), progress(obj), aborted() → bool, sleep(ms), signal, loadImage(card) → {media,data}|null,
 *   ctxOpts (evidence ctx for re-signing)
 * @returns {Promise<object>} counts
 */
async function runEnrich(o) {
  const { db, cards, runId, model, apiKey } = o;
  const client = o.client || getClient(o.log);
  const log = o.log || (() => {});
  const progress = o.progress || (() => {});
  const aborted = o.aborted || (() => false);
  const sleep = o.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const th = thresholds();
  const pc = o.promptCtx || { genres: naming.GENRES, groups: {}, fixes: [] };
  const isKnownGenre = isKnownGenreFn(pc);
  const system = systemPrompt(pc, { tagsOnly: !!o.tagsOnly });
  const mode = o.tagsOnly ? 'tags' : 'full';
  const counts = { done: 0, total: cards.length, applied: 0, suggested: 0, merges: 0, errors: 0, visionUsed: 0, inTokens: 0, outTokens: 0, cancelled: false, fatal: null };
  const visionQueue = [];

  const finishCard = (card, ans, sources = {}) => {
    const rejected = rejectedLookup(db, card.id);
    const plan = planActions(card, ans, { ...th, isKnownGenre, rejected, tagsOnly: o.tagsOnly, source: 'text' });
    db.transaction(() => {
      for (const act of plan.apply) { applyAuto(db, card, act, runId); counts.applied++; }
      for (const s of plan.suggest) {
        if (sources[s.type === 'merge' ? 'merge' : s.field] === 'vision') s.source = 'vision';
        if (addSuggestion(db, card, s, runId)) { if (s.type === 'merge') counts.merges++; else counts.suggested++; }
      }
      // re-sign from the evidence as it is now, so the next run skips this card until something changes
      const fresh = db.prepare(`${CARD_SQL} AND m.id = ?`).get(card.id);
      const sib = card.ev && card.ev.siblings ? new Map([[releaseOf(card.work_key).base, [{ id: card.id, name: card.name }, ...card.ev.siblings.map((n, i) => ({ id: -1 - i, name: n }))]]]) : new Map();
      const ev = fresh ? buildEvidence(fresh, (filesByModel(db, [card.id]).get(card.id)) || [], { ...(o.ctxOpts || {}), similar: new Map(card.ev && card.ev.similar ? [[card.id, card.ev.similar]] : []), siblings: sib }) : card.ev;
      const prev = parseJSON(fresh ? fresh.enrichment : card.enrichment, {});
      const next = { ...prev, at: new Date().toISOString(), model, runId };
      if (mode === 'tags') next.tagsSig = evidenceSig(ev, 'tags'); else next.sig = evidenceSig(ev, 'full');
      db.prepare('UPDATE models SET enrichment = ? WHERE id = ?').run(JSON.stringify(next), card.id);
    })();
    for (const a of plan.apply) log('tag', `  ✎ ${card.name}: ${a.field} = ${Array.isArray(a.value) ? (a.added || a.value).join(', ') : a.value} (${a.c.toFixed(2)})`);
  };

  const call = async (body, label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const parsed = await client(apiKey, body, { timeoutMs: 180000, signal: o.signal });
        if (parsed && parsed.usage) { counts.inTokens += parsed.usage.input_tokens || 0; counts.outTokens += parsed.usage.output_tokens || 0; }
        return parsed;
      } catch (e) {
        const msg = String(e.message || e);
        if (/Invalid API key|lacks permission/.test(msg)) { counts.fatal = msg; throw e; }
        if (/cancelled/i.test(msg) || aborted()) { counts.cancelled = true; throw e; }
        if (/Rate limited|overloaded/i.test(msg) && attempt < 2) { log('warn', `${label}: ${msg}; waiting 30s`); await sleep(30000); if (aborted()) { counts.cancelled = true; throw e; } continue; }
        throw e;
      }
    }
    return null;
  };

  const batches = [];
  for (let i = 0; i < cards.length; i += BATCH_SIZE) batches.push(cards.slice(i, i + BATCH_SIZE));
  log('info', `${cards.length} card(s) in ${batches.length} batch(es) of up to ${BATCH_SIZE} with ${model}`);

  for (let b = 0; b < batches.length; b++) {
    if (aborted()) { counts.cancelled = true; break; }
    const batch = batches[b];
    const label = `Batch ${b + 1}/${batches.length}`;
    const byId = new Map(batch.map(c => [c.id, c.ev]));
    log('api', `${label}: ${batch.length} card(s) (${batch[0].creator_name || '?'}${batch.length > 1 && batch[batch.length - 1].creator_name !== batch[0].creator_name ? ` → ${batch[batch.length - 1].creator_name}` : ''})`);
    let parsed;
    try {
      parsed = await call({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: userPrompt(batch.map(c => c.ev)) }] }, label);
    } catch (e) {
      if (counts.fatal || counts.cancelled) break;
      counts.errors++; log('error', `${label}: ${e.message}`); continue;
    }
    const { items, errors, fatal } = validateResponse(apiText(parsed), byId);
    for (const err of errors.slice(0, 5)) log('warn', `${label}: ${err}`);
    if (fatal) { counts.errors++; continue; }
    counts.errors += errors.length;
    const before = { a: counts.applied, s: counts.suggested, m: counts.merges };
    for (const card of batch) {
      const ans = items.get(card.id);
      counts.done++;
      if (!ans) { counts.errors++; log('warn', `${label}: no answer for #${card.id} ${card.name}`); continue; }
      if (o.vision && !o.tagsOnly && card.thumbnail_path && wantsVision(card, ans, th.suggest)) { visionQueue.push({ card, ans }); continue; }
      try { finishCard(card, ans); } catch (e) { counts.errors++; log('error', `#${card.id}: ${e.message}`); }
    }
    log('success', `${label}: ${counts.applied - before.a} applied, ${counts.suggested - before.s} suggested, ${counts.merges - before.m} merge(s)`);
    progress({ type: 'progress', done: counts.done, total: counts.total, applied: counts.applied, suggested: counts.suggested, merges: counts.merges });
  }

  if (visionQueue.length && !counts.cancelled && !counts.fatal) {
    log('info', `Vision pass: ${visionQueue.length} card(s) the text pass could not resolve`);
    const vsys = `${system}\nAn image of this card's render is attached. Return a JSON array with exactly one item for the card.`;
    for (const { card, ans } of visionQueue) {
      if (aborted()) { counts.cancelled = true; break; }
      const img = o.loadImage ? o.loadImage(card) : null;
      let vAns = null;
      if (img) {
        try {
          const parsed = await call({ model, max_tokens: 600, system: vsys, messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: img.media, data: img.data } },
            { type: 'text', text: userPrompt([card.ev]) },
          ] }] }, `Vision #${card.id}`);
          const v = validateResponse(apiText(parsed), new Map([[card.id, card.ev]]));
          vAns = v.items.get(card.id) || null;
          counts.visionUsed++;
          if (v.errors.length) { counts.errors += v.errors.length; log('warn', `Vision #${card.id}: ${v.errors[0]}`); }
        } catch (e) {
          if (counts.fatal || counts.cancelled) break;
          counts.errors++; log('error', `Vision #${card.id}: ${e.message}`);
        }
      } else log('warn', `Vision #${card.id}: render missing or unsupported, using the text answer`);
      const { ans: merged, sources } = combineAnswers(ans, vAns);
      try { finishCard(card, merged, sources); } catch (e) { counts.errors++; log('error', `#${card.id}: ${e.message}`); }
      progress({ type: 'progress', done: counts.done, total: counts.total, applied: counts.applied, suggested: counts.suggested, merges: counts.merges });
    }
  }
  return counts;
}

// ── estimate ─────────────────────────────────────────────────────────────────

/**
 * Token/USD estimate from the real evidence: system prompt per batch + each card's evidence,
 * ~70 output tokens per card; vision: every candidate with a render (upper bound) at ~1.6k image
 * tokens + prompt + evidence.
 */
function estimate(db, opts, { promptCtx, rates, model, ctx } = {}) {
  const sel = selectCards(db, opts, ctx);
  const sys = systemPrompt(promptCtx || { genres: naming.GENRES, groups: {}, fixes: [] }, { tagsOnly: !!opts.tagsOnly });
  const sysTok = Math.ceil(sys.length / CHARS_PER_TOKEN);
  const batches = Math.ceil(sel.cards.length / BATCH_SIZE);
  let evChars = 0;
  for (const c of sel.cards) evChars += JSON.stringify(c.ev).length + 1;
  const textIn = Math.ceil(evChars / CHARS_PER_TOKEN) + batches * (sysTok + 15);
  const textOut = sel.cards.length * OUT_TOKENS_PER_ITEM;
  const r = rates || { inRate: 1, outRate: 5 };
  const usd = (i, o) => round2((i / 1e6) * r.inRate + (o / 1e6) * r.outRate);
  const withImg = sel.cards.filter(c => c.thumbnail_path);
  const vIn = withImg.reduce((t, c) => t + sysTok + 40 + IMAGE_TOKENS + Math.ceil(JSON.stringify(c.ev).length / CHARS_PER_TOKEN), 0);
  const vOut = withImg.length * VISION_OUT_TOKENS;
  const vision = opts.vision ? { maxItems: withImg.length, inTokens: vIn, outTokens: vOut, usd: usd(vIn, vOut) } : { maxItems: withImg.length, inTokens: 0, outTokens: 0, usd: 0, note: 'vision=1 to include' };
  const text = { inTokens: textIn, outTokens: textOut, usd: usd(textIn, textOut) };
  return {
    model, toProcess: sel.cards.length, unchanged: sel.skipped, batches,
    text, vision, totalUsd: round2(text.usd + (opts.vision ? vision.usd : 0)),
    perCard: sel.cards.length ? { evidenceTokens: Math.round(evChars / CHARS_PER_TOKEN / sel.cards.length), systemTokens: sysTok } : null,
  };
}

// ── review list ──────────────────────────────────────────────────────────────

/** Shape a suggestions row for the API (contract shape). */
function shapeSuggestion(db, r, cache = new Map()) {
  const card = (id) => {
    if (id == null) return null;
    if (!cache.has(id)) {
      const m = db.prepare(`SELECT m.id, m.name, m.thumbnail_path, COALESCE(m.kind, 'model') AS kind, m.folded_into, c.name AS creator_name FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id = ?`).get(id);
      cache.set(id, m ? { id: m.id, name: m.name, creator_name: m.creator_name, thumbnail_path: m.thumbnail_path, kind: m.kind } : null);
    }
    return cache.get(id);
  };
  const out = { id: r.id, type: r.type, field: r.field, model: card(r.model_id) };
  if (r.type === 'merge') out.target = card(r.target_id);
  else { out.current = parseJSON(r.current, r.current); out.proposed = parseJSON(r.proposed, r.proposed); }
  Object.assign(out, { confidence: r.confidence, reason: r.reason, source: r.source, runId: r.run_id, status: r.status });
  if (r.decided_at) out.decidedAt = r.decided_at;
  return out;
}

function suggestionWhere(f = {}) {
  const where = [], params = [];
  where.push('s.status = ?'); params.push(f.status || 'pending');
  if (f.type) { where.push('s.type = ?'); params.push(f.type); }
  if (f.field) { where.push('s.field = ?'); params.push(f.field); }
  if (f.creator) {
    if (/^\d+$/.test(String(f.creator))) { where.push('m.creator_id = ?'); params.push(Number(f.creator)); }
    else { where.push('c.name = ?'); params.push(String(f.creator)); }
  }
  const minC = parseFloat(f.minConfidence);
  if (Number.isFinite(minC)) { where.push('s.confidence >= ?'); params.push(minC); }
  const maxC = parseFloat(f.maxConfidence);
  if (Number.isFinite(maxC)) { where.push('s.confidence < ?'); params.push(maxC); }
  if (f.band === 'high') where.push('s.confidence >= 0.8');
  else if (f.band === 'medium') where.push('s.confidence >= 0.65 AND s.confidence < 0.8');
  else if (f.band === 'low') where.push('s.confidence < 0.65');
  if (f.modelId) { where.push('s.model_id = ?'); params.push(Number(f.modelId)); }
  return { sql: where.join(' AND '), params };
}
const SUGG_FROM = 'FROM suggestions s JOIN models m ON m.id = s.model_id LEFT JOIN creators c ON c.id = m.creator_id';

function listSuggestions(db, f = {}) {
  const page = Math.max(1, parseInt(f.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(f.limit, 10) || 50));
  const { sql, params } = suggestionWhere(f);
  const total = db.prepare(`SELECT COUNT(*) n ${SUGG_FROM} WHERE ${sql}`).get(...params).n;
  const rows = db.prepare(`SELECT s.* ${SUGG_FROM} WHERE ${sql} ORDER BY s.confidence DESC, c.name, m.name, s.id LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const cache = new Map();
  return { total, page, pages: Math.ceil(total / limit), items: rows.map(r => shapeSuggestion(db, r, cache)) };
}

function summary(db) {
  const rows = db.prepare(`SELECT type, field, confidence FROM suggestions WHERE status = 'pending'`).all();
  const out = { pending: rows.length, byType: { field: 0, merge: 0, rename: 0 }, byField: {}, byConfidence: { high: 0, medium: 0, low: 0 } };
  for (const r of rows) {
    out.byType[r.type] = (out.byType[r.type] || 0) + 1;
    if (r.field) out.byField[r.field] = (out.byField[r.field] || 0) + 1;
    out.byConfidence[r.confidence >= 0.8 ? 'high' : r.confidence >= 0.65 ? 'medium' : 'low']++;
  }
  return out;
}

/** Aliases for a merge: the source's work_key now resolves to the target's. */
function storeAlias(db, src, dst, source = 'merge') {
  // aliases join characters (base keys); the scan splits releases after them, so a merge never
  // collapses two releases
  const from = releaseOf(src.work_key).base, to = releaseOf(dst.work_key).base;
  if (!from || !to || from === to) return false;
  const creator = String(from).split('|')[0];
  const toName = dst.character || String(dst.name || '').replace(/\s*\([^)]*\)$/, '');
  db.prepare(`INSERT INTO aliases (creator, kind, from_key, to_key, from_name, to_name, source) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(from_key) DO UPDATE SET to_key = excluded.to_key, to_name = excluded.to_name, source = excluded.source`)
    .run(creator, src.kind || 'model', from, to, src.character || src.name, toName, source);
  // aliases that pointed at the source follow it
  db.prepare('UPDATE aliases SET to_key = ?, to_name = ? WHERE to_key = ?').run(to, toName, from);
  return true;
}

/**
 * Accept or reject suggestions. Accepting a field writes it with provenance "ai-reviewed";
 * a rename sets the name and locks it; a merge folds the card into the target (lib/fold.js) and
 * stores an alias so the next scan keeps them together.
 */
function decide(db, ids, decision) {
  const res = { accepted: 0, rejected: 0, merged: 0, errors: [] };
  if (!['accept', 'reject'].includes(decision)) throw new Error('decision must be "accept" or "reject"');
  for (const id of ids) {
    const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
    if (!s) { res.errors.push({ id, error: 'not found' }); continue; }
    if (s.status !== 'pending') { res.errors.push({ id, error: `already ${s.status}` }); continue; }
    if (decision === 'reject') {
      db.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`).run(id);
      res.rejected++; continue;
    }
    try {
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(s.model_id);
      if (!row) throw new Error('card not found');
      if (row.folded_into != null) throw new Error(`card was folded into #${row.folded_into}`);
      if (s.type === 'merge') {
        const dst = db.prepare('SELECT * FROM models WHERE id = ?').get(s.target_id);
        if (!dst) throw new Error('target card not found');
        const ra = releaseOf(row.work_key), rb = releaseOf(dst.work_key);
        if ((ra.release || rb.release) && (ra.release !== rb.release || ra.base === rb.base)) throw new Error('these cards are different releases of the character; they stay separate');
        db.transaction(() => {
          storeAlias(db, row, dst, 'merge');
          foldInto(db, row.id, dst.id, { reason: 'merge' });
          db.prepare(`UPDATE suggestions SET status = 'accepted', decided_at = datetime('now') WHERE id = ?`).run(id);
          // the folded card's other proposals are moot; proposals pointing at it point at the target
          db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE model_id = ? AND status = 'pending'`).run(row.id);
          db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE target_id = ? AND status = 'pending'`).run(row.id);
        })();
        res.merged++; res.accepted++; continue;
      }
      const f = s.field;
      let value = parseJSON(s.proposed, s.proposed);
      if (f === 'tags') {
        const have = parseJSON(row.tags, []);
        const set = new Set(have.map(norm));
        value = [...have, ...value.filter(t => !set.has(norm(t)))].slice(0, Math.max(TAG_CAP, have.length));
      }
      const attr = setAttrField(parseJSON(row.attribution, {}), f, 'ai-reviewed');
      db.transaction(() => {
        if (s.type === 'rename') db.prepare(`UPDATE models SET name = ?, name_locked = 1, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(value, JSON.stringify(attr), row.id);
        else db.prepare(`UPDATE models SET ${COLUMNS[f]} = ?, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(toColumn(f, value), JSON.stringify(attr), row.id);
        db.prepare(`UPDATE suggestions SET status = 'accepted', decided_at = datetime('now') WHERE id = ?`).run(id);
      })();
      res.accepted++;
    } catch (e) { res.errors.push({ id, error: e.message }); }
  }
  return res;
}

function decideFilter(db, filter = {}, decision) {
  const { sql, params } = suggestionWhere({ ...filter, status: 'pending' });
  const ids = db.prepare(`SELECT s.id ${SUGG_FROM} WHERE ${sql} ORDER BY s.id`).all(...params).map(r => r.id);
  return decide(db, ids, decision);
}

// ── runs ─────────────────────────────────────────────────────────────────────

function createRun(db, { model, scope, params }) {
  return db.prepare('INSERT INTO enrich_runs (model, scope, params) VALUES (?, ?, ?)').run(model, scope, JSON.stringify(params || {})).lastInsertRowid;
}

function finishRun(db, runId, counts, status) {
  db.prepare(`UPDATE enrich_runs SET finished_at = datetime('now'), status = ?, to_process = ?, applied = ?, suggested = ?, merges = ?,
    unchanged = ?, errors = ?, vision_used = ?, in_tokens = ?, out_tokens = ? WHERE id = ?`)
    .run(status, counts.total || 0, counts.applied || 0, counts.suggested || 0, counts.merges || 0, counts.unchanged || 0,
      counts.errors || 0, counts.visionUsed || 0, counts.inTokens || 0, counts.outTokens || 0, runId);
}

function listRuns(db, limit = 50) {
  return db.prepare('SELECT * FROM enrich_runs ORDER BY id DESC LIMIT ?').all(limit).map(r => ({
    id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, model: r.model, scope: r.scope, status: r.status,
    toProcess: r.to_process, applied: r.applied, suggested: r.suggested, merges: r.merges, unchanged: r.unchanged, errors: r.errors,
    visionUsed: r.vision_used, inTokens: r.in_tokens, outTokens: r.out_tokens, undone: !!r.undone_at, undoneAt: r.undone_at || null,
  }));
}

/**
 * Undo the automatic writes of one run. A field changed since (by the user, a review, a later
 * run or a scan) is left alone.
 */
function undoRun(db, runId) {
  const run = db.prepare('SELECT * FROM enrich_runs WHERE id = ?').get(runId);
  if (!run) { const e = new Error('Run not found'); e.status = 404; throw e; }
  const logs = db.prepare('SELECT * FROM enrich_log WHERE run_id = ? AND reverted_at IS NULL ORDER BY id DESC').all(runId);
  let reverted = 0, skipped = 0;
  db.transaction(() => {
    for (const l of logs) {
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(l.model_id);
      if (!row) { skipped++; continue; }
      const { value: now } = fieldState(row, l.field);
      if (!sameValue(now, parseJSON(l.new_value, null))) { skipped++; continue; }
      const old = parseJSON(l.old_value, null);
      const attr = setAttrField(parseJSON(row.attribution, {}), l.field, l.old_provenance || null);
      db.prepare(`UPDATE models SET ${COLUMNS[l.field]} = ?, attribution = ?, updated_at = datetime('now') WHERE id = ?`).run(toColumn(l.field, old), JSON.stringify(attr), row.id);
      db.prepare(`UPDATE enrich_log SET reverted_at = datetime('now') WHERE id = ?`).run(l.id);
      // forget the signature so the card is looked at again by the next run
      const en = parseJSON(row.enrichment, {});
      if (en.sig || en.tagsSig) { delete en.sig; delete en.tagsSig; db.prepare('UPDATE models SET enrichment = ? WHERE id = ?').run(JSON.stringify(en), row.id); }
      reverted++;
    }
    db.prepare(`UPDATE enrich_runs SET undone_at = datetime('now') WHERE id = ?`).run(runId);
  })();
  return { reverted, skipped };
}

/** Pending suggestions for one card (model detail). */
function suggestionsFor(db, modelId) {
  const rows = db.prepare(`SELECT * FROM suggestions WHERE status = 'pending' AND (model_id = ? OR target_id = ?) ORDER BY confidence DESC, id`).all(modelId, modelId);
  const cache = new Map();
  return rows.map(r => shapeSuggestion(db, r, cache));
}

module.exports = {
  PROMPT_VERSION, BATCH_SIZE, TAG_CAP, PROTECTED, OUT_TOKENS_PER_ITEM, thresholds, fakeEnabled, getClient,
  releaseOf, scopeWhere, selectCards, nearDuplicates, buildEvidence, evidenceSig, fileStems, pathSegments,
  promptContext, systemPrompt, userPrompt, validateResponse, extractJSON,
  fieldState, planActions, wantsVision, combineAnswers, applyAuto, addSuggestion, rejectedLookup, isKnownGenreFn,
  runEnrich, estimate, listSuggestions, summary, decide, decideFilter, storeAlias, createRun, finishRun, listRuns, undoRun,
  suggestionsFor, shapeSuggestion,
};
