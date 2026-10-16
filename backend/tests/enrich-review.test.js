/**
 * Enrich, second review round: stale accepts (B2), the user's tags (B3), merge guards and reverse
 * rejections (S2, S3), undo memory and unmerge (S4), CSV-injection values (S8), truncated answers
 * and failing batches (S10), actual spend (S11), the spend guard on GET endpoints (S12), the
 * filing-rule subset check (S1), and moves.csv destinations (B1, S6, S7). No real API key: the
 * client is an inline stub, or the dev fake model where a whole run goes through the API.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-enrich-rev-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
process.env.ENRICH_FAKE = '1';
process.env.ENRICH_FAKE_DELAY_MS = '0';
process.env.CLAUDE_MODEL = 'claude-mystery-1'; // no price list: the estimate warns
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;
delete process.env.CLAUDE_API_KEY;
delete process.env.ENRICH_AUTO_MIN;
delete process.env.ENRICH_SUGGEST_MIN;

let seq = 5000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 29)));
  return full;
}
mk('Wicked/Video Games/Geral/Wicked - Geral Sculpture (One Piece).zip');
mk('Wicked/Video Games/Geralt/Wicked - Geralt Bust (Non Supported).zip');
mk('B3DSERK/DC/Hellboy/B3DSERK - Hellboy Sculpture (One Piece).zip');
mk('B3DSERK/DC/Peacemaker/B3DSERK - Peace Maker Bust (Non Supported).zip');
mk('Misc/Mystery Thing/thing.stl');
mk('Misc/Other Thing/other.stl');

const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const enrich = require('../lib/enrich');
const ox = require('../lib/organizer-export');

const PJ = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const byName = (n) => (n === 'Peace Maker'
  // model.json renames it in one test: found by its folder
  ? db.prepare(`SELECT m.* FROM models m JOIN model_files f ON f.model_id = m.id WHERE f.filepath LIKE '%/Peacemaker/%' AND m.folded_into IS NULL`).get()
  : db.prepare('SELECT * FROM models WHERE name = ? AND folded_into IS NULL').get(n));
const row = (id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id);
const sseEvents = (text) => String(text).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
const sugg = (id) => db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
const addSugg = (o) => db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, target_id, confidence, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).run(o.model_id, o.type || 'field', o.field || null, o.current === undefined ? null : JSON.stringify(o.current),
  o.proposed === undefined ? null : JSON.stringify(o.proposed), o.target_id || null, o.confidence || 0.7).lastInsertRowid;
const setProv = (id, field, prov) => {
  const a = PJ(row(id).attribution, {});
  a.fields = { ...(a.fields || {}), [field]: prov };
  db.prepare('UPDATE models SET attribution = ? WHERE id = ?').run(JSON.stringify(a), id);
};

/** An inline client: answer(ev) per card asked; `script` overrides whole calls by index. */
function stubClient(answer, script = {}) {
  const calls = [];
  const fn = async (key, body) => {
    const content = body.messages[0].content;
    const text = typeof content === 'string' ? content : content.find(c => c.type === 'text').text;
    const evs = text.split('\n').slice(1).map(l => JSON.parse(l));
    const n = calls.push(evs.map(e => e.id));
    if (script[n - 1]) return script[n - 1](evs);
    return { content: [{ type: 'text', text: JSON.stringify(evs.map(answer).filter(Boolean)) }], usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: 'end_turn' };
  };
  fn.calls = calls;
  return fn;
}
const runWith = async (ids, client, o = {}) => {
  const sel = enrich.selectCards(db, { scope: 'ids', ids: ids.join(','), force: true }, { libraryRoot: LIB });
  const runId = enrich.createRun(db, { model: 'stub', scope: 'ids', params: {} });
  const counts = await enrich.runEnrich({ db, cards: sel.cards, runId, model: 'stub', apiKey: 't', client, sleep: async () => {}, ...o });
  enrich.finishRun(db, runId, counts, 'complete');
  return { runId, counts };
};

beforeAll(async () => { await scanLibrary(LIB); });
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── B2: a proposal made against an older value is not accepted over a newer one ──

