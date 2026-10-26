/**
 * Folder roles through the app (docs/folder-roles.md): /api/folder-roles, a scan with marks from
 * _Meta/folder_roles.csv and the app (file wins), category tags and the user's removed tags,
 * provenance protection from AI, suspect folders, role suggestions (fake model, accept / reject),
 * the organizer export, model detail breadcrumbs, fs-tree and the legacy override route.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-roles-api-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
const ARCH = path.join(LIB, 'STL Archive');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
process.env.LIBRARY_LABELS = 'STL Archive=Dagobah';
process.env.ENRICH_FAKE = '1';
process.env.ENRICH_FAKE_DELAY_MS = '0';
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;
delete process.env.CLAUDE_API_KEY;
delete process.env.ENRICH_AUTO_MIN;
delete process.env.ENRICH_SUGGEST_MIN;

let seq = 7000;
function mk(rel) {
  const full = path.join(ARCH, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(seq += 31));
  return full;
}
mk('Misc/Terrain/Rocks/rock.stl');
mk('Misc/Terrain/Trees/tree.stl');
mk('Misc/Unicorn/Horn/horn.stl');
mk('Misc/Unicorn/Body/body.stl');
mk('Misc/Lamp/lamp.stl');
mk('Minis/Heroes/heroes pack.stl');
mk('Minis/Heroes/heroes pack 2.stl');
mk('Minis/Heroes/heroes extra.stl');
mk('Minis/Heroes/heroes bonus.stl');
mk('Minis/Heroes/Knight/knight.stl');
fs.mkdirSync(path.join(ARCH, '_Meta'), { recursive: true });
const ROLES_CSV = path.join(ARCH, '_Meta', 'folder_roles.csv');
fs.writeFileSync(ROLES_CSV, 'path,role,genre,group,tags,note\nMisc/Terrain,category,,,terrain|scenery,\nMisc/Unicorn,model,,,,one unicorn\nMisc/Gone,ignore,,,,\n');

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const enrich = require('../lib/enrich');
const suspects = require('../lib/suspects');

const PJ = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const live = () => db.prepare('SELECT * FROM models WHERE folded_into IS NULL').all();
const holding = (frag) => db.prepare(`SELECT DISTINCT m.* FROM models m JOIN model_files f ON f.model_id = m.id WHERE f.filepath LIKE ? AND m.folded_into IS NULL`).all(`%${frag}%`);
let logLines = [];
const scan = async () => { logLines = []; return scanLibrary(LIB, null, (lvl, msg) => logLines.push(msg)); };

afterAll(() => { try { db.close(); } catch {} fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('API and scan', () => {
  beforeAll(async () => {
    // an app mark under a file mark: the file wins, the conflict is shown
    const r = await request(app).post('/api/folder-roles').send({ path: path.join(ARCH, 'Misc/Unicorn'), role: 'ignore' });
    expect(r.body).toEqual({ ok: true, rescan: true, fileOverrides: true });
    await scan();
  });

  test('GET /api/folder-roles: effective marks with source and conflict, and the _Meta files', async () => {
    const r = await request(app).get('/api/folder-roles');
    expect(r.status).toBe(200);
    const by = new Map(r.body.roles.map(e => [e.rel, e]));
    expect(by.get('Misc/Terrain')).toEqual({ path: path.join(ARCH, 'Misc/Terrain'), library: 'Dagobah', rel: 'Misc/Terrain', role: 'category',
      genre: null, group: null, tags: ['terrain', 'scenery'], note: '', source: 'file', conflict: null });
    expect(by.get('Misc/Unicorn')).toMatchObject({ role: 'model', source: 'file', conflict: { role: 'ignore' }, note: 'one unicorn' });
    expect(r.body.files).toEqual([{ library: 'Dagobah', path: ROLES_CSV, rows: 3, errors: ['row 4: path not found: Misc/Gone'] }]);
  });

  test('the scan applies the marks and logs them', () => {
    expect(logLines).toContain('Folder roles: 1 category, 1 model (file 2, app 0)');
    const uni = holding('/Misc/Unicorn/');
    expect(uni).toHaveLength(1);
    expect(uni[0].file_count).toBe(2);
    expect(live().some(m => m.name === 'Terrain' || m.name === 'Misc')).toBe(false);
    const rocks = holding('/Terrain/Rocks/')[0];
    expect(PJ(rocks.tags, [])).toEqual(['terrain', 'scenery']);
    expect(rocks.group_name).toBe('Terrain');
    expect(PJ(rocks.attribution, {}).fields.group_name).toBe('role');
  });

  test('category tags come back on rescans, except the ones the user removed', async () => {
    const rocks = holding('/Terrain/Rocks/')[0];
    const r = await request(app).patch(`/api/models/${rocks.id}`).send({ tags: ['terrain'] });
    expect(r.status).toBe(200);
    expect(PJ(db.prepare('SELECT attribution FROM models WHERE id = ?').get(rocks.id).attribution, {}).removedTags).toEqual(['scenery']);
    fs.writeFileSync(ROLES_CSV, 'path,role,genre,group,tags,note\nMisc/Terrain,category,,,terrain|scenery|outdoor,\nMisc/Unicorn,model,,,,one unicorn\n');
    await scan();
    expect(PJ(db.prepare('SELECT tags FROM models WHERE id = ?').get(rocks.id).tags, [])).toEqual(['terrain', 'outdoor']);
  });

  test('POST /api/folder-roles: set a category with values, clear it; invalid input', async () => {
    const lamp = path.join(ARCH, 'Misc/Lamp');
    let r = await request(app).post('/api/folder-roles').send({ path: lamp, role: 'category', genre: 'Movies', group: '', tags: 'light, =cmd|deco', note: 'n' });
    expect(r.body).toEqual({ ok: true, rescan: true, fileOverrides: false });
    const row = db.prepare('SELECT * FROM folder_overrides WHERE path = ?').get(lamp);
    expect(row).toMatchObject({ role: 'category', genre: 'Movies', grp: null, note: 'n' });
    expect(PJ(row.tags)).toEqual(['light', 'deco']);
    expect((await request(app).post('/api/folder-roles').send({ path: lamp, role: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/folder-roles').send({ path: '/etc', role: 'model' })).status).toBe(403);
    expect((await request(app).post('/api/folder-roles').send({ role: 'model' })).status).toBe(400);
    r = await request(app).post('/api/folder-roles').send({ path: lamp, role: null });
    expect(r.body).toEqual({ ok: true, rescan: true, fileOverrides: false });
    expect(db.prepare('SELECT * FROM folder_overrides WHERE path = ?').get(lamp)).toBeUndefined();
    // container is the UI word for passthrough
    await request(app).post('/api/folder-roles').send({ path: lamp, role: 'container' });
    expect(db.prepare('SELECT role FROM folder_overrides WHERE path = ?').get(lamp).role).toBe('passthrough');
    await request(app).post('/api/folder-roles').send({ path: lamp, role: null });
  });

  test('the old /api/organize/folder-overrides routes read and write the same rows', async () => {
    const p = path.join(ARCH, 'Minis');
    let r = await request(app).post('/api/organize/folder-overrides').send({ path: p, role: 'category', group: 'Minis', tags: ['mini'] });
    expect(r.body.ok).toBe(true);
    r = await request(app).get('/api/organize/folder-overrides');
    expect(r.body.find(x => x.path === p)).toMatchObject({ role: 'category', group: 'Minis', tags: ['mini'] });
    r = await request(app).post('/api/organize/folder-overrides').send({ path: p, role: 'nope' });
    expect(r.status).toBe(400);
    await request(app).post('/api/organize/folder-overrides').send({ path: p, role: null });
  });

  test('fs-tree nodes carry role, source, conflict and category values', async () => {
    const r = await request(app).get('/api/organize/fs-tree').query({ path: path.join(ARCH, 'Misc'), depth: 1 });
    const t = r.body.children.find(c => c.name === 'Terrain');
    expect(t).toMatchObject({ role: 'category', source: 'file', conflict: null, genre: null, group: null, tags: ['terrain', 'scenery', 'outdoor'] });
    expect(r.body.children.find(c => c.name === 'Unicorn')).toMatchObject({ role: 'model', source: 'file', conflict: { role: 'ignore' } });
    expect(r.body.children.find(c => c.name === 'Lamp')).toMatchObject({ role: null, source: null });
  });

  test('model detail: folders from the library root to the card folder, with roles', async () => {
    const rocks = holding('/Terrain/Rocks/')[0];
    const r = await request(app).get(`/api/models/${rocks.id}`);
    expect(r.body.folderRoles).toEqual([
      { path: ARCH, rel: '', name: 'STL Archive', role: null, source: null },
      { path: path.join(ARCH, 'Misc'), rel: 'Misc', name: 'Misc', role: null, source: null },
      { path: path.join(ARCH, 'Misc/Terrain'), rel: 'Misc/Terrain', name: 'Terrain', role: 'category', source: 'file' },
      { path: path.join(ARCH, 'Misc/Terrain/Rocks'), rel: 'Misc/Terrain/Rocks', name: 'Rocks', role: null, source: null },
    ]);
  });

  test('organizer export: app marks in the file format with a library column', async () => {
    const idx = await request(app).get('/api/organizer/export');
    expect(idx.body.files.find(f => f.name === 'folder_roles.csv')).toEqual({ name: 'folder_roles.csv', url: '/api/organizer/export/folder_roles.csv', rows: 1 });
    const r = await request(app).get('/api/organizer/export/folder_roles.csv');
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toBe('library,path,role,genre,group,tags,note\r\nDagobah,Misc/Unicorn,ignore,,,,\r\n');
  });

  test('meta status counts folder roles', () => {
    const meta = require('../lib/meta').loadMeta({ dirs: [path.join(ARCH, '_Meta')], roots: [ARCH] });
    expect(require('../lib/meta').metaStatus(meta).counts.folderRoles).toBe(2);
  });
});

describe('AI: role provenance and role suggestions', () => {
  test('a field set by a role is protected from automatic AI writes', () => {
    expect(enrich.PROTECTED.has('role')).toBe(true);
    const card = { id: 1, name: 'Rocks', franchise: null, tags: '[]', editions: '[]', attribution: JSON.stringify({ fields: { franchise: 'role' } }) };
    const plan = enrich.planActions(card, { id: 1, franchise: { v: 'Movies', c: 0.99 } }, { ...enrich.thresholds(), isKnownGenre: () => true, rejected: () => false });
    expect(plan.apply).toEqual([]);
    expect(plan.suggest.map(s => s.field)).toEqual(['franchise']);
  });

  test('the fake model proposes a category for "Heroes"; accept writes the app mark', async () => {
    const r = await request(app).get('/api/ai/enrich?key=t&scope=all&force=1');
    expect(r.status).toBe(200);
    const list = await request(app).get('/api/suggestions?type=role');
    const heroes = path.join(ARCH, 'Minis/Heroes');
    const s = list.body.items.find(i => i.path === heroes);
    expect(s).toMatchObject({ type: 'role', field: 'folder_role', current: null, proposed: 'category', rel: 'Minis/Heroes', library: 'Dagobah' });
    expect(s.model.name).toBe('Heroes');
    expect((await request(app).get('/api/suggestions/summary')).body.byType.role).toBeGreaterThanOrEqual(1);
    const d = await request(app).post('/api/suggestions/decide').send({ ids: [s.id], decision: 'accept' });
    expect(d.body.accepted).toBe(1);
    expect(db.prepare('SELECT role FROM folder_overrides WHERE path = ?').get(heroes).role).toBe('category');
    // the next scan applies it: Heroes is no longer a card, its loose file is
    await scan();
    expect(live().some(m => m.name === 'Heroes')).toBe(false);
    expect(holding('/Heroes/heroes pack.stl')[0].name).toBe('heroes pack');
    await request(app).post('/api/folder-roles').send({ path: heroes, role: null });
  });

  test('a rejected role proposal for a folder is not proposed again', () => {
    const card = live()[0];
    const dir = path.join(ARCH, 'Misc/Lamp');
    const id = db.prepare(`INSERT INTO suggestions (model_id, type, field, proposed, path, confidence, status) VALUES (?, 'role', 'folder_role', '"model"', ?, 0.8, 'pending')`).run(card.id, dir).lastInsertRowid;
    const res = enrich.decide(db, [id], 'reject');
    expect(res.rejected).toBe(1);
    const rejected = enrich.rejectedLookup(db, card.id);
    expect(rejected('role', 'folder_role', 'model', null, dir)).toBe(true);
    expect(rejected('role', 'folder_role', 'category', null, dir)).toBe(false);
    const fresh = { ...card, folder_path: dir };
    const plan = enrich.planActions(fresh, { id: card.id, folderRole: { role: 'model', c: 0.9, up: 0 } }, { ...enrich.thresholds(), isKnownGenre: () => true, rejected, roleOf: () => null });
    expect(plan.suggest).toEqual([]);
  });

  test('validation: folderRole needs folder evidence and a folder at or above the card\'s', () => {
    const ev = { id: 5, kind: 'model', cur: { name: 'X' }, folder: { path: 'Misc/Terrain', subs: [], files: 2 } };
    const ok = enrich.validateResponse(JSON.stringify([{ id: 5, folderRole: { path: 'Misc', role: 'Container', c: 0.8 } }]), new Map([[5, ev]]));
    expect(ok.items.get(5).folderRole).toEqual({ role: 'passthrough', c: 0.8, up: 1 });
    const bad = enrich.validateResponse(JSON.stringify([{ id: 5, folderRole: { path: 'Other', role: 'category', c: 0.8 } }]), new Map([[5, ev]]));
    expect(bad.items.get(5).folderRole).toBeUndefined();
    expect(bad.errors[0]).toMatch(/not the card's folder/);
  });
});

describe('suspect folders', () => {
  const sus = path.join(ROOT, 'sus');
  const SLIB = path.join(sus, 'STL Archive');
  let cid;
  const card = (name, folder, files, kind = 'model') => {
    const id = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path, kind, file_count) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`sus-${seq++}`, name, cid, folder, kind, files.length).lastInsertRowid;
    for (const f of files) db.prepare('INSERT INTO model_files (model_id, filename, filepath) VALUES (?, ?, ?)').run(id, path.basename(f), f);
    return id;
  };
  let items;
  beforeAll(() => {
    db.prepare(`DELETE FROM settings WHERE key = 'suspects_dismissed'`).run();
    cid = db.prepare(`INSERT INTO creators (name, folder_path) VALUES ('Some Creator', ?)`).run(path.join(SLIB, 'Some Creator')).lastInsertRowid;
    for (const d of ['Mix', 'Heroes', 'Dragon Bases', 'Dragon', 'Gumroad Downloads/Some Creator', 'Marked']) fs.mkdirSync(path.join(SLIB, d), { recursive: true });
    card('Mix', path.join(SLIB, 'Mix'), Array.from({ length: 9 }, (_, i) => path.join(SLIB, 'Mix', `Sub ${i}`, `f${i}.stl`)));
    card('Heroes Card', path.join(SLIB, 'Heroes'), [path.join(SLIB, 'Heroes', 'Knight', 'a.stl'), path.join(SLIB, 'Heroes', 'Wizard', 'b.stl')]);
    card('Bases', path.join(SLIB, 'Dragon Bases'), [path.join(SLIB, 'Dragon Bases', 'base.stl')]); // one base: part of its model, no suspect
    for (const part of ['Arm L', 'Arm R', 'Head', 'Torso', 'Leg L', 'Leg R', 'Base']) card(part, path.join(SLIB, 'Dragon', part), [path.join(SLIB, 'Dragon', part, `${part}.stl`)]);
    const other = db.prepare(`INSERT INTO creators (name) VALUES ('Other Owner')`).run().lastInsertRowid;
    const id = card('Thing', path.join(SLIB, 'Gumroad Downloads/Some Creator/Thing'), [path.join(SLIB, 'Gumroad Downloads/Some Creator/Thing/t.stl')]);
    db.prepare('UPDATE models SET creator_id = ? WHERE id = ?').run(other, id);
    card('Mix 2', path.join(SLIB, 'Marked'), Array.from({ length: 9 }, (_, i) => path.join(SLIB, 'Marked', `Sub ${i}`, `f${i}.stl`)));
    card('Ghost', path.join(SLIB, 'Ghost'), Array.from({ length: 9 }, (_, i) => path.join(SLIB, 'Ghost', `Sub ${i}`, `f${i}.stl`))); // not on disk
    const roles = new Map([[path.join(SLIB, 'Marked'), { role: 'category' }]]);
    items = suspects.computeSuspects(db, { libs: [{ name: 'Sus', path: SLIB }], roles });
  });
  const at = (rel) => items.find(i => i.path === path.join(SLIB, rel));

  test('mixed card → category', () => {
    expect(at('Mix')).toMatchObject({ rule: 'mixed', suggestedRole: 'category', library: 'Sus', rel: 'Mix', name: 'Mix', files: 9, folders: 9, cardName: 'Mix', dismissed: false });
    expect(at('Mix').reason).toBe('Card "Mix" holds 9 files from 9 sub-folders');
    expect(at('Mix').sample).toHaveLength(5);
  });
  test('category-looking name → category', () => {
    expect(at('Heroes')).toMatchObject({ rule: 'category-name', suggestedRole: 'category', folders: 2, sample: ['Knight', 'Wizard'] });
    expect(at('Dragon Bases')).toBeUndefined();
  });
  test('many tiny part cards → model of their parent', () => {
    expect(at('Dragon')).toMatchObject({ rule: 'tiny-siblings', suggestedRole: 'model', folders: 7 });
  });
  test('creator name inside a container → creator', () => {
    expect(at('Gumroad Downloads/Some Creator')).toMatchObject({ rule: 'creator-name', suggestedRole: 'creator' });
  });
  test('marked and missing folders are left out', () => {
    expect(at('Marked')).toBeUndefined();
    expect(at('Ghost')).toBeUndefined();
  });
  test('dismiss hides one; dismissed=1 shows it again; undo', () => {
    suspects.dismiss(db, path.join(SLIB, 'Mix'));
    const again = suspects.computeSuspects(db, { libs: [{ name: 'Sus', path: SLIB }] });
    expect(again.find(i => i.path === path.join(SLIB, 'Mix'))).toBeUndefined();
    const all = suspects.computeSuspects(db, { libs: [{ name: 'Sus', path: SLIB }], dismissed: true });
    expect(all.find(i => i.path === path.join(SLIB, 'Mix')).dismissed).toBe(true);
    suspects.dismiss(db, path.join(SLIB, 'Mix'), true);
    expect(suspects.computeSuspects(db, { libs: [{ name: 'Sus', path: SLIB }] }).find(i => i.path === path.join(SLIB, 'Mix'))).toBeDefined();
  });
  test('the endpoints', async () => {
    const r = await request(app).get('/api/folder-roles/suspects');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    const d = await request(app).post('/api/folder-roles/suspects/dismiss').send({ path: path.join(SLIB, 'Mix') });
    expect(d.body).toEqual({ ok: true });
    expect(suspects.dismissedSet(db).has(path.join(SLIB, 'Mix'))).toBe(true);
    await request(app).post('/api/folder-roles/suspects/dismiss').send({ path: path.join(SLIB, 'Mix'), undo: true });
    expect(suspects.dismissedSet(db).has(path.join(SLIB, 'Mix'))).toBe(false);
    expect((await request(app).post('/api/folder-roles/suspects/dismiss').send({})).status).toBe(400);
  });
});
