/**
 * AI enrichment (docs/ai-enrichment.md, CONTRACT3): evidence, signatures, validation, the apply
 * policy, the review list, merges (fold + alias + rescan), undo, organizer export, the
 * generate-tags alias, the one-AI-job lock and client disconnects. No real API key: the Claude
 * client is the dev fake model (tests/fixtures/enrich-fake.js) or an inline stub.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-enrich-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
process.env.ENRICH_FAKE = '1';
process.env.ENRICH_FAKE_DELAY_MS = '0';
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;
delete process.env.CLAUDE_API_KEY;
delete process.env.ENRICH_AUTO_MIN;
delete process.env.ENRICH_SUGGEST_MIN;

let seq = 7000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 31)));
  return full;
}
mk('Wicked/Video Games/Geral/Wicked - Geral Sculpture (One Piece).zip');
mk('Wicked/Video Games/Geralt/Wicked - Geralt Bust (Non Supported).zip');
mk('B3DSERK/DC/Alan Scott/B3DSERK - Alan Scott Bust 390mm (Non Supported).zip');
mk('B3DSERK/DC/Alan Scott/B3DSERK - Alan Scott Sculpture (One Piece).zip');
mk('B3DSERK/DC/Hellboy/B3DSERK - Hellboy Sculpture (One Piece).zip');
mk('B3DSERK/DC/Peacemaker/B3DSERK - Peace Maker Bust (Non Supported).zip');
mk('ArchVillian Games/2022-07 - Howling Horde/Nashgur - Infernal Emissary/nashgur.stl');
mk('ArchVillian Games/2022-07 - Howling Horde/Gnoll Brutes/brute.stl');
mk('Misc/Mystery Thing/thing.stl');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const enrich = require('../lib/enrich');
const fake = require('./fixtures/enrich-fake');
const { acquireAiJob } = require('../lib/jobs');

const byName = (n) => db.prepare('SELECT * FROM models WHERE name = ? AND folded_into IS NULL').get(n);
const sseEvents = (text) => String(text).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
const PJ = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

beforeAll(async () => { await scanLibrary(LIB); });
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── evidence + signature ────────────────────────────────────────────────────

describe('evidence', () => {
  const card = {
    id: 143, name: 'Alan Scott', kind: 'work', creator_name: 'B3DSERK', creator_id: 5, studio: 'Wicked', library: 'Endor',
    creator_folder: '/library/3dPrint/Wicked', folder_path: '/library/3dPrint/Wicked/DC/Alan Scott', character: 'Alan Scott', franchise: 'DC', group_name: null,
    editions: '["Sculpture","Bust"]', tags: '[]',
    attribution: JSON.stringify({ confidence: 'exact', fields: { franchise: 'path', character: 'parse' }, conflicts: [{ field: 'franchise', pathValue: 'DC', metaValue: 'Star Wars' }] }),
    products: JSON.stringify([{ name: 'B3DSERK June term 2023: Alan Scott Sculpture', termLabel: 'June 2023' }, { name: 'B3DSERK June term 2023: Alan Scott Bust' }]),
    release_term: '2023-06',
  };
  const files = ['B3DSERK - Alan Scott Bust 390mm (Non Supported).zip', 'B3DSERK - Alan Scott Bust 390mm (Chitubox Pre Supported).zip',
    'B3DSERK - Alan Scott Sculpture (One Piece).zip', 'render_01.png', 'Throne.stl', 'Cape_Full.stl'];

  test('compact fields with provenance, path below the creator, stems without variants, products, terms, conflicts, similar', () => {
    const ev = enrich.buildEvidence(card, files, { similar: new Map([[143, [{ id: 144, name: 'Alan Scott Bust', score: 0.9 }]]]) });
    expect(ev).toMatchObject({ id: 143, kind: 'work', creator: 'B3DSERK', studio: 'Wicked', lib: 'Endor' });
    expect(ev.cur).toEqual({ name: 'Alan Scott', character: ['Alan Scott', 'parse'], franchise: ['DC', 'path'], editions: ['Sculpture', 'Bust'] });
    expect(ev.path).toEqual(['DC', 'Alan Scott']);
    expect(ev.files).toEqual(expect.arrayContaining(['B3DSERK Alan Scott Bust', 'B3DSERK Alan Scott Sculpture', 'Throne']));
    expect(ev.files.some(f => /support|piece|render/i.test(f))).toBe(false); // variants and images stripped
    expect(new Set(ev.files.map(f => f.toLowerCase())).size).toBe(ev.files.length);
    expect(ev.products).toHaveLength(2);
    expect(ev.terms).toEqual(expect.arrayContaining(['2023-06', 'June 2023']));
    expect(ev.conflicts[0]).toMatch(/franchise: path=DC, meta=Star Wars/);
    expect(ev.similar).toEqual([{ id: 144, name: 'Alan Scott Bust' }]);
    expect(JSON.stringify(ev).length).toBeLessThan(900);
  });

  test('user fields show as provenance "user"; empty values are left out', () => {
    const ev = enrich.buildEvidence({ ...card, group_name: null, editions: '[]', attribution: JSON.stringify({ fields: { franchise: 'path' }, userFields: ['franchise'] }) }, [], {});
    expect(ev.cur.franchise).toEqual(['DC', 'user']);
    expect(ev.cur.editions).toBeUndefined();
    expect(ev.cur.group_name).toBeUndefined();
  });

  test('signature skip: an unchanged card is skipped on the next run; a change brings it back', async () => {
    const first = enrich.selectCards(db, { scope: 'all' }, { libraryRoot: LIB });
    expect(first.cards.length).toBeGreaterThan(5);
    const r = await request(app).get('/api/ai/enrich?key=t&scope=all');
    expect(sseEvents(r.text).pop()).toMatchObject({ type: 'done', success: true });
    const again = enrich.selectCards(db, { scope: 'all' }, { libraryRoot: LIB });
    expect(again.cards).toHaveLength(0);
    expect(again.skipped).toBe(first.total);
    const brute = byName('Gnoll Brutes');
    await request(app).patch(`/api/models/${brute.id}`).send({ notes: 'not evidence' });
    expect(enrich.selectCards(db, { scope: 'all' }, { libraryRoot: LIB }).cards).toHaveLength(0); // notes are not evidence
    await request(app).patch(`/api/models/${brute.id}`).send({ group_name: 'Howling Horde' });
    expect(enrich.selectCards(db, { scope: 'all' }, { libraryRoot: LIB }).cards.map(c => c.id)).toEqual([brute.id]);
  });
});

// ── response validation ─────────────────────────────────────────────────────

describe('validateResponse', () => {
  const batch = new Map([[1, { id: 1, similar: [{ id: 9, name: 'Geralt' }] }], [2, { id: 2 }]]);
  test('malformed JSON is a batch error', () => {
    const v = enrich.validateResponse('Sure! Here you go: [{"id": 1, "character": {"v": "X", ', batch);
    expect(v.fatal).toBe(true);
    expect(v.items.size).toBe(0);
    expect(v.errors[0]).toMatch(/malformed JSON/);
  });
  test('code fences and {items:[...]} are accepted', () => {
    expect(enrich.validateResponse('```json\n[{"id":2,"tags":{"v":["type:bust"],"c":0.9}}]\n```', batch).items.get(2).tags.v).toEqual(['type:bust']);
    expect(enrich.validateResponse('{"items":[{"id":2,"tags":{"v":["x"],"c":0.9}}]}', batch).items.size).toBe(1);
  });
  test('unknown ids, out-of-range confidences, bad values and foreign merge targets are dropped per item', () => {
    const v = enrich.validateResponse(JSON.stringify([
      { id: 1, character: { v: 'Geralt of Rivia', c: 1.4 }, franchise: { v: 'Video Games', c: 0.9 }, editions: { v: ['Bust', 'Poster'], c: 0.9 }, merge: { into: 77, c: 0.9 } },
      { id: 2, group_name: { v: '', c: 0.9 }, tags: { v: ['Theme:Fantasy ', 'theme:fantasy', 42], c: 0.8 }, merge: { into: 1, c: 0.9 }, needs_vision: true, why: 'hm' },
      { id: 3, character: { v: 'Nobody', c: 0.9 } },
      'nonsense',
    ]), batch);
    expect([...v.items.keys()]).toEqual([1, 2]);
    expect(v.items.get(1).character).toBeUndefined();
    expect(v.items.get(1).franchise).toEqual({ v: 'Video Games', c: 0.9 });
    expect(v.items.get(1).editions).toBeUndefined();
    expect(v.items.get(1).merge).toBeUndefined();
    expect(v.items.get(2).tags.v).toEqual(['theme:fantasy']);
    expect(v.items.get(2).merge).toBeUndefined(); // 2 has no similar list → any id allowed? no: 1 is in the batch but not similar
    expect(v.items.get(2).needs_vision).toBe(true);
    expect(v.errors.join('\n')).toMatch(/unknown id 3/);
    expect(v.errors.join('\n')).toMatch(/1\.character: confidence out of range/);
    expect(v.errors.join('\n')).toMatch(/1\.merge: target 77/);
  });
});

// ── apply policy ────────────────────────────────────────────────────────────

describe('planActions (apply policy + protection)', () => {
  const ctx = (o = {}) => ({ ...enrich.thresholds(), isKnownGenre: (g) => ['DC', 'Marvel', 'Video Games', 'Star Wars'].includes(g), rejected: () => false, ...o });
  const base = { id: 1, name: 'Geral', character: null, franchise: null, group_name: null, editions: '[]', tags: '[]', name_locked: 0, attribution: '{}' };
  const ans = (o) => ({ id: 1, ...o });
  const run = (card, a, c) => enrich.planActions({ ...base, ...card }, ans(a), ctx(c));

  test.each([
    ['empty + high confidence → applied', {}, { character: { v: 'Geralt of Rivia', c: 0.85 } }, 'apply'],
    ['empty + medium confidence → suggested', {}, { character: { v: 'Geralt of Rivia', c: 0.6 } }, 'suggest'],
    ['empty + below suggest → dropped', {}, { character: { v: 'Geralt of Rivia', c: 0.3 } }, 'none'],
    ['filled (parse) + very high → suggested, never overwritten', { character: 'Geral', attribution: '{"fields":{"character":"parse"}}' }, { character: { v: 'Geralt of Rivia', c: 0.99 } }, 'suggest'],
    ['genre folder (path) → suggested', { franchise: 'Movies', attribution: '{"fields":{"franchise":"path"}}' }, { franchise: { v: 'Video Games', c: 0.95 } }, 'suggest'],
    ['model.json (sidecar) → not even proposed', { franchise: 'Movies', attribution: '{"fields":{"franchise":"sidecar"}}' }, { franchise: { v: 'Video Games', c: 0.95 } }, 'none'],
    ['user field → not proposed', { franchise: 'Movies', attribution: '{"userFields":["franchise"]}' }, { franchise: { v: 'Video Games', c: 0.95 } }, 'none'],
    ['user field even when empty → not applied', { attribution: '{"userFields":["group_name"]}' }, { group_name: { v: 'The Witcher', c: 0.95 } }, 'none'],
    ['accepted before (ai-reviewed) → not proposed', { group_name: 'Witcher', attribution: '{"fields":{"group_name":"ai-reviewed"}}' }, { group_name: { v: 'The Witcher', c: 0.95 } }, 'none'],
    ['new genre, even empty and certain → review', {}, { franchise: { v: 'Tabletop Fantasy', c: 0.97 } }, 'suggest'],
    ['editions only when parsing found none', { editions: '["Bust"]' }, { editions: { v: ['Sculpture'], c: 0.95 } }, 'none'],
    ['same value → nothing', { character: 'Geralt of Rivia' }, { character: { v: 'geralt of rivia', c: 0.95 } }, 'none'],
  ])('%s', (_, card, a, expected) => {
    const p = run(card, a);
    const got = p.apply.length ? 'apply' : p.suggest.length ? 'suggest' : 'none';
    expect(got).toBe(expected);
  });

  test('names are only proposed (rename), never applied; a locked name is left alone', () => {
    expect(run({}, { name: { v: 'Geralt', c: 0.99 } })).toEqual({ apply: [], suggest: [expect.objectContaining({ type: 'rename', proposed: 'Geralt' })] });
    expect(run({ name_locked: 1 }, { name: { v: 'Geralt', c: 0.99 } }).suggest).toEqual([]);
  });

  test('tags are additive and capped at 12', () => {
    const have = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const p = run({ tags: JSON.stringify(have) }, { tags: { v: ['t1', 'theme:witcher', 'type:bust', 'theme:fantasy'], c: 0.9 } });
    expect(p.apply[0].value).toEqual([...have, 'theme:witcher', 'type:bust']);
    expect(p.apply[0].value).toHaveLength(12);
  });

  test('thresholds come from ENRICH_AUTO_MIN / ENRICH_SUGGEST_MIN', () => {
    process.env.ENRICH_AUTO_MIN = '0.95';
    process.env.ENRICH_SUGGEST_MIN = '0.7';
    try {
      expect(run({}, { character: { v: 'Geralt of Rivia', c: 0.9 } }).suggest).toHaveLength(1);
      expect(run({}, { character: { v: 'Geralt of Rivia', c: 0.65 } })).toEqual({ apply: [], suggest: [] });
    } finally { delete process.env.ENRICH_AUTO_MIN; delete process.env.ENRICH_SUGGEST_MIN; }
  });

  test('a rejected proposal is not made again; merges need a confident answer', () => {
    const rejected = (type, field, proposed) => type === 'field' && field === 'character' && proposed === 'Geralt of Rivia';
    expect(run({}, { character: { v: 'Geralt of Rivia', c: 0.6 } }, { rejected }).suggest).toEqual([]);
    expect(run({}, { merge: { into: 9, c: 0.4 } }).suggest).toEqual([]);
    expect(run({}, { merge: { into: 9, c: 0.9 } }).suggest[0]).toMatchObject({ type: 'merge', targetId: 9 });
  });
});

// ── the loop through the API ────────────────────────────────────────────────

describe('run, review, merge, undo (API)', () => {
  let runId;
  beforeAll(async () => {
    // a fresh run over everything (the signature test above already ran once)
    const r = await request(app).get('/api/ai/enrich?key=t&scope=all&force=1');
    const done = sseEvents(r.text).pop();
    runId = done.runId;
  });

  test('estimate: counts, batches, tokens and USD per pass', async () => {
    const r = await request(app).get('/api/ai/enrich/estimate?scope=all&vision=1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: expect.any(String), toProcess: expect.any(Number), unchanged: expect.any(Number), batches: expect.any(Number) });
    expect(r.body.text).toEqual({ inTokens: expect.any(Number), outTokens: expect.any(Number), usd: expect.any(Number) });
    expect(r.body.vision).toMatchObject({ maxItems: 0 }); // no renders in this library
    const forced = await request(app).get('/api/ai/enrich/estimate?scope=all&force=1');
    expect(forced.body.toProcess).toBeGreaterThan(5);
    expect(forced.body.text.inTokens).toBeGreaterThan(forced.body.toProcess * 40);
    expect(forced.body.text.outTokens).toBe(forced.body.toProcess * enrich.OUT_TOKENS_PER_ITEM);
  });

  test('a run applied empty fields and queued the rest for review', async () => {
    const runs = (await request(app).get('/api/ai/enrich/runs')).body.runs;
    expect(runs[0]).toMatchObject({ id: runId, model: expect.stringMatching(/fake/), applied: expect.any(Number), undone: false });
    expect(byName('Nashgur - Infernal Emissary').character).toBe('Nashgur'); // empty → applied
    const nash = byName('Nashgur - Infernal Emissary');
    expect(PJ(nash.attribution).fields.character).toBe('ai');
    expect(PJ(nash.attribution).ai.character).toBeGreaterThanOrEqual(0.8);
    const sum = (await request(app).get('/api/suggestions/summary')).body;
    expect(sum.pending).toBeGreaterThan(0);
    expect(sum.byType.merge).toBeGreaterThanOrEqual(1);
    const hb = byName('Hellboy');
    expect(hb.franchise).toBe('DC'); // genre folder: never overwritten
    const list = (await request(app).get(`/api/suggestions?field=franchise`)).body;
    expect(list.items.find(i => i.model.id === hb.id)).toMatchObject({ type: 'field', field: 'franchise', current: 'DC', proposed: 'Other Comics (Image:Top Cow: Dark horse, etc)', source: 'text', status: 'pending' });
  });

  test('model detail: enrichment, userFields, pending suggestions', async () => {
    const hb = byName('Hellboy');
    const d = (await request(app).get(`/api/models/${hb.id}`)).body;
    expect(d.enrichment).toMatchObject({ at: expect.any(String), runId: expect.any(Number) });
    expect(d.suggestions.some(s => s.field === 'franchise')).toBe(true);
  });

  test('suggestion lifecycle: accept writes ai-reviewed; reject is remembered; a user edit supersedes', async () => {
    const pm = byName('Peace Maker');
    const rn = (await request(app).get('/api/suggestions?type=rename')).body.items.find(i => i.model.id === pm.id);
    expect(rn).toMatchObject({ current: 'Peace Maker', proposed: 'Peacemaker' });
    const acc = await request(app).post('/api/suggestions/decide').send({ ids: [rn.id], decision: 'accept' });
    expect(acc.body).toMatchObject({ accepted: 1, rejected: 0, merged: 0, errors: [] });
    const after = db.prepare('SELECT * FROM models WHERE id = ?').get(pm.id);
    expect(after.name).toBe('Peacemaker');
    expect(after.name_locked).toBe(1);
    expect(PJ(after.attribution).fields.name).toBe('ai-reviewed');

    const hb = byName('Hellboy');
    const fr = (await request(app).get('/api/suggestions?field=franchise')).body.items.find(i => i.model.id === hb.id);
    const rej = await request(app).post('/api/suggestions/decide').send({ ids: [fr.id], decision: 'reject' });
    expect(rej.body.rejected).toBe(1);
    await request(app).get(`/api/ai/enrich?key=t&scope=ids&ids=${hb.id}&force=1`);
    const again = db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE model_id = ? AND field = 'franchise' AND status = 'pending'`).get(hb.id).n;
    expect(again).toBe(0); // the same proposal is not made again

    const a = byName('Alan Scott');
    db.prepare(`INSERT INTO suggestions (model_id, type, field, current, proposed, confidence, status) VALUES (?, 'field', 'group_name', NULL, '"JSA"', 0.6, 'pending')`).run(a.id);
    await request(app).patch(`/api/models/${a.id}`).send({ group_name: 'Justice Society of America' });
    expect(db.prepare(`SELECT status FROM suggestions WHERE model_id = ? AND field = 'group_name' ORDER BY id DESC`).get(a.id).status).toBe('superseded');
    expect(PJ(db.prepare('SELECT attribution FROM models WHERE id = ?').get(a.id).attribution).userFields).toContain('group_name');
  });

  test('merge accept folds the card (user data kept), stores an alias, and survives a rescan', async () => {
    const geral = byName('Geral'), geralt = byName('Geralt');
    await request(app).patch(`/api/models/${geral.id}`).send({ tags: ['witcher-wip'], print_status: 'printed' });
    const m = (await request(app).get('/api/suggestions?type=merge')).body.items.find(i => i.model.id === geral.id);
    expect(m).toMatchObject({ type: 'merge', target: { id: geralt.id, name: 'Geralt' }, confidence: 0.9 });
    const res = await request(app).post('/api/suggestions/decide').send({ ids: [m.id], decision: 'accept' });
    expect(res.body).toMatchObject({ accepted: 1, merged: 1 });
    const src = db.prepare('SELECT * FROM models WHERE id = ?').get(geral.id);
    expect(src).toMatchObject({ hidden: 1, folded_into: geralt.id });
    const tgt = db.prepare('SELECT * FROM models WHERE id = ?').get(geralt.id);
    expect(PJ(tgt.tags)).toContain('witcher-wip');
    expect(tgt.print_status).toBe('printed');
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(geralt.id).n).toBe(2);
    expect(db.prepare('SELECT * FROM aliases WHERE from_key = ?').get('Wicked|work|geral')).toMatchObject({ to_key: 'Wicked|work|geralt', source: 'merge' });

    await scanLibrary(LIB);
    const visible = db.prepare(`SELECT id, name FROM models WHERE work_key LIKE 'Wicked|work|geral%' AND folded_into IS NULL AND hidden = 0`).all();
    expect(visible).toEqual([{ id: geralt.id, name: 'Geralt' }]);
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(geralt.id).n).toBe(2);
    expect(db.prepare('SELECT folded_into FROM models WHERE id = ?').get(geral.id).folded_into).toBe(geralt.id);
    // values the AI filled and the user set survive the rescan
    expect(byName('Nashgur - Infernal Emissary').character).toBe('Nashgur');
    expect(byName('Alan Scott').group_name).toBe('Justice Society of America');
    expect(byName('Peacemaker')).toBeTruthy();
  });

  test('decide-filter applies a decision to every pending match', async () => {
    const before = enrich.summary(db).byField.tags || 0;
    const r = await request(app).post('/api/suggestions/decide-filter').send({ filter: { type: 'field', field: 'tags' }, decision: 'reject' });
    expect(r.body.rejected).toBe(before);
    expect(enrich.summary(db).byField.tags || 0).toBe(0);
  });

  test('undo reverts the run\'s automatic writes, except fields changed since', async () => {
    const r = await request(app).get('/api/ai/enrich?key=t&scope=all&force=1');
    const done = sseEvents(r.text).pop();
    const logs = db.prepare('SELECT * FROM enrich_log WHERE run_id = ?').all(done.runId);
    expect(logs.length).toBeGreaterThan(0);
    // simulate cards whose automatic writes we can follow
    const card = db.prepare(`SELECT * FROM models WHERE id = ?`).get(logs[0].model_id);
    const changed = logs.find(l => l.model_id !== card.id && l.field === 'tags');
    if (changed) await request(app).patch(`/api/models/${changed.model_id}`).send({ tags: ['mine'] });
    const u = await request(app).post(`/api/ai/enrich/runs/${done.runId}/undo`);
    expect(u.status).toBe(200);
    expect(u.body.reverted).toBe(logs.length - (changed ? 1 : 0));
    const fresh = db.prepare('SELECT * FROM models WHERE id = ?').get(card.id);
    const l0 = logs.filter(l => l.model_id === card.id && l.field === logs[0].field).pop();
    const now = enrich.fieldState(fresh, l0.field).value;
    expect(JSON.stringify(now ?? null)).toBe(JSON.stringify(PJ(logs.filter(l => l.model_id === card.id && l.field === l0.field)[0].old_value, null)));
    if (changed) expect(PJ(db.prepare('SELECT tags FROM models WHERE id = ?').get(changed.model_id).tags)).toEqual(['mine']);
    const runs = (await request(app).get('/api/ai/enrich/runs')).body.runs;
    expect(runs.find(x => x.id === done.runId).undone).toBe(true);
    expect((await request(app).post('/api/ai/enrich/runs/99999/undo')).status).toBe(404);
  });
});

// ── organizer export ────────────────────────────────────────────────────────

describe('organizer export', () => {
  beforeAll(async () => {
    const a = byName('Alan Scott');
    // a user-set group with a comma and quotes, and a user genre → exported
    await request(app).patch(`/api/models/${a.id}`).send({ group_name: 'Justice Society, "Golden Age"' });
    const hb = byName('Hellboy');
    await request(app).patch(`/api/models/${hb.id}`).send({ franchise: 'Other Comics (Image:Top Cow: Dark horse, etc)', character: 'Hellboy' });
  });

  test('index lists the files with row counts and a cursor', async () => {
    const r = await request(app).get('/api/organizer/export');
    expect(r.body.files.map(f => f.name)).toEqual(['genre_map.csv', 'filing_rules.csv', 'model_json.ndjson', 'moves.csv', 'folder_roles.csv']);
    for (const f of r.body.files) expect(f).toEqual({ name: f.name, url: `/api/organizer/export/${f.name}`, rows: expect.any(Number) });
    expect(r.body.cursor).toBe(r.body.generatedAt);
  });

  test('genre_map.csv: user/reviewed genres, CSV quoting', async () => {
    const r = await request(app).get('/api/organizer/export/genre_map.csv');
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="genre_map.csv"');
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe('character,genre');
    expect(lines).toContain('Hellboy,"Other Comics (Image:Top Cow: Dark horse, etc)"');
    expect(lines.some(l => /^Alan Scott,/.test(l))).toBe(false); // genre from the folder: the organizer has it already
  });

  test('filing_rules.csv: fix rows from aliases, group rows keyed like file_inbox.py key()', async () => {
    const r = await request(app).get('/api/organizer/export/filing_rules.csv');
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe('kind,key,value');
    expect(lines).toContain('fix,geral,geralt');
    expect(lines).toContain('group,alan scott,"Justice Society, ""Golden Age"""');
  });

  test('model_json.ndjson: one line per work folder in the organizer schema; only trustworthy values', async () => {
    const r = await request(app).get('/api/organizer/export/model_json.ndjson');
    expect(r.headers['content-type']).toMatch(/application\/x-ndjson/);
    const rows = r.text.trim().split('\n').map(l => JSON.parse(l));
    const hb = rows.find(x => x.model.character === 'Hellboy');
    expect(hb).toEqual({ library: 'lib', rel: 'B3DSERK/DC/Hellboy', model: expect.objectContaining({
      studio: 'Wicked', creator: 'B3DSERK', genre: 'Other Comics (Image:Top Cow: Dark horse, etc)', character: 'Hellboy', type: 'Sculpture',
      files: ['B3DSERK - Hellboy Sculpture (One Piece).zip'], source: expect.any(String), claim_url: expect.any(String), release_term: expect.any(String),
    }) });
    expect(rows.some(x => x.model.character === 'Geral')).toBe(false); // folded
    expect(rows.some(x => /Nashgur/.test(x.model.character))).toBe(false); // not a studio work
  });

  test('moves.csv: gold layout proposals for off-layout studio works', async () => {
    const r = await request(app).get('/api/organizer/export/moves.csv');
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe('library,from_rel,to_rel,reason,confidence');
    // ':' is not allowed in SMB names: stripped like the organizer does
    expect(lines).toContain('lib,B3DSERK/DC/Hellboy,"B3DSERK/Other Comics (Image Top Cow Dark horse, etc)/Hellboy/Sculpture",not under its genre folder; no type folder,1');
  });
});

// ── generate-tags alias, the AI lock, disconnects ───────────────────────────

describe('jobs', () => {
  test('/api/ai/generate-tags runs Enrich with tags only (old clients)', async () => {
    const thing = byName('Mystery Thing');
    const before = db.prepare('SELECT character, franchise, tags FROM models WHERE id = ?').get(thing.id);
    const r = await request(app).get('/api/ai/generate-tags?key=t');
    const done = sseEvents(r.text).pop();
    expect(done).toMatchObject({ type: 'done', success: true, tagged: expect.any(Number), total: expect.any(Number), runId: expect.any(Number) });
    const after = db.prepare('SELECT character, franchise FROM models WHERE id = ?').get(thing.id);
    expect(after).toEqual({ character: before.character, franchise: before.franchise });
    const run = (await request(app).get('/api/ai/enrich/runs')).body.runs.find(x => x.id === done.runId);
    expect(run.scope).toBe('tags');
    expect(db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE run_id = ?`).get(done.runId).n).toBe(0);
  });

  test('409 while another AI job runs', async () => {
    const release = acquireAiJob('vision-tags');
    try {
      const r = await request(app).get('/api/ai/enrich?key=t&scope=all&force=1');
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: expect.stringMatching(/Another AI job/), running: { name: 'vision-tags' } });
      expect((await request(app).get('/api/ai/generate-tags?key=t')).status).toBe(409);
    } finally { release(); }
  });

  test('a client that disconnects stops the run and frees the lock', async () => {
    process.env.ENRICH_FAKE_DELAY_MS = '3000';
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise(r => server.once('listening', r));
      const { port } = server.address();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no data')), 5000);
        const done = () => { clearTimeout(timer); resolve(); };
        const req = http.get({ host: '127.0.0.1', port, path: '/api/ai/enrich?key=t&scope=all&force=1' }, (res) => {
          res.once('data', () => { req.destroy(); done(); });
        });
        req.on('error', done);
      });
      const t0 = Date.now();
      let runs;
      for (;;) {
        runs = (await request(app).get('/api/ai/enrich/runs')).body.runs;
        if (runs[0].status !== 'running' || Date.now() - t0 > 5000) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(runs[0].status).toBe('cancelled');
      expect(runs[0].applied).toBe(0);
      expect(Date.now() - t0).toBeLessThan(2500); // the pending call was aborted, not waited out
      const ok = await request(app).get('/api/ai/enrich/estimate?scope=all');
      expect(ok.status).toBe(200);
      const release = acquireAiJob('probe');
      expect(release).toBeTruthy();
      release();
    } finally {
      process.env.ENRICH_FAKE_DELAY_MS = '0';
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });
});

test('fake model: realistic answers for real card shapes', () => {
  const a = fake.answer({ id: 1, kind: 'work', creator: 'B3DSERK', cur: { name: 'Ra S Al Ghul', character: ['Ra S Al Ghul', 'parse'], franchise: ['DC', 'path'] } });
  expect(a.character).toBeUndefined(); // same character, only spelled badly: a rename, not a new character
  expect(a.name.v).toBe("Ra's al Ghul");
  expect(a.group_name.v).toBe('League of Assassins');
  const d = fake.answer({ id: 2, kind: 'work', creator: 'SW3D', cur: { name: 'Darth Bane', franchise: ['Star Wars', 'path'] } });
  expect(d.franchise).toBeUndefined(); // not Bane (DC)
});