describe('B2 stale accepts', () => {
  test('accept after the field became model.json (sidecar): superseded, "changed since", value kept', () => {
    const hb = byName('Hellboy');
    const id = addSugg({ model_id: hb.id, field: 'franchise', current: 'DC', proposed: 'Other Comics' });
    setProv(hb.id, 'franchise', 'sidecar');
    db.prepare(`UPDATE models SET franchise = 'Dark Horse' WHERE id = ?`).run(hb.id);
    const r = enrich.decide(db, [id], 'accept');
    expect(r).toMatchObject({ accepted: 0, superseded: 1 });
    expect(r.errors[0].error).toMatch(/changed since/);
    expect(sugg(id).status).toBe('superseded');
    expect(row(hb.id).franchise).toBe('Dark Horse');
    setProv(hb.id, 'franchise', 'path');
    db.prepare(`UPDATE models SET franchise = 'DC' WHERE id = ?`).run(hb.id);
  });

  test('accept after the value changed (same provenance): superseded; an unchanged one is accepted', () => {
    const hb = byName('Hellboy');
    const stale = addSugg({ model_id: hb.id, field: 'group_name', current: 'BPRD', proposed: 'B.P.R.D.' });
    const ok = addSugg({ model_id: hb.id, field: 'character', current: row(hb.id).character, proposed: 'Hellboy (Anung Un Rama)' });
    const r = enrich.decide(db, [stale, ok], 'accept');
    expect(r).toMatchObject({ accepted: 1, superseded: 1 });
    expect(sugg(stale).status).toBe('superseded');
    expect(row(hb.id).character).toBe('Hellboy (Anung Un Rama)');
  });

  test('a rename whose name the user locked to something else is superseded', () => {
    const pm = byName('Peace Maker');
    const id = addSugg({ model_id: pm.id, type: 'rename', field: 'name', current: 'Peace Maker', proposed: 'Peacemaker' });
    db.prepare(`UPDATE models SET name = 'Peacemaker (HBO)', name_locked = 1 WHERE id = ?`).run(pm.id);
    expect(enrich.decide(db, [id], 'accept')).toMatchObject({ accepted: 0, superseded: 1 });
    expect(row(pm.id).name).toBe('Peacemaker (HBO)');
    db.prepare(`UPDATE models SET name = 'Peace Maker', name_locked = 0 WHERE id = ?`).run(pm.id);
  });

  test('a scan that writes a model.json value supersedes pending proposals for that field', async () => {
    const pm = byName('Peace Maker');
    const id = addSugg({ model_id: pm.id, field: 'franchise', current: row(pm.id).franchise, proposed: 'Movies' });
    const keep = addSugg({ model_id: pm.id, field: 'group_name', current: null, proposed: 'Suicide Squad' });
    fs.writeFileSync(path.join(LIB, 'B3DSERK/DC/Peacemaker/model.json'), JSON.stringify({ studio: 'B3DSERK', creator: 'B3DSERK', genre: 'TV', character: 'Peacemaker', type: 'Bust' }));
    await scanLibrary(LIB);
    const now = db.prepare('SELECT * FROM models WHERE id = ?').get(pm.id);
    expect(PJ(now.attribution).fields.franchise).toBe('sidecar');
    expect(sugg(id).status).toBe('superseded');
    expect(sugg(keep).status).toBe('pending');
    fs.rmSync(path.join(LIB, 'B3DSERK/DC/Peacemaker/model.json'));
    db.prepare(`UPDATE suggestions SET status = 'rejected' WHERE id = ?`).run(keep);
  });
});

// ── B3: tags the user edited or removed ──────────────────────────────────────

