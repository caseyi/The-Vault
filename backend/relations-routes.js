'use strict';
/**
 * relations-routes.js: /api/relations and /api/sets (docs/relations.md §4, §7.4).
 *
 *   GET    /api/relations/summary          counts; its presence switches the feature on in the UI
 *   GET    /api/relations?modelId=         rows touching one card
 *   POST   /api/relations                  { type, fromId, toId } manual link (reactivates a removed one)
 *   DELETE /api/relations/:id              status removed (remembered)
 *   POST   /api/relations/relink           re-run linking now (409 while a scan runs)
 *
 *   GET    /api/sets                       release / theme / diorama sets, paged
 *   GET    /api/sets/:id                   one set with its releases, loose and pending cards
 *   POST   /api/sets                       { name, creator?, note?, ids? } a manual theme
 *   PATCH  /api/sets/:id                   { name?, note? }
 *   POST   /api/sets/:id/members           { ids?, releaseSetIds? }
 *   DELETE /api/sets/:id/members/:modelId  leave a card out (remembered)
 *   DELETE /api/sets/:id                   remove the set (remembered: never proposed again)
 */
const express = require('express');
const rel = require('./lib/relations');
const { wrapAsyncRoutes } = require('./lib/middleware');

const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const clampInt = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const likeEscape = (s) => String(s).replace(/[\\%_]/g, '\\$&');
const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };
const VISIBLE = `m.folded_into IS NULL AND COALESCE(m.hidden, 0) = 0`;
const KIND_ORDER = { diorama: 0, release: 1, theme: 2 };

function shapeRelation(r) {
  return { id: r.id, type: r.type, fromId: r.from_id, toId: r.to_id, source: r.source, confidence: r.confidence, status: r.status, reason: r.reason || null, createdAt: r.created_at, updatedAt: r.updated_at };
}

// ── sets: reading ────────────────────────────────────────────────────────────

/** Active (or for a suggested set: suggested) members of a stored set, release items first. */
function memberRows(db, set, statuses) {
  return db.prepare(`SELECT sm.model_id, sm.via, sm.status, sm.confidence FROM set_members sm JOIN models m ON m.id = sm.model_id
    WHERE sm.set_id = ? AND sm.status IN (${statuses.map(() => '?').join(',')}) AND ${VISIBLE}
    ORDER BY CASE sm.via WHEN 'release' THEN 0 ELSE 1 END, m.name`).all(set.id, ...statuses);
}
const statusesFor = (set) => (set.status === 'suggested' ? ['suggested', 'active'] : ['active']);

function featuresOf(db, dioId) {
  return db.prepare(`SELECT r.* ${rel.EDGE_FROM} WHERE r.type = 'features' AND r.from_id = ? AND ${rel.ACTIVE_EDGE()} ORDER BY rb.name`).all(dioId);
}
function accessoriesOf(db, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT r.* ${rel.EDGE_FROM} WHERE r.type = 'accessory-of' AND r.to_id IN (${ids.map(() => '?').join(',')}) AND ${rel.ACTIVE_EDGE()}`).all(...ids);
}

/** Release sets the members of a theme come from: [{ set, ids }] */
function releasesOfMembers(db, ids) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT s.id, s.name, s.term, sm.model_id FROM set_members sm JOIN sets s ON s.id = sm.set_id
    WHERE s.kind = 'release' AND s.status = 'active' AND sm.status = 'active' AND sm.model_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.term, s.name`).all(...ids);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.id)) by.set(r.id, { id: r.id, name: r.name, term: r.term || null, ids: [] }); by.get(r.id).ids.push(r.model_id); }
  return [...by.values()];
}

