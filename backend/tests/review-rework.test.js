/**
 * Review rework (Casey, Nov 2026: 1,683 pending, none high-confidence, most of them two genres):
 * answer groups, accepting with an edited value, per-tag decisions, a summary that counts what the
 * list can show, and review rules (block / map / set) applied at once, to later Enrich answers and
 * in the prompt. No real API key: the client is an inline stub.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-review-rw-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
delete process.env.ENRICH_FAKE;
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;
delete process.env.CLAUDE_API_KEY;
delete process.env.ENRICH_AUTO_MIN;
delete process.env.ENRICH_SUGGEST_MIN;

let seq = 7000;
function mk(rel) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(seq += 31));
}
mk('Alpha Studio/Comics/Hero One/hero one.stl');
mk('Alpha Studio/Comics/Hero Two/hero two.stl');
mk('Alpha Studio/Comics/Hero Three/hero three.stl');
mk('Alpha Studio/Games/Knight/knight.stl');
mk('Beta Minis/Titus/titus.stl');
mk('Beta Minis/Goblin/goblin.stl');

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const enrich = require('../lib/enrich');
const rules = require('../lib/review-rules');

const PJ = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const byName = (n) => db.prepare('SELECT * FROM models WHERE LOWER(name) = LOWER(?) AND folded_into IS NULL').get(n);
const row = (id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id);
const sugg = (id) => db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
const addSugg = (o) => db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, confidence, status)
  VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(o.model_id, o.type || 'field', o.field, o.current === undefined ? null : JSON.stringify(o.current),
  JSON.stringify(o.proposed), o.confidence || 0.7).lastInsertRowid;
const clear = () => { db.exec('DELETE FROM suggestions'); db.exec('DELETE FROM review_rules'); };

function stubClient(answer) {
  return async (key, body) => {
    const content = body.messages[0].content;
    const text = typeof content === 'string' ? content : content.find(c => c.type === 'text').text;
    const evs = text.split('\n').slice(1).map(l => JSON.parse(l));
    stubClient.lastSystem = body.system;
    return { content: [{ type: 'text', text: JSON.stringify(evs.map(answer).filter(Boolean)) }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn' };
  };
}
const runWith = async (ids, client) => {
  const sel = enrich.selectCards(db, { scope: 'ids', ids: ids.join(','), force: true }, { libraryRoot: LIB });
  const runId = enrich.createRun(db, { model: 'stub', scope: 'ids', params: {} });
  const counts = await enrich.runEnrich({ db, cards: sel.cards, runId, model: 'stub', apiKey: 't', client, sleep: async () => {}, promptCtx: enrich.promptContext(db, {}) });
  enrich.finishRun(db, runId, counts, 'complete');
  return counts;
};

let ids, fresh;
beforeAll(async () => {
  await scanLibrary(LIB);
  ids = Object.fromEntries(['Hero One', 'Hero Two', 'Hero Three', 'Knight', 'Titus', 'Goblin'].map(n => [n, byName(n).id]));
  fresh = db.prepare('SELECT id, character, franchise, group_name, tags, attribution FROM models').all();
});
// every test starts from the scanned cards: no proposals, no rules, no accepted values
beforeEach(() => {
  clear();
  const put = db.prepare('UPDATE models SET character = ?, franchise = ?, group_name = ?, tags = ?, attribution = ? WHERE id = ?');
  for (const m of fresh) put.run(m.character, m.franchise, m.group_name, m.tags, m.attribution, m.id);
});
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('answer groups', () => {
  test('field proposals group by answer, largest first, with counts, empties and samples', async () => {
    for (const n of ['Hero One', 'Hero Two', 'Hero Three']) addSugg({ model_id: ids[n], field: 'franchise', proposed: 'Other Comics', confidence: 0.75 });
    addSugg({ model_id: ids.Knight, field: 'franchise', current: 'Fantasy', proposed: 'Video Games', confidence: 0.6 });
    const r = await request(app).get('/api/suggestions/groups?type=field&field=franchise');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, suggestions: 4 });
    expect(r.body.items[0]).toMatchObject({ proposed: 'Other Comics', count: 3, fromEmpty: 3, minConfidence: 0.75 });
    expect(r.body.items[0].samples).toHaveLength(3);
    expect(r.body.items[1]).toMatchObject({ proposed: 'Video Games', count: 1, fromEmpty: 0 });
  });

  test('a group is decided with its key, honouring the confidence floor', async () => {
    addSugg({ model_id: ids['Hero One'], field: 'franchise', proposed: 'Other Comics', confidence: 0.75 });
    const low = addSugg({ model_id: ids['Hero Two'], field: 'franchise', proposed: 'Other Comics', confidence: 0.55 });
    const g = (await request(app).get('/api/suggestions/groups?type=field&field=franchise')).body.items[0];
    const r = await request(app).post('/api/suggestions/decide-filter').send({ filter: { type: 'field', field: 'franchise', proposed: g.key, minConfidence: 0.7 }, decision: 'accept' });
    expect(r.body.accepted).toBe(1);
    expect(row(ids['Hero One']).franchise).toBe('Other Comics');
    expect(sugg(low).status).toBe('pending');
  });

  test('tags group per tag; deciding one tag splits the proposals and remembers a rejection', async () => {
    const a = addSugg({ model_id: ids.Knight, field: 'tags', current: [], proposed: ['knight', 'armor'] });
    const b = addSugg({ model_id: ids.Goblin, field: 'tags', current: [], proposed: ['armor'] });
    const g = (await request(app).get('/api/suggestions/groups?type=field&field=tags')).body;
    expect(g.items[0]).toMatchObject({ tag: 'armor', count: 2 });
    const r = await request(app).post('/api/suggestions/decide-filter').send({ filter: { type: 'field', field: 'tags', tag: 'armor' }, decision: 'reject' });
    expect(r.body.rejected).toBe(2);
    expect(PJ(sugg(a).proposed)).toEqual(['knight']);
    expect(sugg(a).status).toBe('pending');
    expect(sugg(b).status).toBe('superseded');
    expect(enrich.rejectedLookup(db, ids.Knight).tags()).toContain('armor');
    await request(app).post('/api/suggestions/decide-filter').send({ filter: { type: 'field', field: 'tags', tag: 'knight' }, decision: 'accept' });
    expect(PJ(row(ids.Knight).tags)).toContain('knight');
  });
});

describe('accept with an edited value', () => {
  test('one suggestion: the typed value is written as the user\'s own', async () => {
    const id = addSugg({ model_id: ids.Titus, field: 'character', proposed: 'Titus Varbonus' });
    const r = await request(app).post('/api/suggestions/decide').send({ ids: [id], decision: 'accept', value: 'Titus Warmhammer' });
    expect(r.body).toMatchObject({ accepted: 1, edited: 1 });
    const m = row(ids.Titus);
    expect(m.character).toBe('Titus Warmhammer');
    const attr = PJ(m.attribution, {});
    expect(attr.fields.character).toBe('user');
    expect(attr.userFields).toContain('character');
  });

  test('an invalid typed value is refused per item, nothing written', async () => {
    const id = addSugg({ model_id: ids.Goblin, field: 'franchise', proposed: 'Fantasy' });
    const r = await request(app).post('/api/suggestions/decide').send({ ids: [id], decision: 'accept', value: '=HYPERLINK("x")' });
    expect(r.body.accepted).toBe(0);
    expect(r.body.errors[0].error).toMatch(/not a valid/);
    expect(sugg(id).status).toBe('pending');
  });
});

describe('summary', () => {
  test('counts only proposals the list can show, and reports the best confidence and rule count', async () => {
    addSugg({ model_id: ids.Knight, field: 'franchise', proposed: 'Video Games', confidence: 0.72 });
    db.prepare(`INSERT INTO suggestions (model_id, type, field, proposed, confidence, status) VALUES (999999, 'field', 'franchise', '"X"', 0.9, 'pending')`).run();
    const s = (await request(app).get('/api/suggestions/summary')).body;
    expect(s.pending).toBe(1);
    expect(s.maxConfidence).toBe(0.72);
    expect(s.rules).toBe(0);
  });
});

describe('review rules', () => {
  test('block: pending proposals of that value are rejected at once', async () => {
    const id = addSugg({ model_id: ids.Knight, field: 'franchise', proposed: '2023 - 02 February Release - Mist of the Jungle' });
    const keep = addSugg({ model_id: ids.Goblin, field: 'franchise', proposed: 'Fantasy' });
    const r = await request(app).post('/api/review-rules').send({ kind: 'block', field: 'franchise', match: '2023 - 02 February Release - Mist of the Jungle' });
    expect(r.status).toBe(201);
    expect(r.body.applied.rejected).toBe(1);
    expect(sugg(id).status).toBe('rejected');
    expect(sugg(keep).status).toBe('pending');
    expect(r.body.rule.label).toMatch(/Never propose/);
  });

  test('map: pending proposals are rewritten, and the same answer later arrives mapped', async () => {
    const id = addSugg({ model_id: ids.Titus, field: 'character', proposed: 'Titus Varbonus' });
    await request(app).post('/api/review-rules').send({ kind: 'map', field: 'character', match: 'Titus Varbonus', value: 'Titus Warmhammer' });
    expect(PJ(sugg(id).proposed)).toBe('Titus Warmhammer');
    db.exec('DELETE FROM suggestions');
    await runWith([ids.Titus], stubClient(ev => ({ id: ev.id, character: { v: 'Titus Varbonus', c: 0.7 } })));
    const p = db.prepare(`SELECT proposed FROM suggestions WHERE model_id = ? AND field = 'character' AND status = 'pending'`).get(ids.Titus);
    expect(PJ(p.proposed)).toBe('Titus Warmhammer');
  });

  test('block applies to later Enrich answers, and every rule reaches the prompt', async () => {
    await request(app).post('/api/review-rules').send({ kind: 'block', field: 'franchise', match: 'Wildcard' });
    await runWith([ids.Goblin], stubClient(ev => ({ id: ev.id, franchise: { v: 'Wildcard', c: 0.7 } })));
    expect(db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE model_id = ? AND field = 'franchise'`).get(ids.Goblin).n).toBe(0);
    expect(stubClient.lastSystem).toMatch(/owner's rules[\s\S]*Never propose "Wildcard" as a genre/);
  });

  test('set (folder scope): writes the value with provenance review-rule, skips the user\'s own values, clears proposals', async () => {
    const own = ids['Hero Three'];
    const a = PJ(row(own).attribution, {});
    db.prepare(`UPDATE models SET franchise = 'Mine', attribution = ? WHERE id = ?`).run(JSON.stringify({ ...a, userFields: ['franchise'] }), own);
    const pend = addSugg({ model_id: ids['Hero One'], field: 'franchise', proposed: 'Wildcard' });
    const r = await request(app).post('/api/review-rules').send({ kind: 'set', field: 'franchise', value: 'Comics', path: path.join(LIB, 'Alpha Studio', 'Comics') });
    expect(r.status).toBe(201);
    expect(r.body.applied.cardsSet).toBe(2);
    expect(row(ids['Hero One']).franchise).toBe('Comics');
    expect(PJ(row(ids['Hero One']).attribution, {}).fields.franchise).toBe('review-rule');
    expect(row(own).franchise).toBe('Mine');
    expect(row(ids.Knight).franchise).not.toBe('Comics');
    expect(sugg(pend).status).toBe('superseded');
    // later answers for the field are dropped for cards in scope
    await runWith([ids['Hero Two']], stubClient(ev => ({ id: ev.id, franchise: { v: 'Wildcard', c: 0.99 } })));
    expect(row(ids['Hero Two']).franchise).toBe('Comics');
    // deleting with revert clears what it wrote, not the user's value
    const del = await request(app).delete(`/api/review-rules/${r.body.rule.id}?revert=1`);
    expect(del.body.reverted).toBe(2);
    expect(row(ids['Hero One']).franchise).toBeNull();
    expect(row(own).franchise).toBe('Mine');
  });

  test('a set rule survives a rescan', async () => {
    // (the rescan re-keys nothing here, so ids stay valid for later tests)
    await request(app).post('/api/review-rules').send({ kind: 'set', field: 'group_name', value: 'Goblins', creator: 'Beta Minis' });
    expect(row(ids.Goblin).group_name).toBe('Goblins');
    await scanLibrary(LIB);
    expect(byName('Goblin').group_name).toBe('Goblins');
  });

  test('validation: unknown kinds, wrong fields, unscoped set rules and paths outside the library are refused', async () => {
    expect((await request(app).post('/api/review-rules').send({ kind: 'nope', field: 'franchise' })).status).toBe(400);
    expect((await request(app).post('/api/review-rules').send({ kind: 'set', field: 'character', value: 'X', creator: 'Beta Minis' })).status).toBe(400);
    expect((await request(app).post('/api/review-rules').send({ kind: 'set', field: 'franchise', value: 'X' })).status).toBe(400);
    expect((await request(app).post('/api/review-rules').send({ kind: 'set', field: 'franchise', value: 'X', path: '/etc' })).status).toBe(400);
    expect((await request(app).post('/api/review-rules').send({ kind: 'map', field: 'franchise', match: 'A', value: 'a' })).status).toBe(400);
  });

  test('the same rule twice is stored once; list and delete', async () => {
    const b = { kind: 'block', field: 'tags', match: 'Junk' };
    const one = (await request(app).post('/api/review-rules').send(b)).body.rule;
    const two = (await request(app).post('/api/review-rules').send(b)).body.rule;
    expect(two.id).toBe(one.id);
    expect(one.match).toBe('junk');
    expect((await request(app).get('/api/review-rules')).body.items).toHaveLength(1);
    expect((await request(app).delete(`/api/review-rules/${one.id}`)).status).toBe(200);
    expect(rules.listRules(db)).toHaveLength(0);
  });

  test('block on a tag removes it from pending tag proposals and from later answers', async () => {
    const id = addSugg({ model_id: ids.Knight, field: 'tags', current: [], proposed: ['junk', 'armor'] });
    await request(app).post('/api/review-rules').send({ kind: 'block', field: 'tags', match: 'junk' });
    expect(PJ(sugg(id).proposed)).toEqual(['armor']);
  });
});

describe('known values', () => {
  test('values already on cards come first; genres include the built-in list', async () => {
    db.prepare(`UPDATE models SET franchise = 'Comics' WHERE id IN (?, ?)`).run(ids['Hero One'], ids['Hero Two']);
    const r = (await request(app).get('/api/suggestions/values?field=franchise')).body.values;
    expect(r[0]).toBe('Comics');
    expect(r.length).toBeGreaterThan(3);
    expect((await request(app).get('/api/suggestions/values?field=bogus')).body.values).toEqual([]);
  });
});
