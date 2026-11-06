/**
 * Organize trim (Casey, Nov 2026): X-Creator Dupes fold like an accepted merge (alias, kept
 * together on rescan, Unmerge), Similar Names and the superseded Annotate / Franchise / bulk /
 * thumbnail / AI-role / vision-tags / generate-tags routes are gone, and the web Image Finder only
 * takes cards the free picture search already tried.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-org-trim-')));
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

let seq = 9100;
function mk(rel) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(seq += 37));
}
mk('Alpha Sculpts/Medusa/medusa.stl');
mk('Alpha Sculpts/Kraken/kraken.stl');
mk('Beta Minis/Medusa/medusa_body.stl');
mk('Beta Minis/Medusa/medusa_base.stl');
mk('Beta Minis/Goblin/goblin.stl');

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');

const visible = (name) => db.prepare(`SELECT m.*, c.name creator FROM models m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.name = ? AND m.folded_into IS NULL AND COALESCE(m.hidden, 0) = 0`).all(name);
const sseEvents = (text) => String(text).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));

beforeAll(async () => { await scanLibrary(LIB); });
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('X-Creator Dupes fold like an accepted merge', () => {
  let keep, drop, suggestionId;

  test('health lists the same model under two creators, and no longer computes Similar Names', async () => {
    const h = (await request(app).get('/api/organize/health')).body;
    expect(h.summary.duplicatePairs).toBeUndefined();
    expect(h.duplicates).toBeUndefined();
    const g = h.crossCreatorDupes.find(x => x.models.some(m => m.name === 'Medusa'));
    expect(g).toBeDefined();
    expect(new Set(g.models.map(m => m.creator_name))).toEqual(new Set(['Alpha Sculpts', 'Beta Minis']));
  });

  test('resolve folds the copy into the kept card: files move, alias stored, recorded as an accepted merge', async () => {
    const both = visible('Medusa');
    keep = both.find(m => m.creator === 'Beta Minis');
    drop = both.find(m => m.creator === 'Alpha Sculpts');
    const r = await request(app).post('/api/organize/dedupe/resolve').send({ keepId: keep.id, dropIds: [drop.id] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, merged: 1, errors: [] });
    suggestionId = r.body.suggestionIds[0];
    const src = db.prepare('SELECT * FROM models WHERE id = ?').get(drop.id);
    expect(src.folded_into).toBe(keep.id);
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(keep.id).n).toBe(3);
    expect(db.prepare('SELECT COUNT(*) n FROM aliases').get().n).toBe(1);
    expect(db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId)).toMatchObject({ type: 'merge', status: 'accepted', source: 'user', model_id: drop.id, target_id: keep.id });
    // a snapshot was taken first
    expect(fs.readdirSync(process.env.BACKUP_DIR).some(f => /pre-merge/.test(f))).toBe(true);
    // listed with Unmerge in Review → History
    const acc = (await request(app).get('/api/suggestions?status=accepted&type=merge')).body.items;
    expect(acc.map(x => x.id)).toContain(suggestionId);
    // and gone from Health
    const h = (await request(app).get('/api/organize/health')).body;
    expect(h.crossCreatorDupes.some(x => x.models.some(m => m.name === 'Medusa'))).toBe(false);
  });

  test('a rescan keeps them together', async () => {
    await scanLibrary(LIB);
    const now = visible('Medusa');
    expect(now).toHaveLength(1);
    expect(now[0].id).toBe(keep.id);
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(keep.id).n).toBe(3);
  });

  test('Unmerge puts the copy back', async () => {
    const r = await request(app).post(`/api/suggestions/${suggestionId}/unmerge`);
    expect(r.status).toBe(200);
    expect(r.body.restored).toMatchObject({ alias: true });
    expect(db.prepare('SELECT folded_into FROM models WHERE id = ?').get(drop.id).folded_into).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(drop.id).n).toBe(1);
  });

  test('bad input and impossible folds are refused', async () => {
    expect((await request(app).post('/api/organize/dedupe/resolve').send({ keepId: keep.id, dropIds: [] })).status).toBe(400);
    expect((await request(app).post('/api/organize/dedupe/resolve').send({ keepId: 999999, dropIds: [drop.id] })).status).toBe(404);
    const r = await request(app).post('/api/organize/dedupe/resolve').send({ keepId: keep.id, dropIds: [keep.id] });
    expect(r.body.merged).toBe(0);
    expect(r.body.errors[0].error).toMatch(/itself/);
  });
});

describe('superseded routes are gone', () => {
  test.each([
    ['post', '/api/organize/auto-annotate'], ['post', '/api/organize/annotate/preview'], ['post', '/api/organize/annotate/apply'],
    ['get', '/api/organize/snapshot'], ['post', '/api/organize/apply-franchise'], ['get', '/api/organize/franchise-browser'],
    ['post', '/api/organize/bulk-update'], ['get', '/api/organize/thumbnail-stats'], ['post', '/api/organize/fix-thumbnails'],
    ['get', '/api/organize/folder-overrides'], ['post', '/api/organize/classify-folders'],
    ['get', '/api/ai/vision-tags'], ['get', '/api/ai/generate-tags'], ['get', '/api/ai/tag-estimate'],
  ])('%s %s → 404', async (method, url) => {
    const r = await request(app)[method](url).set('x-claude-key', 'sk-ant-test').send({});
    expect(r.status).toBe(404);
  });

  test('what stays still answers', async () => {
    expect((await request(app).get('/api/organize/health')).status).toBe(200);
    expect((await request(app).get('/api/organize/franchises')).status).toBe(200);
    expect((await request(app).get('/api/folder-roles')).status).toBe(200);
  });
});

describe('Image Finder is a fallback', () => {
  test('cards the free picture search has not tried are skipped and counted', async () => {
    db.prepare(`UPDATE models SET thumbnail_path = NULL, thumb_attempt = NULL`).run();
    const r = await request(app).get('/api/ai/find-images?key=sk-ant-test');
    const done = sseEvents(r.text).find(e => e.type === 'done');
    expect(done).toMatchObject({ success: true, total: 0 });
    expect(done.untried).toBeGreaterThan(0);
    expect(sseEvents(r.text).some(e => /Find missing pictures/.test(e.msg || ''))).toBe(true);
  });
});