describe('B3 the user\'s tags', () => {
  test('PATCH records removed tags; re-adding one lifts it', async () => {
    const t = byName('Mystery Thing');
    await request(app).patch(`/api/models/${t.id}`).send({ tags: ['keep', 'gone', 'later'] });
    await request(app).patch(`/api/models/${t.id}`).send({ tags: ['keep'] });
    expect(PJ(row(t.id).attribution).removedTags.sort()).toEqual(['gone', 'later']);
    await request(app).patch(`/api/models/${t.id}`).send({ tags: ['keep', 'later'] });
    expect(PJ(row(t.id).attribution).removedTags).toEqual(['gone']);
  });

  test('user-edited tags are only proposed, without the removed ones; accept never re-adds them', async () => {
    const t = byName('Mystery Thing');
    const client = stubClient(ev => (ev.id === t.id ? { id: ev.id, tags: { v: ['gone', 'theme:new'], c: 0.95 } } : null));
    await runWith([t.id], client);
    expect(PJ(row(t.id).tags)).toEqual(['keep', 'later']); // nothing applied
    const s = db.prepare(`SELECT * FROM suggestions WHERE model_id = ? AND field = 'tags' AND status = 'pending'`).get(t.id);
    expect(PJ(s.proposed)).toEqual(['theme:new']);
    // a proposal that still carries a removed tag (an older run) never re-adds it
    db.prepare('UPDATE suggestions SET proposed = ? WHERE id = ?').run(JSON.stringify(['gone', 'theme:new']), s.id);
    expect(enrich.decide(db, [s.id], 'accept').accepted).toBe(1);
    expect(PJ(row(t.id).tags)).toEqual(['keep', 'later', 'theme:new']);
  });

  test('planActions: tags of a card without user tags are applied, minus removed tags', () => {
    const card = { id: 1, name: 'X', tags: '["a"]', editions: '[]', attribution: JSON.stringify({ removedTags: ['b'] }) };
    const p = enrich.planActions(card, { id: 1, tags: { v: ['b', 'c'], c: 0.9 } }, { ...enrich.thresholds(), isKnownGenre: () => true, rejected: () => false });
    expect(p.apply[0].value).toEqual(['a', 'c']);
    const u = enrich.planActions({ ...card, attribution: JSON.stringify({ userFields: ['tags'], removedTags: ['b'] }) }, { id: 1, tags: { v: ['b', 'c'], c: 0.99 } }, { ...enrich.thresholds(), isKnownGenre: () => true, rejected: () => false });
    expect(u.apply).toEqual([]);
    expect(u.suggest[0]).toMatchObject({ field: 'tags', proposed: ['c'] });
  });
});

// ── S2, S3: merge guards, reverse rejections ─────────────────────────────────