function dioramaItem(db, dio, { full = false } = {}) {
  const feats = featuresOf(db, dio.id);
  const ids = [dio.id, ...feats.map(f => f.to_id)];
  const accRows = accessoriesOf(db, feats.map(f => f.to_id));
  const cards = rel.cardsByIds(db, [...ids, ...accRows.map(a => a.from_id)]);
  const diorama = rel.shapeCard(cards.get(dio.id));
  const members = feats.map(f => rel.shapeCard(cards.get(f.to_id), f));
  const accessories = accRows.map(a => rel.shapeCard(cards.get(a.from_id), a));
  const out = {
    id: `diorama-${dio.id}`, kind: 'diorama', name: dio.name, creator: dio.creator || null, term: dio.release_term || null, status: 'active',
    counts: { cards: 1 + members.length, releases: 0 }, cover: diorama.thumb_url || (members.find(m => m.thumb_url) || {}).thumb_url || null,
    members: full ? members : members.slice(0, 12), diorama, accessories,
  };
  if (full) Object.assign(out, { releases: [], loose: [diorama, ...members], pending: [] });
  return out;
}

function storedItem(db, set, { full = false } = {}) {
  const mem = memberRows(db, set, statusesFor(set));
  const ids = mem.map(m => m.model_id);
  const info = parseJSON(set.info, {});
  let releases = [];
  if (set.kind === 'theme') releases = releasesOfMembers(db, mem.filter(m => m.via === 'release').map(m => m.model_id));
  const pendRows = set.status === 'active' ? memberRows(db, set, ['suggested']) : [];
  const cards = rel.cardsByIds(db, full ? [...ids, ...pendRows.map(p => p.model_id)] : ids.slice(0, 12));
  const shape = (id) => (cards.get(id) ? rel.shapeCard(cards.get(id)) : null);
  const members = (full ? ids : ids.slice(0, 12)).map(shape).filter(Boolean);
  const out = {
    id: set.id, kind: set.kind, name: set.name, creator: set.creator || null, term: set.term || null, status: set.status, source: set.source,
    counts: { cards: ids.length, releases: set.kind === 'release' ? 1 : releases.length, ...(set.kind === 'theme' ? { loose: mem.filter(m => m.via !== 'release').length } : {}) },
    cover: (members.find(m => m.thumb_url) || {}).thumb_url || null, members,
  };
  if (full) {
    out.note = set.note || null;
    out.info = info;
    if (set.kind === 'release') {
      out.releases = [{ id: set.id, name: set.name, term: set.term || null, members }];
      out.loose = [];
    } else {
      const inRel = new Set(releases.flatMap(r => r.ids));
      out.releases = releases.map(r => ({ id: r.id, name: r.name, term: r.term, members: r.ids.map(shape).filter(Boolean) }));
      out.loose = ids.filter(id => !inRel.has(id)).map(shape).filter(Boolean);
    }
    out.pending = pendRows.map(p => shape(p.model_id)).filter(Boolean);
    out.createdAt = set.created_at; out.updatedAt = set.updated_at;
  }
  return out;
}

