/**
 * Migration (docs/library-metadata.md §8): a DB built by the folder scanner
 * (LAYOUT_MODE=legacy) is rescanned layout-aware. User data on the old models is
 * folded into the works, nothing is deleted, a pre-regroup snapshot is taken.
 * Also covers the new API routes (models filters, detail, facets, _Meta, attribution,
 * health libraries, yauzl zip routes).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mig-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
process.env.LIBRARY_LABELS = 'STL Archive=Dagobah,3dPrint=Endor';
delete process.env.ALLOWED_ORIGINS;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let seq = 2000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 13)));
  return full;
}
const A = 'STL Archive';
const LOTR = `${A}/Wicked Archive/Movies/Lord of the Rings`;
mk(`${LOTR}/WICKED - Gandalf Statue 459.31 mm/WICKED - Gandalf Statue 459.31 mm (One Piece).zip`, 5100001);
mk(`${LOTR}/WICKED - Gandalf Bust 270mm/WICKED - Gandalf Bust 270mm (Non Supported).zip`);
{
  const z = new AdmZip();
  z.addFile('Gandalf/render_main.png', PNG);
  z.addFile('Gandalf/side.png', PNG);
  fs.mkdirSync(path.join(LIB, `${LOTR}/WICKED - Gandalf Sculpture Images`), { recursive: true });
  z.writeZip(path.join(LIB, `${LOTR}/WICKED - Gandalf Sculpture Images/WICKED - Gandalf Sculpture Images.zip`));
}
// the folder scanner turns these into models called "Full Pieces" and "Base"
mk(`${LOTR}/WICKED - Balrog Statue 863.63mm (Non Supported)/100/Full Pieces/Wing_L.stl`);
mk(`${LOTR}/WICKED - Balrog Statue 863.63mm (Non Supported)/50/Base/Base_1.stl`);
// … and these into models called "32mm" and "75mm"
const REL = `${A}/Loot Studios/2022-04 - Crimson Sand Arena/All_Enemies_Part1/BugbearGladiator`;
mk(`${REL}/32mm/No Supports/BugbearGladiator.stl`);
mk(`${REL}/75mm/No Supports/BugbearGladiator.stl`);
mk(`${A}/StudioX/Dragon/dragon.stl`);
mk(`${A}/StudioX/Knight/knight.stl`);
mk(`${A}/_Tools/Printer files/spacer.zip`);
// legacy path parsing gave these franchise "Humblewood STLs" (noise) — one gets a user value
mk(`${A}/Humblewood/Humblewood STLs/Vulpin Captain/vulpin.stl`);
mk(`${A}/Humblewood/Humblewood STLs/Bandit Rider/rider.stl`);
mk(`${A}/Humblewood/Maps/map.stl`);
mk('3dPrint/Wicked/Movies/Gandalf/WICKED - Gandalf Statue 459.31 mm (One Piece).zip', 5100001); // Endor backup copy
fs.mkdirSync(path.join(LIB, A, '_Meta'), { recursive: true });
fs.writeFileSync(path.join(LIB, A, '_Meta', 'gumroad_manifest.json'), JSON.stringify([
  { creator: 'Wicked', product_name: 'Wicked Movies Gandalf Sculpture: Tested and ready for 3D printing', download_url: 'https://gumroad.com/d/gandalf',
    files: [{ file_name: 'WICKED - Gandalf Statue 459.31 mm (One Piece)', extension: 'zip', file_size: 5100001 }] },
  { creator: 'Wicked', product_name: 'Wicked Movies Frodo Sculpture: Tested and ready for 3D printing', download_url: 'https://gumroad.com/d/frodo',
    files: [{ file_name: 'Wicked - Frodo Sculpture (One Piece)', extension: 'zip', file_size: 77777777 }] },
]));
fs.writeFileSync(path.join(LIB, A, '_Meta', 'gumroad_unclaimed_tracker.csv'),
  'Creator,Product,Status,First Seen,Last Seen,Code,URL\nWicked,Gandalf Sculpture,Claimed (Sep 10 2026),2026-03-01,2026-03-01,g1,https://wickedart.gumroad.com/l/gandalf\n');

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');

const legacyByName = (name) => db.prepare('SELECT * FROM models WHERE name = ? AND work_key IS NULL').get(name);
let before;

beforeAll(async () => {
  process.env.LAYOUT_MODE = 'legacy';
  await scanLibrary(LIB);
  before = db.prepare('SELECT id, name FROM models').all();
  // user data on the old folder-based models
  const fullPieces = legacyByName('Full Pieces');
  db.prepare(`UPDATE models SET tags = '["wip"]', is_favorite = 1, print_status = 'printed', notes = 'printed the wings' WHERE id = ?`).run(fullPieces.id);
  const col = db.prepare(`INSERT INTO collections (name) VALUES ('Balrogs')`).run().lastInsertRowid;
  db.prepare('INSERT INTO collection_models (collection_id, model_id) VALUES (?, ?)').run(col, fullPieces.id);
  db.prepare('INSERT INTO print_queue (model_id, position) VALUES (?, 1)').run(fullPieces.id);
  db.prepare(`UPDATE models SET name = 'My Bugbear', name_locked = 1 WHERE id = ?`).run(legacyByName('32mm').id);
  db.prepare(`UPDATE model_files SET printed_at = '2026-01-02T00:00:00Z' WHERE filename = 'BugbearGladiator.stl' AND filepath LIKE '%/32mm/%'`).run();
  db.prepare(`UPDATE models SET tags = '["dragon"]' WHERE name = 'Dragon'`).run();
  db.prepare(`UPDATE models SET franchise = 'Fantasy', team = 'Bandits' WHERE name = 'Bandit Rider'`).run();
  delete process.env.LAYOUT_MODE;
  await scanLibrary(LIB);
});
afterAll(() => {
  delete process.env.LIBRARY_LABELS;
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const work = (key) => db.prepare('SELECT * FROM models WHERE work_key = ?').get(key);

describe('legacy → layout', () => {
  test('the folder scanner produced generic cards (the problem being fixed)', () => {
    expect(before.map(m => m.name)).toEqual(expect.arrayContaining(['Full Pieces', 'Base', '32mm', '75mm']));
  });
  test('nothing is deleted; a pre-regroup snapshot exists; the regroup is recorded', () => {
    const ids = new Set(db.prepare('SELECT id FROM models').all().map(r => r.id));
    for (const m of before) expect(ids.has(m.id)).toBe(true);
    expect(fs.readdirSync(process.env.BACKUP_DIR).some(f => /^vault-pre-regroup-.*\.db$/.test(f))).toBe(true);
    expect(db.getSetting('layout_regroup_done')).toBeTruthy();
  });
  test('old models are folded into the work: tags, favorite, status, notes, collections, queue', () => {
    const balrog = work('Wicked|work|balrog');
    expect(balrog).toBeTruthy();
    expect(balrog.kind).toBe('work');
    expect(JSON.parse(balrog.tags)).toContain('wip');
    expect(balrog.is_favorite).toBe(1);
    expect(balrog.print_status).toBe('printed');
    expect(balrog.notes).toMatch(/printed the wings/);
    expect(db.prepare('SELECT COUNT(*) n FROM collection_models WHERE model_id = ?').get(balrog.id).n).toBe(1);
    expect(db.prepare('SELECT model_id FROM print_queue').get().model_id).toBe(balrog.id);
    for (const n of ['Full Pieces', 'Base']) {
      const old = before.find(m => m.name === n);
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(old.id);
      expect(row.hidden).toBe(1);
      expect(JSON.parse(row.attribution).foldedInto).toBe(balrog.id);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(balrog.id).n).toBe(2);
  });
  test('one locked custom name carries over; per-file printed_at survives', () => {
    const bug = db.prepare(`SELECT * FROM models WHERE kind = 'release-item'`).get();
    expect(bug.name).toBe('My Bugbear');
    expect(bug.name_locked).toBe(1);
    expect(bug.release_term).toBe('2022-04');
    const f = db.prepare(`SELECT printed_at, variant FROM model_files WHERE model_id = ? AND filepath LIKE '%/32mm/%'`).get(bug.id);
    expect(f).toEqual({ printed_at: '2026-01-02T00:00:00Z', variant: '32mm-unsupported' });
  });
  test('a folder model keeps its row (same id) and user data', () => {
    const dragon = db.prepare(`SELECT * FROM models WHERE name = 'Dragon'`).get();
    expect(dragon.id).toBe(before.find(m => m.name === 'Dragon').id);
    expect(dragon.work_key).toBe('StudioX|model|dragon');
    expect(JSON.parse(dragon.tags)).toEqual(['dragon']);
  });
  test('attribution: manifest, tracker URL, both libraries', () => {
    const g = work('Wicked|work|gandalf');
    expect(JSON.parse(g.editions)).toEqual(['Sculpture', 'Bust']);
    expect(JSON.parse(g.libraries)).toEqual(['Dagobah', 'Endor']);
    expect(g.confidence).toBe('exact');
    expect(g.source).toBe('gumroad');
    expect(g.source_url).toBe('https://wickedart.gumroad.com/l/gandalf');
    expect(g.franchise).toBe('Movies');
    expect(JSON.parse(g.images).some(i => /render_main\.png$/.test(i))).toBe(true);
  });
  test('a second layout scan changes nothing', async () => {
    const r = await scanLibrary(LIB);
    expect(r.modelsAdded).toBe(0);
    expect(r.modelsUpdated).toBe(0);
    expect(r.folded).toBe(0);
    expect(r.modelsSkipped).toBe(r.modelsFound);
  });
  test('a user-set source_url is never overwritten', async () => {
    const g = work('Wicked|work|gandalf');
    await request(app).patch(`/api/models/${g.id}`).send({ source_url: 'https://example.com/mine' });
    db.prepare('UPDATE models SET folder_hash = NULL WHERE id = ?').run(g.id);
    await scanLibrary(LIB);
    expect(work('Wicked|work|gandalf').source_url).toBe('https://example.com/mine');
  });
});

describe('franchise / team cleanup (B, C)', () => {
  test('legacy path noise is cleared on release/folder cards; user values survive', () => {
    expect(before.length).toBeGreaterThan(0);
    const vulpin = db.prepare(`SELECT * FROM models WHERE name = 'Vulpin Captain'`).get();
    expect(vulpin.kind).toBe('model');
    expect(vulpin.franchise).toBeNull(); // was "Humblewood STLs"
    const rider = db.prepare(`SELECT * FROM models WHERE name = 'Bandit Rider'`).get();
    expect(rider.franchise).toBe('Fantasy');
    expect(rider.team).toBe('Bandits');
    const bug = db.prepare(`SELECT * FROM models WHERE kind = 'release-item'`).get();
    expect(bug.franchise).toBeNull();
    expect(bug.team).toBeNull();
  });
  test('franchiseAndTeam rules', () => {
    const { franchiseAndTeam } = require('../scanner');
    const meta = require('../lib/meta').emptyMeta();
    const w = (o) => ({ kind: 'work', folderPath: '/l/STL Archive/Wicked Archive/Movies/Lord of the Rings#balrog', group: 'Lord of the Rings', attr: { genre: 'Movies' }, ...o });
    // work: team mirroring the group / a folder is cleared; a user team stays
    expect(franchiseAndTeam(w(), { folder_path: '/l/x', franchise: 'Movies', team: 'Lord of the Rings', group_name: null }, {}, meta)).toEqual({ franchise: 'Movies', team: null });
    expect(franchiseAndTeam(w(), { folder_path: '/l/x', franchise: 'Movies', team: 'Fellowship', group_name: null }, {}, meta)).toEqual({ franchise: 'Movies', team: 'Fellowship' });
    // our previous automatic genre follows the new one (Alan Scott: Star Wars → DC)
    expect(franchiseAndTeam(w({ attr: { genre: 'DC' } }), { folder_path: '/l/x', franchise: 'Star Wars', team: null }, { autoFranchise: 'Star Wars' }, meta).franchise).toBe('DC');
    // a known genre that is also a folder name is not noise
    const rel = w({ kind: 'release-item', folderPath: '/l/STL Archive/Loot Studios/April/x', group: null, attr: { genre: null } });
    expect(franchiseAndTeam(rel, { folder_path: '/l/STL Archive/Loot Studios/April/x', franchise: 'April', team: 'x' }, {}, meta)).toEqual({ franchise: null, team: null });
    expect(franchiseAndTeam(rel, { folder_path: '/l/STL Archive/Marvel/x', franchise: 'Marvel', team: null }, {}, meta).franchise).toBe('Marvel');
  });
});

describe('API', () => {
  test('GET /api/models: layout fields, tools hidden by default, new filters', async () => {
    const all = (await request(app).get('/api/models').query({ limit: 100 })).body.models;
    expect(all.some(m => m.kind === 'tool')).toBe(false);
    const g = all.find(m => m.work_key === 'Wicked|work|gandalf');
    expect(g).toMatchObject({ name: 'Gandalf', character: 'Gandalf', kind: 'work', studio: 'Wicked', creator_name: 'Wicked', franchise: 'Movies', editions: ['Sculpture', 'Bust'], libraries: ['Dagobah', 'Endor'], source: 'gumroad', confidence: 'exact' });
    expect(g).not.toHaveProperty('products');
    const tools = (await request(app).get('/api/models').query({ kind: 'tool' })).body.models;
    expect(tools.map(m => m.name)).toEqual(['Printer files']);
    expect((await request(app).get('/api/models').query({ includeTools: '1', limit: 100 })).body.total).toBe(all.length + 1);
    const endor = (await request(app).get('/api/models').query({ library: 'Endor' })).body.models;
    expect(endor.map(m => m.name)).toEqual(['Gandalf']);
    expect((await request(app).get('/api/models').query({ studio: 'Wicked', genre: 'Movies' })).body.total).toBe(2);
    expect((await request(app).get('/api/models').query({ term: '2022' })).body.models.map(m => m.name)).toEqual(['My Bugbear']);
    expect((await request(app).get('/api/models').query({ attributed: 'yes' })).body.models.map(m => m.name)).toEqual(['Gandalf']);
    expect((await request(app).get('/api/models').query({ source: 'gumroad', kind: 'work,diorama' })).body.total).toBe(1);
  });
  test('GET /api/models/:id: products, attribution, files with library/variant/edition/product', async () => {
    const g = work('Wicked|work|gandalf');
    const res = await request(app).get(`/api/models/${g.id}`);
    expect(res.body.products[0]).toMatchObject({ name: 'Wicked Movies Gandalf Sculpture', edition: 'Sculpture', productUrl: 'https://wickedart.gumroad.com/l/gandalf', libraryUrl: 'https://gumroad.com/d/gandalf', claimed: '2026-03-01', status: 'Claimed (Sep 10 2026)', matchedFiles: 1, totalFiles: 1, missing: [] });
    expect(res.body.attribution).toMatchObject({ confidence: 'exact', fields: { franchise: 'path', character: 'parse' }, conflicts: [] });
    expect(res.body.attribution).not.toHaveProperty('sig');
    const f = res.body.files.find(x => x.library === 'Endor');
    expect(f).toMatchObject({ variant: 'one-piece', edition: 'Sculpture', product: 'Wicked Movies Gandalf Sculpture', matched_by: 'exact' });
  });
  test('facets, meta, attribution summary and gaps', async () => {
    const facets = (await request(app).get('/api/facets')).body;
    expect(facets.libraries).toEqual([{ name: 'Dagobah', count: 8 }, { name: 'Endor', count: 1 }]);
    expect(facets.kinds.find(k => k.name === 'tool').count).toBe(1);
    expect(facets.terms).toEqual([{ name: '2022-04', count: 1 }]);
    const st = (await request(app).get('/api/meta/status')).body;
    expect(st.counts.products).toBe(2);
    expect(st.dirs[0]).toMatch(/_Meta$/);
    expect((await request(app).post('/api/meta/reload')).body.loadedAt).toBeTruthy();
    const sum = (await request(app).get('/api/attribution/summary')).body;
    expect(sum).toMatchObject({ total: 8, gaps: 1 });
    expect(sum.byLibrary.find(l => l.name === 'Endor')).toEqual({ name: 'Endor', total: 1, attributed: 1 });
    const gaps = (await request(app).get('/api/attribution/gaps').query({ creator: 'Wicked' })).body.products;
    expect(gaps).toEqual([expect.objectContaining({ creator: 'Wicked', name: 'Wicked Movies Frodo Sculpture', files: 1, libraryUrl: 'https://gumroad.com/d/frodo' })]);
    expect((await request(app).get('/api/attribution/gaps').query({ creator: 'ZEZ' })).body.products).toEqual([]);
  });
  test('health lists the libraries; Health counts Endor/Dagobah copies as backups', async () => {
    const h = (await request(app).get('/api/health')).body;
    expect(h.libraries.map(l => l.name)).toEqual(['Endor', 'Dagobah']);
    const oh = (await request(app).get('/api/organize/health')).body;
    expect(oh.summary.backupCopies).toBe(1);
    expect(oh.fileDuplicates).toEqual([]);
  });
  test('zip routes stream with yauzl', async () => {
    const f = db.prepare(`SELECT id FROM model_files WHERE filename = 'WICKED - Gandalf Sculpture Images.zip'`).get();
    const list = (await request(app).get(`/api/files/${f.id}/zip-contents`)).body;
    expect(list.images.map(i => i.basename).sort()).toEqual(['render_main.png', 'side.png']);
    const ex = (await request(app).post(`/api/files/${f.id}/extract-images`).send({ selectedFiles: ['Gandalf/side.png'] })).body;
    expect(ex).toMatchObject({ success: true, extracted: 1 });
  });
});