describe('S2/S3 merges', () => {
  test('cards of different creators or kinds are not merged', () => {
    const hb = byName('Hellboy'), geralt = byName('Geralt'), pm = byName('Peace Maker');
    const cross = addSugg({ model_id: hb.id, type: 'merge', target_id: geralt.id, confidence: 0.9 });
    expect(enrich.decide(db, [cross], 'accept', { snapshot: () => 'x' }).errors[0].error).toMatch(/different creators/);
    db.prepare(`UPDATE models SET kind = 'diorama' WHERE id = ?`).run(pm.id);
    const kind = addSugg({ model_id: hb.id, type: 'merge', target_id: pm.id, confidence: 0.9 });
    expect(enrich.decide(db, [kind], 'accept', { snapshot: () => 'x' }).errors[0].error).toMatch(/work card is not merged into a diorama/);
    expect(row(hb.id).folded_into).toBeNull();
    // and they are not offered as near-duplicates
    const pool = enrich.selectCards(db, { scope: 'all', force: true }, { libraryRoot: LIB }).cards;
    expect((pool.find(c => c.id === hb.id).ev.similar || []).some(s => s.id === pm.id)).toBe(false);
    db.prepare(`UPDATE models SET kind = 'work' WHERE id = ?`).run(pm.id);
    db.prepare(`UPDATE suggestions SET status = 'rejected' WHERE id IN (?, ?)`).run(cross, kind);
  });

  test('a rejected merge does not come back reversed', async () => {
    const geral = byName('Geral'), geralt = byName('Geralt');
    const id = addSugg({ model_id: geral.id, type: 'merge', target_id: geralt.id, confidence: 0.9 });
    enrich.decide(db, [id], 'reject');
    expect(enrich.rejectedLookup(db, geralt.id)('merge', null, null, geral.id)).toBe(true);
    const client = stubClient(ev => ({ id: ev.id, merge: { into: ev.id === geral.id ? geralt.id : geral.id, c: 0.95 } }));
    await runWith([geral.id, geralt.id], client);
    expect(client.calls.flat().sort()).toEqual([geral.id, geralt.id].sort());
    expect(db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE type = 'merge' AND status = 'pending' AND model_id IN (?, ?)`).get(geral.id, geralt.id).n).toBe(0);
  });
});

// ── S4: undo memory, unmerge ─────────────────────────────────────────────────

describe('S4 undo and unmerge', () => {
  test('undo remembers the undone values as rejected; the next run does not write them again', async () => {
    const t = byName('Other Thing');
    const answer = ev => (ev.id === t.id ? { id: ev.id, character: { v: 'Thingamajig', c: 0.9 }, tags: { v: ['type:widget'], c: 0.9 } } : null);
    const { runId } = await runWith([t.id], stubClient(answer));
    expect(row(t.id).character).toBe('Thingamajig');
    const u = enrich.undoRun(db, runId);
    expect(u.reverted).toBe(2);
    expect(row(t.id).character).toBeNull();
    const mem = db.prepare(`SELECT field, proposed, status, source FROM suggestions WHERE run_id = ? AND source = 'undo' ORDER BY field`).all(runId);
    expect(mem).toEqual([
      { field: 'character', proposed: '"Thingamajig"', status: 'rejected', source: 'undo' },
      { field: 'tags', proposed: '["type:widget"]', status: 'rejected', source: 'undo' },
    ]);
    const again = await runWith([t.id], stubClient(answer));
    expect(again.counts).toMatchObject({ applied: 0, suggested: 0 });
    expect(row(t.id).character).toBeNull();
  });

  test('undo leaves fields the user set since, even to the same value', async () => {
    const t = byName('Other Thing');
    const { runId } = await runWith([t.id], stubClient(ev => ({ id: ev.id, franchise: { v: 'Video Games', c: 0.95 } })));
    expect(row(t.id).franchise).toBe('Video Games');
    await request(app).patch(`/api/models/${t.id}`).send({ franchise: 'Video Games' });
    expect(enrich.undoRun(db, runId)).toEqual({ reverted: 0, skipped: 1 });
    expect(row(t.id).franchise).toBe('Video Games');
  });

  test('no snapshot, no merge', () => {
    const geral = byName('Geral'), geralt = byName('Geralt');
    db.prepare(`DELETE FROM suggestions WHERE type = 'merge' AND model_id IN (?, ?)`).run(geral.id, geralt.id);
    const id = addSugg({ model_id: geral.id, type: 'merge', target_id: geralt.id, confidence: 0.9 });
    const r = enrich.decide(db, [id], 'accept', { snapshot: () => null });
    expect(r).toMatchObject({ merged: 0, backupError: expect.stringMatching(/backup/) });
    expect(sugg(id).status).toBe('pending');
    expect(row(geral.id).folded_into).toBeNull();
  });

  test('accept takes a pre-merge snapshot; unmerge restores the card, its files and its key, and drops the alias', async () => {
    const geral = byName('Geral'), geralt = byName('Geralt');
    const id = db.prepare(`SELECT id FROM suggestions WHERE type = 'merge' AND model_id = ? AND status = 'pending'`).get(geral.id).id;
    db.prepare(`UPDATE models SET hidden = 0 WHERE id = ?`).run(geral.id);
    const acc = await request(app).post('/api/suggestions/decide').send({ ids: [id], decision: 'accept' });
    expect(acc.body).toMatchObject({ merged: 1 });
    expect(fs.readdirSync(process.env.BACKUP_DIR).some(f => /^vault-pre-merge-.*\.db$/.test(f))).toBe(true);
    expect(row(geral.id).folded_into).toBe(geralt.id);
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(geralt.id).n).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) n FROM aliases WHERE from_key = 'Wicked|work|geral'`).get().n).toBe(1);

    const un = await request(app).post(`/api/suggestions/${id}/unmerge`);
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({ restored: { files: 1, alias: true }, notReverted: [expect.stringMatching(/tags/)] });
    expect(row(geral.id)).toMatchObject({ folded_into: null, hidden: 0, work_key: 'Wicked|work|geral' });
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(geral.id).n).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM aliases WHERE from_key = 'Wicked|work|geral'`).get().n).toBe(0);
    expect(sugg(id).status).toBe('rejected');
    expect((await request(app).post(`/api/suggestions/${id}/unmerge`)).status).toBe(409);
    expect((await request(app).post('/api/suggestions/999999/unmerge')).status).toBe(404);
    // the next scan keeps them apart
    await scanLibrary(LIB);
    expect(row(geral.id)).toMatchObject({ folded_into: null, hidden: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(geral.id).n).toBe(1);
  });
});

// ── S8: CSV-injection and variant-only values ────────────────────────────────

describe('S8 validation', () => {
  test('formula starts, HTML and variant words are rejected; tags too', () => {
    const v = enrich.validateResponse(JSON.stringify([
      { id: 1, character: { v: '=HYPERLINK("x")', c: 0.9 }, franchise: { v: '+DC', c: 0.9 }, group_name: { v: '@Team', c: 0.9 } },
      { id: 2, character: { v: '\tTab', c: 0.9 }, franchise: { v: '-1', c: 0.9 }, name: { v: '<b>x</b>', c: 0.9 }, tags: { v: ['=cmd', 'ok', '-x', '@y'], c: 0.9 } },
      { id: 3, character: { v: 'Supported', c: 0.9 }, group_name: { v: 'STL Files', c: 0.9 }, franchise: { v: 'Marvel', c: 0.9 } },
    ]), new Set([1, 2, 3]));
    expect(v.items.get(1)).toEqual({ id: 1 });
    expect(v.items.get(2)).toEqual({ id: 2, tags: { v: ['ok'], c: 0.9 } });
    expect(v.items.get(3)).toEqual({ id: 3, franchise: { v: 'Marvel', c: 0.9 } });
  });
});

// ── S10: truncated answers, failing batches, retry-after ─────────────────────

describe('S10 robustness', () => {
  test('salvageObjects keeps the complete items of a cut-off array', () => {
    expect(enrich.salvageObjects('[{"id":1,"why":"a } in a string"},{"id":2,"tags":{"v":["x"],"c":0.9}},{"id":3,"char')).toEqual([
      { id: 1, why: 'a } in a string' }, { id: 2, tags: { v: ['x'], c: 0.9 } },
    ]);
    expect(enrich.salvageObjects('nothing')).toEqual([]);
  });

  test('max_tokens: the complete items are kept and the rest are asked again in halves', async () => {
    const ids = ['Mystery Thing', 'Other Thing', 'Hellboy', 'Peace Maker'].map(n => byName(n).id);
    const answer = ev => ({ id: ev.id, why: 'stub' });
    const client = stubClient(answer, {
      0: (evs) => ({ content: [{ type: 'text', text: `[${JSON.stringify(answer(evs[0]))},{"id":${evs[1].id},"why":"cut` }], usage: { input_tokens: 10, output_tokens: 8000 }, stop_reason: 'max_tokens' }),
    });
    const { counts } = await runWith(ids, client);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]).toHaveLength(4);
    expect(client.calls[1].length + client.calls[2].length).toBe(3);
    expect(counts.done).toBe(4);
    expect(counts.stopped).toBeUndefined();
    const answered = db.prepare(`SELECT COUNT(*) n FROM models WHERE id IN (${ids.join(',')}) AND json_extract(enrichment, '$.runId') = (SELECT MAX(id) FROM enrich_runs)`).get().n;
    expect(answered).toBe(4);
  });

  test('3 failed batches in a row stop the run; nothing more is spent', async () => {
    let n = 0;
    const client = async () => { n++; throw new Error('Server error (500)'); };
    const cards = Array.from({ length: enrich.BATCH_SIZE * 5 }, (_, i) => ({ id: 100000 + i, name: `c${i}`, ev: { id: 100000 + i } }));
    const counts = await enrich.runEnrich({ db, cards, runId: 0, model: 'stub', apiKey: 't', client, sleep: async () => {} });
    expect(n).toBe(3);
    expect(counts.stopped).toMatch(/3 batches in a row failed/);
  });

  test('a rate limit waits the retry-after the API sent (capped at 2 minutes)', async () => {
    const t = byName('Mystery Thing');
    const waits = [];
    let n = 0;
    const ok = stubClient(ev => ({ id: ev.id }));
    const client = async (...a) => {
      n++;
      if (n === 1) { const e = new Error('Rate limited'); e.retryAfter = 7; throw e; }
      if (n === 2) { const e = new Error('Rate limited'); e.retryAfter = 900; throw e; }
      return ok(...a);
    };
    await runWith([t.id], client, { sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([7000, 120000]);
  });
});