function listSets(db, q) {
  const kinds = (q.kind ? String(q.kind).split(',') : ['diorama', 'release', 'theme']).map(k => k.trim()).filter(k => KIND_ORDER[k] !== undefined);
  const status = ['active', 'suggested', 'removed'].includes(q.status) ? q.status : 'active';
  const page = clampInt(q.page, 1, 1, 1e6);
  const limit = clampInt(q.limit, 20, 1, 100);
  const search = q.search ? `%${likeEscape(q.search)}%` : null;
  const light = [];
  const stored = kinds.filter(k => k !== 'diorama');
  if (stored.length) {
    const where = [`s.kind IN (${stored.map(() => '?').join(',')})`, 's.status = ?'];
    const params = [...stored, status];
    if (q.creator) { where.push('s.creator = ?'); params.push(String(q.creator)); }
    if (search) { where.push(`s.name LIKE ? ESCAPE '\\'`); params.push(search); }
    if (q.genre) { where.push(`EXISTS (SELECT 1 FROM set_members sm JOIN models m ON m.id = sm.model_id WHERE sm.set_id = s.id AND m.franchise = ?)`); params.push(String(q.genre)); }
    for (const s of db.prepare(`SELECT s.* FROM sets s WHERE ${where.join(' AND ')}`).all(...params)) light.push({ kind: s.kind, name: s.name, creator: s.creator || '', term: s.term || '', row: s });
  }
  if (kinds.includes('diorama') && status === 'active') {
    const where = [`r.type = 'features'`, rel.ACTIVE_EDGE(), `ra.kind = 'diorama'`];
    const params = [];
    if (q.creator) { where.push('c.name = ?'); params.push(String(q.creator)); }
    if (search) { where.push(`ra.name LIKE ? ESCAPE '\\'`); params.push(search); }
    if (q.genre) { where.push('ra.franchise = ?'); params.push(String(q.genre)); }
    for (const d of db.prepare(`SELECT DISTINCT ra.id, ra.name, ra.release_term, c.name AS creator ${rel.EDGE_FROM} LEFT JOIN creators c ON c.id = ra.creator_id WHERE ${where.join(' AND ')}`).all(...params)) {
      light.push({ kind: 'diorama', name: d.name, creator: d.creator || '', term: d.release_term || '', row: d });
    }
  }
  light.sort((a, b) => a.creator.localeCompare(b.creator) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(b.term).localeCompare(String(a.term)) || a.name.localeCompare(b.name));
  const total = light.length;
  const items = light.slice((page - 1) * limit, page * limit).map(x => (x.kind === 'diorama' ? dioramaItem(db, x.row) : storedItem(db, x.row)));
  const out = { items, total, page, pages: Math.ceil(total / limit) };
  if (q.includeSolo === '1' || q.includeSolo === 'true') {
    // figures without a diorama (studio characters with a Sculpture or Bust)
    const where = [VISIBLE, `COALESCE(m.kind, 'model') = 'work'`, `(m.editions LIKE '%"Sculpture"%' OR m.editions LIKE '%"Bust"%')`,
      `m.id NOT IN (SELECT r.to_id ${rel.EDGE_FROM} WHERE r.type = 'features' AND ${rel.ACTIVE_EDGE()})`];
    const params = [];
    if (q.creator) { where.push('c.name = ?'); params.push(String(q.creator)); }
    if (search) { where.push(`m.name LIKE ? ESCAPE '\\'`); params.push(search); }
    if (q.genre) { where.push('m.franchise = ?'); params.push(String(q.genre)); }
    const from = `FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE ${where.join(' AND ')}`;
    out.soloTotal = db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n;
    out.solo = db.prepare(`SELECT ${rel.CARD_COLS} ${from} ORDER BY c.name, m.name LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit).map(m => rel.shapeCard(m));
  }
  return out;
}

function getSet(db, id) {
  const m = String(id).match(/^diorama-(\d+)$/);
  if (m) {
    const d = db.prepare(`SELECT m.id, m.name, m.release_term, c.name AS creator FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id = ? AND COALESCE(m.kind, 'model') = 'diorama'`).get(Number(m[1]));
    if (!d) throw httpError(404, 'Set not found');
    return dioramaItem(db, d, { full: true });
  }
  if (!/^\d+$/.test(String(id))) throw httpError(404, 'Set not found');
  const s = db.prepare('SELECT * FROM sets WHERE id = ?').get(Number(id));
  if (!s) throw httpError(404, 'Set not found');
  return storedItem(db, s, { full: true });
}

// ── sets: writing ────────────────────────────────────────────────────────────

function cardKeys(db, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!list.length) return [];
  return db.prepare(`SELECT m.id, m.work_key, m.folded_into, c.name AS creator FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id IN (${list.map(() => '?').join(',')})`).all(...list)
    .filter(r => r.folded_into == null).map(r => ({ id: r.id, key: rel.keyOf(r), creator: r.creator }));
}

function addMembers(db, setId, cards, via) {
  const st = db.prepare(`INSERT INTO set_members (set_id, model_key, model_id, via, status, confidence) VALUES (?, ?, ?, ?, 'active', 1)
    ON CONFLICT(set_id, model_key) DO UPDATE SET status = 'active', model_id = excluded.model_id, via = CASE WHEN via = 'release' THEN via ELSE excluded.via END`);
  const sup = db.prepare(`UPDATE suggestions SET status = 'accepted', decided_at = datetime('now') WHERE type = 'set-member' AND set_id = ? AND model_id = ? AND status = 'pending'`);
  for (const c of cards) { st.run(setId, c.key, c.id, via); sup.run(setId, c.id); }
}

function createSet(db, body) {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  if (name.length > 200) throw httpError(400, 'name too long');
  const cards = cardKeys(db, body.ids);
  const creator = body.creator ? String(body.creator) : (cards[0] ? cards[0].creator : null);
  const key = rel.setKeyOf(creator, 'theme', name);
  let id;
  db.transaction(() => {
    const ex = db.prepare('SELECT * FROM sets WHERE key = ?').get(key);
    if (ex && ex.status === 'active') throw Object.assign(httpError(409, `A theme named "${ex.name}" exists for ${creator || 'these cards'}`), { setId: ex.id });
    if (ex) {
      id = ex.id;
      db.prepare(`UPDATE sets SET name = ?, note = COALESCE(?, note), source = 'user', status = 'active', updated_at = datetime('now') WHERE id = ?`).run(name, body.note || null, id);
      db.prepare(`UPDATE suggestions SET status = 'accepted', decided_at = datetime('now') WHERE type = 'set' AND set_id = ? AND status = 'pending'`).run(id);
    } else {
      id = db.prepare(`INSERT INTO sets (creator, name, kind, key, source, status, note) VALUES (?, ?, 'theme', ?, 'user', 'active', ?)`).run(creator, name, key, body.note || null).lastInsertRowid;
    }
    addMembers(db, id, cards, 'user');
  })();
  return getSet(db, id);
}

function relationsRouter({ db, isScanning = () => false }) {
  const router = wrapAsyncRoutes(express.Router());
  router.get('/summary', (req, res) => res.json(rel.summary(db)));
  router.get('/', (req, res) => {
    const id = Number(req.query.modelId);
    const rows = Number.isInteger(id)
      ? db.prepare('SELECT * FROM relations WHERE from_id = ? OR to_id = ? ORDER BY type, id').all(id, id)
      : db.prepare(`SELECT * FROM relations WHERE status = ? ORDER BY id LIMIT ?`).all(req.query.status || 'active', clampInt(req.query.limit, 200, 1, 2000));
    res.json({ items: rows.map(shapeRelation) });
  });
  router.post('/', (req, res) => {
    const { type, fromId, toId } = req.body || {};
    try {
      let row;
      db.transaction(() => {
        row = rel.upsertRelation(db, { type, fromId: Number(fromId), toId: Number(toId), source: 'user' });
        // the same link waiting in the review list is answered by this
        db.prepare(`UPDATE suggestions SET status = 'accepted', decided_at = datetime('now') WHERE type = 'relation' AND status = 'pending' AND field = ?
          AND ((model_id = ? AND target_id = ?) OR (model_id = ? AND target_id = ?))`).run(row.type, row.from_id, row.to_id, row.to_id, row.from_id);
      })();
      const cards = rel.cardsByIds(db, [row.from_id, row.to_id]);
      res.status(201).json({ relation: shapeRelation(row), from: rel.shapeCard(cards.get(row.from_id), row), to: rel.shapeCard(cards.get(row.to_id), row) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  router.delete('/:id(\\d+)', (req, res) => {
    const row = rel.removeRelation(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Relation not found' });
    res.json({ relation: shapeRelation(row) });
  });
  router.post('/relink', (req, res) => {
    if (isScanning()) return res.status(409).json({ error: 'A scan is running; links are refreshed when it ends' });
    const lines = [];
    const out = rel.autoLink(db, { log: (lvl, msg) => lines.push(msg) });
    res.json({ ...out, log: lines });
  });
  return router;
}

function setsRouter({ db }) {
  const router = wrapAsyncRoutes(express.Router());
  const send = (res, fn) => { try { fn(); } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.setId ? { id: e.setId } : {}) }); } };
  router.get('/', (req, res) => send(res, () => res.json(listSets(db, req.query))));
  router.get('/:id', (req, res) => send(res, () => res.json(getSet(db, req.params.id))));
  router.post('/', (req, res) => send(res, () => res.status(201).json(createSet(db, req.body || {}))));
  const stored = (id) => {
    if (!/^\d+$/.test(String(id))) throw httpError(400, 'Diorama sets come from their links; edit the links instead');
    const s = db.prepare('SELECT * FROM sets WHERE id = ?').get(Number(id));
    if (!s) throw httpError(404, 'Set not found');
    return s;
  };
  router.patch('/:id', (req, res) => send(res, () => {
    const s = stored(req.params.id);
    const { name, note } = req.body || {};
    if (name !== undefined) {
      const n = String(name || '').trim();
      if (!n) throw httpError(400, 'name cannot be empty');
      db.prepare(`UPDATE sets SET name = ?, source = 'user', updated_at = datetime('now') WHERE id = ?`).run(n, s.id);
    }
    if (note !== undefined) db.prepare(`UPDATE sets SET note = ?, updated_at = datetime('now') WHERE id = ?`).run(note == null || note === '' ? null : String(note), s.id);
    res.json(getSet(db, s.id));
  }));
  router.post('/:id/members', (req, res) => send(res, () => {
    const s = stored(req.params.id);
    const { ids, releaseSetIds } = req.body || {};
    if (!(Array.isArray(ids) && ids.length) && !(Array.isArray(releaseSetIds) && releaseSetIds.length)) throw httpError(400, 'ids or releaseSetIds required');
    if (s.status === 'removed') throw httpError(409, 'This set was removed');
    db.transaction(() => {
      addMembers(db, s.id, cardKeys(db, ids), 'user');
      for (const rid of (Array.isArray(releaseSetIds) ? releaseSetIds : []).map(Number).filter(Number.isInteger)) {
        const r = db.prepare(`SELECT id FROM sets WHERE id = ? AND kind = 'release'`).get(rid);
        if (!r || r.id === s.id) continue;
        const mem = db.prepare(`SELECT model_id FROM set_members WHERE set_id = ? AND status = 'active' AND model_id IS NOT NULL`).all(r.id).map(x => x.model_id);
        addMembers(db, s.id, cardKeys(db, mem), 'release');
        const info = parseJSON(db.prepare('SELECT info FROM sets WHERE id = ?').get(s.id).info, {});
        info.releases = [...new Set([...(info.releases || []), r.id])];
        db.prepare('UPDATE sets SET info = ? WHERE id = ?').run(JSON.stringify(info), s.id);
      }
      db.prepare(`UPDATE sets SET updated_at = datetime('now') WHERE id = ?`).run(s.id);
    })();
    res.json(getSet(db, s.id));
  }));
  router.delete('/:id/members/:modelId(\\d+)', (req, res) => send(res, () => {
    const s = stored(req.params.id);
    const mid = Number(req.params.modelId);
    const r = db.prepare(`UPDATE set_members SET status = 'removed' WHERE set_id = ? AND model_id = ? AND status != 'removed'`).run(s.id, mid);
    if (!r.changes) throw httpError(404, 'Card is not in this set');
    db.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = datetime('now') WHERE type = 'set-member' AND set_id = ? AND model_id = ? AND status = 'pending'`).run(s.id, mid);
    res.json(getSet(db, s.id));
  }));
  router.delete('/:id', (req, res) => send(res, () => {
    const s = stored(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE sets SET status = 'removed', updated_at = datetime('now') WHERE id = ?`).run(s.id);
      db.prepare(`UPDATE suggestions SET status = 'rejected', decided_at = datetime('now') WHERE set_id = ? AND status = 'pending'`).run(s.id);
    })();
    res.json({ id: s.id, status: 'removed' });
  }));
  return router;
}

module.exports = { relationsRouter, setsRouter, listSets, getSet, createSet, shapeRelation };