// ── S11: estimate is approximate; the run reports what it spent ─────────────

describe('S11 spend', () => {
  test('estimate: approx, conservative output tokens, warning for a model without prices', async () => {
    const r = await request(app).get('/api/ai/enrich/estimate?scope=all&force=1');
    expect(r.body).toMatchObject({ approx: true, warning: expect.stringMatching(/claude-mystery-1/) });
    expect(r.body.text.outTokens).toBe(r.body.toProcess * Math.ceil(220 / 2.7));
  });

  test('the done event and the runs list carry actual tokens and USD', async () => {
    const r = await request(app).get('/api/ai/enrich?key=t&scope=all&force=1');
    const done = sseEvents(r.text).pop();
    expect(done).toMatchObject({ type: 'done', success: true, actualInTokens: expect.any(Number), actualOutTokens: expect.any(Number), actualUsd: expect.any(Number) });
    expect(done.actualInTokens).toBeGreaterThan(0);
    expect(done.actualUsd).toBeGreaterThan(0);
    const run = (await request(app).get('/api/ai/enrich/runs')).body.runs.find(x => x.id === done.runId);
    expect(run).toMatchObject({ actualInTokens: done.actualInTokens, actualOutTokens: done.actualOutTokens, actualUsd: done.actualUsd });
    expect(enrich.usdFor(1e6, 1e6, { inRate: 3, outRate: 15 })).toBe(18);
  });
});

// ── S12: GET endpoints that spend the key ────────────────────────────────────

describe('S12 spend guard', () => {
  const q = '/api/ai/enrich?scope=ids&ids=999999';
  test.each([
    ['cross-site, even with a key', `${q}&key=t`, { 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['a foreign Referer', `${q}&key=t`, { Referer: 'https://evil.example/page' }, 403],
    ['no key and not same-origin', q, {}, 403],
    ['no key, Sec-Fetch-Site none (typed URL)', q, { 'Sec-Fetch-Site': 'none' }, 403],
    ['a key parameter', `${q}&key=t`, {}, 200],
    ['an x-claude-key header', q, { 'x-claude-key': 't' }, 200],
    ['same-origin without a key (the app, server key)', q, { 'Sec-Fetch-Site': 'same-origin' }, 200],
    ['same-host Referer with a key', `${q}&key=t`, { Referer: 'http://127.0.0.1/' }, 200],
  ])('%s', async (_, url, headers, status) => {
    const req = request(app).get(url).set('Host', '127.0.0.1');
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    const r = await req;
    expect(r.status).toBe(status);
    if (status === 403) expect(r.body.error).toMatch(/API|another site/);
  });

  test.each(['/api/ai/generate-tags', '/api/ai/vision-tags', '/api/ai/find-images'])('%s is guarded too', async (u) => {
    expect((await request(app).get(u)).status).toBe(403);
    expect((await request(app).get(`${u}?key=t`).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
  });
});

// ── nits ─────────────────────────────────────────────────────────────────────

describe('nits', () => {
  test('ENRICH_AUTO_MIN below ENRICH_SUGGEST_MIN is raised to it, with a warning', () => {
    process.env.ENRICH_AUTO_MIN = '0.4';
    process.env.ENRICH_SUGGEST_MIN = '0.6';
    try {
      expect(enrich.thresholds()).toEqual({ auto: 0.6, suggest: 0.6 });
      expect(warn.mock.calls.some(c => /ENRICH_AUTO_MIN/.test(c[0]))).toBe(true);
    } finally { delete process.env.ENRICH_AUTO_MIN; delete process.env.ENRICH_SUGGEST_MIN; }
  });

  test('ENRICH_FAKE=1 without the dev fixture: a clear, fatal error', () => {
    jest.isolateModules(() => {
      jest.doMock('./fixtures/enrich-fake', () => { throw new Error("Cannot find module '../tests/fixtures/enrich-fake'"); });
      const e2 = require('../lib/enrich');
      let err;
      try { e2.getClient(); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.fatal).toBe(true);
      expect(err.message).toMatch(/ENRICH_FAKE=1 needs the dev fake model.*Unset ENRICH_FAKE/);
    });
    jest.dontMock('./fixtures/enrich-fake');
  });
});

// ── organizer export: filing rules (S1), moves (B1, S6, S7), unsafe values (S8) ──
// direct rows: two libraries with their own studio roots, files that need not exist

describe('organizer export', () => {
  const DAG = path.join(ROOT, 'exp', 'STL Archive');
  const END = path.join(ROOT, 'exp', '3dPrint');
  const libraries = [{ name: 'Dagobah', path: DAG }, { name: 'Endor', path: END }];
  let n = 0;
  const creator = () => {
    const c = db.prepare(`SELECT id FROM creators WHERE name = 'Wicked'`).get();
    return c ? c.id : db.prepare(`INSERT INTO creators (name) VALUES ('Wicked')`).run().lastInsertRowid;
  };
  const card = (o) => {
    n++;
    const attr = o.attribution || { fields: { character: 'sidecar', franchise: 'sidecar' } };
    const id = db.prepare(`INSERT INTO models (uuid, name, folder_path, creator_id, kind, studio, character, franchise, group_name, work_key, attribution, confidence, editions, tags)
      VALUES (?, ?, ?, ?, ?, 'Wicked', ?, ?, ?, ?, ?, 'exact', '[]', '[]')`)
      .run(`exp-${n}`, o.name, path.join(ROOT, 'exp', `#card-${n}`), creator(), o.kind || 'work', o.character, o.franchise, o.group || null, o.key, JSON.stringify(attr)).lastInsertRowid;
    for (const f of o.files) {
      const lib = f.lib === 'Endor' ? END : DAG;
      db.prepare('INSERT INTO model_files (model_id, filename, filepath, filetype, filesize, library, edition) VALUES (?,?,?,?,?,?,?)')
        .run(id, path.basename(f.rel), path.join(lib, f.rel), 'zip', 1000 + n, f.lib || 'Dagobah', f.edition || 'Bust');
    }
    return id;
  };
  let movesOut;
  const toOf = (from) => (movesOut.rows.find(r => r[1] === from) || [])[2];

  beforeAll(() => {
    db.prepare(`UPDATE models SET hidden = 1`).run(); // only this section's cards
    // B1: two releases of one character
    card({ name: 'Moon Knight Bust', key: 'Wicked|work|moon knight|r:base', character: 'Moon Knight', franchise: 'Marvel', files: [{ rel: 'Wicked Archive/Marvel/Moon Knight Bust STLs/a.zip' }] });
    card({ name: 'Moon Knight (2026)', key: 'Wicked|work|moon knight|r:2026-01', character: 'Moon Knight', franchise: 'Marvel', group: 'Moon Knight 2026',
      files: [{ rel: 'Wicked Archive/Marvel/Moon Knight Portrait Bust 2026/b.zip' }] });
    // B1: two cards proposed for one destination → neither
    card({ name: 'Loki', key: 'Wicked|work|loki', character: 'Loki', franchise: 'Marvel', files: [{ rel: 'Wicked Archive/Loki A/c.zip', edition: 'Sculpture' }] });
    card({ name: 'Loki Variant', key: 'Wicked|work|loki variant', character: 'Loki', franchise: 'Marvel', files: [{ rel: 'Wicked Archive/Loki B/d.zip', edition: 'Sculpture' }] });
    // B1: the destination holds another card's files
    card({ name: 'Spider Woman', key: 'Wicked|work|spider woman', character: 'Spider Woman', franchise: 'Marvel', files: [{ rel: 'Wicked Archive/Marvel/Spider Woman/Sculpture/e.zip', edition: 'Sculpture' }] });
    card({ name: 'Spider Woman Classic', key: 'Wicked|work|spider woman classic', character: 'Spider Woman', franchise: 'Marvel', files: [{ rel: 'Wicked Archive/Spider Woman Classic/f.zip', edition: 'Sculpture' }] });
    // B1: an empty segment
    card({ name: 'Mystery Bust', key: 'Wicked|work|mystery bust', character: 'Mystery', franchise: '???', files: [{ rel: 'Wicked Archive/Mystery/g.zip' }] });
    // S6: Endor's studio root is "Wicked"; a store download folder there is filed under it
    card({ name: 'Hulk', key: 'Wicked|work|hulk', character: 'Hulk', franchise: 'Marvel', files: [{ lib: 'Endor', rel: 'Wicked/Marvel/Hulk/h.zip', edition: 'Sculpture' }] });
    card({ name: 'Thor', key: 'Wicked|work|thor', character: 'Thor', franchise: 'Marvel', files: [{ lib: 'Endor', rel: 'Gumroad Downloads/Wicked - Thor Bust/i.zip' }] });
    card({ name: 'Vision', key: 'Wicked|work|vision', character: 'Vision', franchise: 'Marvel', files: [{ rel: 'Gumroad Downloads/Wicked - Vision Bust/j.zip' }] });
    // S7: a folder group of 3+ characters is a team; a one-character folder is not
    for (const ch of ['Batman Who Laughs', 'Red Death', 'Merciless']) {
      card({ name: ch, key: `Wicked|work|${ch.toLowerCase()}`, character: ch, franchise: 'DC', group: 'Dark Nights Metal', files: [{ rel: `Wicked Archive/DC/Dark Nights Metal/${ch}/k.zip` }] });
    }
    card({ name: 'Azrael', key: 'Wicked|work|azrael', character: 'Azrael', franchise: 'DC', group: 'Axreal', files: [{ rel: 'Wicked Archive/DC/Axreal/l.zip' }] });
    // S8: a value a spreadsheet would run
    card({ name: 'Evil', key: 'Wicked|work|evil', character: '=cmd|calc', franchise: 'Marvel', attribution: { userFields: ['character', 'franchise'] }, files: [{ rel: 'Wicked Archive/Evil/m.zip' }] });
    movesOut = ox.moves(db, { libraries });
  });

  test('B1: releases get their own character folder ("Moon Knight (2026)")', () => {
    expect(toOf('Wicked Archive/Marvel/Moon Knight Bust STLs')).toBe('Wicked Archive/Marvel/Moon Knight/Bust');
    expect(toOf('Wicked Archive/Marvel/Moon Knight Portrait Bust 2026')).toBe('Wicked Archive/Marvel/Moon Knight (2026)/Bust');
    expect(ox.characterSeg({ character: 'Daredevil', name: 'Daredevil', work_key: 'Wicked|work|daredevil|r:netflix' })).toBe('Daredevil (netflix)');
  });

  test('B1: duplicate destinations, destinations holding another card, empty segments are dropped', () => {
    expect(toOf('Wicked Archive/Loki A')).toBeUndefined();
    expect(toOf('Wicked Archive/Loki B')).toBeUndefined();
    expect(movesOut.dropped).toBeGreaterThanOrEqual(2);
    expect(toOf('Wicked Archive/Spider Woman Classic')).toBeUndefined();
    expect(toOf('Wicked Archive/Mystery')).toBeUndefined();
    const dest = movesOut.rows.map(r => `${r[0]}|${r[2].toLowerCase()}`);
    expect(new Set(dest).size).toBe(dest.length);
  });

  test('S6: the library\'s own studio root', () => {
    expect(ox.studioRoots(db, libraries)).toEqual(new Map([['Dagobah', 'Wicked Archive'], ['Endor', 'Wicked']]));
    expect(toOf('Gumroad Downloads/Wicked - Thor Bust')).toBe('Wicked/Marvel/Thor/Bust');
    expect(movesOut.rows.find(r => r[1] === 'Gumroad Downloads/Wicked - Thor Bust')[0]).toBe('Endor');
    expect(toOf('Gumroad Downloads/Wicked - Vision Bust')).toBe('Wicked Archive/Marvel/Vision/Bust');
  });

  test('S7: teams of 3+ characters are groups; a character\'s own or release folder is not', () => {
    expect(toOf('Wicked Archive/DC/Dark Nights Metal/Red Death')).toBe('Wicked Archive/DC/Dark Nights Metal/Red Death/Bust');
    expect(toOf('Wicked Archive/DC/Axreal')).toBe('Wicked Archive/DC/Azrael/Bust');
    expect(movesOut.text).not.toMatch(/Moon Knight 2026\/Moon Knight/);
    const rules = ox.filingRules(db, {}).rows;
    expect(rules).toContainEqual(['group', 'red death', 'Dark Nights Metal']);
    expect(rules.some(r => r[0] === 'group' && /azrael|moon knight/.test(r[1]))).toBe(false);
  });

  test('S8: rows with formula values are not exported', () => {
    expect(movesOut.text).not.toMatch(/=cmd/);
    expect(ox.genreMap(db, {}).text).not.toMatch(/=cmd/);
    expect(ox.modelJson(db, { libraries }).text).not.toMatch(/=cmd/);
  });

  test('S1: fix rules only for real typos, spelled like the organizer (jor-el)', () => {
    const ins = db.prepare(`INSERT INTO aliases (from_key, to_key, from_name, to_name, source) VALUES (?, ?, ?, ?, 'merge')`);
    ins.run('Wicked|work|poison', 'Wicked|work|poison ivy', 'Poison', 'Poison Ivy');
    ins.run('Wicked|work|ivy poison', 'Wicked|work|poison', 'Ivy Poison', 'Poison');
    ins.run('Wicked|work|jorel', 'Wicked|work|jor el', 'Jorel', 'Jor-El');
    ins.run('Wicked|work|dooku', 'Wicked|work|count dooku x', 'Dooku', '+Count');
    const rules = ox.filingRules(db, {}).rows.filter(r => r[0] === 'fix');
    expect(rules).toContainEqual(['fix', 'jorel', 'jor-el']);
    expect(rules.some(r => /poison/.test(r[1]))).toBe(false);
    expect(rules.some(r => /count/.test(r[2]))).toBe(false);
  });
});
