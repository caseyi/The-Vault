/**
 * Regroup review fixes (B1, S1, S3, S5, S6, S7, S9 and nits): rows written by the folder
 * scanner are rescanned layout-aware.
 *  - a legacy row becomes a work's row only when they are the same thing (>= 50% both ways)
 *  - a parent spread over more than 2 works keeps its user data in a "Was: <name>" collection
 *  - folded rows are out of hidden lists, collections and counts, and cannot be unhidden
 *  - hidden rows do not hide the work they fold into; favorite tools stay reachable
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-regroup-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let seq = 3000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 17)));
  return full;
}
const Q = 'StudioQ';
// a parent ("DC") whose files are four separate models now
for (const h of ['Batman', 'Superman', 'Flash', 'Robin']) mk(`${Q}/DC/${h}/${h.toLowerCase()}.stl`);
mk(`${Q}/DC/Robin/.ArchiveServiceTemp.sb-1a2b/robin_tmp.stl`); // skipped by the walk: must not keep DC unfolded
mk(`${Q}/DC/Flash/Unconfirmed 1234.crdownload`);
// a card the user hid (no files of its own: a parent claimed them) is the work in its folder
mk(`${Q}/Bird/bird.stl`);
// same folder, one row each way: Orc (3 of 4 files) is the base, Supported (1 of 4) folds
mk(`${Q}/Orc/orc1.stl`); mk(`${Q}/Orc/orc2.stl`); mk(`${Q}/Orc/orc3.stl`); mk(`${Q}/Orc/Supported/orc_s.stl`);
// visible base + hidden variant row; both rows hidden
mk(`${Q}/Elf/elf.stl`); mk(`${Q}/Elf/Supported/elf_s.stl`);
fs.writeFileSync(path.join(LIB, Q, 'Elf', 'render.png'), PNG);
mk(`${Q}/Elf/.smbdeleteAAA4f2`);
mk(`${Q}/Gnome/gnome.stl`); mk(`${Q}/Gnome/Supported/gnome_s.stl`);
// three variant rows, none of them >= 50%: no base, all fold; renders come from the rows
mk(`${Q}/Troll/Supported/troll_s.stl`); mk(`${Q}/Troll/Unsupported/troll_u.stl`); mk(`${Q}/Troll/Presupported/troll_p.stl`);
// a printed file that moved: printed_at follows filename + size
const WYVERN_SIZE = 4321;
mk(`${Q}/Wyvern/wyvern.stl`, WYVERN_SIZE);
mk(`${Q}/Ghoul/ghoul.stl`);
fs.writeFileSync(path.join(LIB, Q, 'Ghoul', 'model.json'), '{"studio": ');
mk('_Tools/Printer files/spacer.zip');
fs.mkdirSync(path.join(LIB, '_Meta'), { recursive: true });
fs.writeFileSync(path.join(LIB, '_Meta', 'gumroad_manifest.json'), JSON.stringify([
  // owned: one of its files (name key + size) is on a card, under another creator name
  { creator: 'Other Shop', product_name: 'Wyvern Pack', download_url: 'u-wyv', files: [{ file_name: 'Wyvern (1)', extension: 'stl', file_size: WYVERN_SIZE }] },
  // missing, bought twice: listed once
  { creator: 'Other Shop', product_name: 'Ghost Pack', download_url: 'u-ghost-1', files: [{ file_name: 'ghost', extension: 'zip', file_size: 999999 }] },
  { creator: 'Other Shop', product_name: 'Ghost Pack', download_url: 'u-ghost-2', files: [{ file_name: 'ghost', extension: 'zip', file_size: 999999 }, { file_name: 'ghost2', extension: 'zip', file_size: 888888 }] },
  { creator: 'Other Shop', product_name: 'Broken Pack', download_url: 'u-broken', files: {} },
]));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanSingleCreator, scanLibrary } = require('../scanner');

const P = (rel) => path.join(LIB, rel);
const ids = {};
function legacy(name, rel, files, extra = {}) {
  const cid = (db.prepare('SELECT id FROM creators WHERE name = ?').get(Q) || {}).id
    || db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)').run(Q, P(Q)).lastInsertRowid;
  const id = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path, tags, is_favorite, print_status, notes, hidden, images, thumbnail_path, folder_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'legacyhash')`).run(`uuid-${name.replace(/\W/g, '')}-${rel.length}`, name, cid, P(rel), JSON.stringify(extra.tags || []),
    extra.fav ? 1 : 0, extra.status || 'unprinted', extra.notes || null, extra.hidden ? 1 : 0, JSON.stringify(extra.images || []), (extra.images || [])[0] || null).lastInsertRowid;
  for (const f of files) {
    const full = P(f.rel || f);
    const size = f.size != null ? f.size : (fs.existsSync(full) ? fs.statSync(full).size : 1);
    db.prepare(`INSERT INTO model_files (model_id, filename, filepath, filetype, filesize, printed_at) VALUES (?,?,?,?,?,?)`)
      .run(id, path.basename(full), full, 'stl', size, f.printed || null);
  }
  ids[name] = id;
  return id;
}
const row = (id) => db.prepare('SELECT * FROM models WHERE id = ?').get(id);
const work = (rel) => db.prepare('SELECT * FROM models WHERE folder_path = ? AND folded_into IS NULL').get(P(rel));
let scanResult;

beforeAll(async () => {
  legacy('DC', `${Q}/DC`, [...['Batman', 'Superman', 'Flash', 'Robin'].map(h => `${Q}/DC/${h}/${h.toLowerCase()}.stl`),
    `${Q}/DC/Robin/.ArchiveServiceTemp.sb-1a2b/robin_tmp.stl`, `${Q}/DC/Flash/Unconfirmed 1234.crdownload`],
    { tags: ['dc'], fav: true, status: 'printed', notes: 'mixed heroes', images: ['/images/uuid-DC/cover.png'] });
  legacy('Orc', `${Q}/Orc`, [`${Q}/Orc/orc1.stl`, `${Q}/Orc/orc2.stl`, `${Q}/Orc/orc3.stl`], { tags: ['orc'] });
  legacy('Orc Supported', `${Q}/Orc/Supported`, [`${Q}/Orc/Supported/orc_s.stl`], { tags: ['sup'] });
  legacy('Elf', `${Q}/Elf`, [`${Q}/Elf/elf.stl`], { images: ['/images/uuid-Elf/elf_render.png'] });
  legacy('Elf Supported', `${Q}/Elf/Supported`, [`${Q}/Elf/Supported/elf_s.stl`], { hidden: true, tags: ['hidden-tag'] });
  legacy('Gnome', `${Q}/Gnome`, [`${Q}/Gnome/gnome.stl`], { hidden: true });
  legacy('Gnome Supported', `${Q}/Gnome/Supported`, [`${Q}/Gnome/Supported/gnome_s.stl`], { hidden: true });
  legacy('Troll S', `${Q}/Troll/Supported`, [`${Q}/Troll/Supported/troll_s.stl`], { images: ['/images/uuid-TrollS/troll.png'] });
  legacy('Troll U', `${Q}/Troll/Unsupported`, [`${Q}/Troll/Unsupported/troll_u.stl`]);
  legacy('Troll P', `${Q}/Troll/Presupported`, [`${Q}/Troll/Presupported/troll_p.stl`]);
  legacy('Bird', `${Q}/Bird`, [], { hidden: true, tags: ['bird-hidden'] });
  legacy('Orc Painted', `${Q}/Orc/Painted`, [], { hidden: true, tags: ['painted'] });
  legacy('Orc Lychee', `${Q}/Orc/Lychee`, [], { hidden: true }); // folder-scanner leftover: no data, no note
  legacy('Old Wyvern', `${Q}/Old Place`, [{ rel: `${Q}/Old Place/wyvern.stl`, size: WYVERN_SIZE, printed: '2026-02-03T00:00:00Z' }]);

  const heroes = db.prepare(`INSERT INTO collections (name) VALUES ('Heroes')`).run().lastInsertRowid;
  db.prepare('INSERT INTO collection_models (collection_id, model_id) VALUES (?, ?)').run(heroes, ids.DC);
  const hid = db.prepare(`INSERT INTO collections (name) VALUES ('Hidden faves')`).run().lastInsertRowid;
  db.prepare('INSERT INTO collection_models (collection_id, model_id) VALUES (?, ?)').run(hid, ids['Elf Supported']);
  db.prepare('INSERT INTO print_queue (model_id, position) VALUES (?, 1)').run(ids.DC);

  // S1: the first layout scan of ANY scope (here a creator rescan) takes the snapshot
  scanResult = await scanSingleCreator(P(Q), null, Q);
  await scanLibrary(LIB); // tools, _Meta sidecar count
});
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('B1: which legacy row a work takes over', () => {
  test('a parent spread over > 2 works is no work\'s base; its user data goes to a "Was:" collection', () => {
    const dc = row(ids.DC);
    expect(dc.hidden).toBe(1);
    expect(dc.folded_into).toBeTruthy();
    const heroes = ['Batman', 'Superman', 'Flash', 'Robin'].map(h => work(`${Q}/DC/${h}`));
    for (const h of heroes) {
      expect(h).toBeTruthy();
      expect(h.id).not.toBe(ids.DC);
      expect(JSON.parse(h.tags)).not.toContain('dc');            // not dumped onto one part
      expect(h.is_favorite).toBe(0);
      expect(h.print_status).toBe('unprinted');
      expect(JSON.parse(h.images)).not.toContain('/images/uuid-DC/cover.png'); // no unrelated renders
      expect(JSON.parse(h.attribution).foldedFrom).toEqual([expect.objectContaining({ id: ids.DC, name: 'DC', spread: 4 })]);
    }
    const was = db.prepare(`SELECT * FROM collections WHERE name = 'Was: DC'`).get();
    expect(was).toBeTruthy();
    expect(was.description).toMatch(/Tags: dc/);
    expect(was.description).toMatch(/Favorite: yes/);
    expect(was.description).toMatch(/Status: printed/);
    expect(was.description).toMatch(/Notes: mixed heroes/);
    const members = db.prepare('SELECT model_id FROM collection_models WHERE collection_id = ?').all(was.id).map(r => r.model_id).sort();
    expect(members).toEqual(heroes.map(h => h.id).sort());
    // the old row's own collection now holds the works, not the folded row
    const inHeroes = db.prepare(`SELECT cm.model_id FROM collection_models cm JOIN collections c ON c.id = cm.collection_id WHERE c.name = 'Heroes'`).all().map(r => r.model_id).sort();
    expect(inHeroes).toEqual(heroes.map(h => h.id).sort());
    expect(heroes.map(h => h.id)).toContain(db.prepare('SELECT model_id FROM print_queue').get().model_id);
  });

  test('>= 50% both ways: the row is the base; a small share folds into it', () => {
    const orc = work(`${Q}/Orc`);
    expect(orc.id).toBe(ids.Orc);
    expect(orc.file_count).toBe(4);
    expect(JSON.parse(orc.tags).sort()).toEqual(['orc', 'painted', 'sup']);
    expect(row(ids['Orc Supported']).folded_into).toBe(orc.id);
  });

  test('no row holds half of the work: all fold into a new card that reuses their renders (S9)', () => {
    const troll = work(`${Q}/Troll`);
    expect([ids['Troll S'], ids['Troll U'], ids['Troll P']]).not.toContain(troll.id);
    for (const n of ['Troll S', 'Troll U', 'Troll P']) expect(row(ids[n]).folded_into).toBe(troll.id);
    expect(JSON.parse(troll.images)).toContain('/images/uuid-TrollS/troll.png');
    expect(troll.thumbnail_path).toBe('/images/uuid-TrollS/troll.png');
  });

  test('a legacy base with renders keeps them: nothing is re-extracted (S9)', () => {
    const elf = work(`${Q}/Elf`);
    expect(elf.id).toBe(ids.Elf);
    expect(JSON.parse(elf.images)).toEqual(['/images/uuid-Elf/elf_render.png']);
    expect(fs.existsSync(path.join(process.env.IMAGES_DIR, elf.uuid))).toBe(false);
    expect(scanResult.extracted).toBeGreaterThan(0); // cards without any renders were extracted
  });
});

describe('S5: hidden rows', () => {
  test('a hidden row folded into a visible work: stays visible, note, collection moves', () => {
    const elf = work(`${Q}/Elf`);
    expect(elf.hidden).toBe(0);
    expect(elf.notes).toMatch(/Hidden before regroup: Elf Supported/);
    const hid = db.prepare(`SELECT id FROM collections WHERE name = 'Hidden faves'`).get().id;
    expect(db.prepare('SELECT model_id FROM collection_models WHERE collection_id = ?').all(hid).map(r => r.model_id)).toEqual([elf.id]);
    expect(row(ids['Elf Supported']).folded_into).toBe(elf.id);
  });
  test('a hidden card without files is the work of its own folder and stays hidden', () => {
    const bird = work(`${Q}/Bird`);
    expect(bird.id).toBe(ids.Bird);
    expect(bird.hidden).toBe(1);
    expect(JSON.parse(bird.tags)).toEqual(['bird-hidden']);
  });
  test('empty hidden rows below a work fold into it; only those with data leave a note', () => {
    const orc = work(`${Q}/Orc`);
    expect(orc.hidden).toBe(0);
    expect(row(ids['Orc Painted']).folded_into).toBe(orc.id);
    expect(row(ids['Orc Lychee']).folded_into).toBe(orc.id);
    expect(orc.notes).toMatch(/Hidden before regroup: Orc Painted/);
    expect(orc.notes).not.toMatch(/Orc Lychee/);
    expect(JSON.parse(orc.tags)).toContain('painted');
  });
  test('a work is hidden only when every row that held its files was hidden', () => {
    expect(work(`${Q}/Gnome`).hidden).toBe(1);
  });
});

describe('S1: snapshot before the first regroup, whatever the scope', () => {
  test('a creator rescan wrote the snapshot and recorded the regroup', () => {
    expect(fs.readdirSync(process.env.BACKUP_DIR).some(f => /^vault-pre-regroup-.*\.db$/.test(f))).toBe(true);
    expect(db.getSetting('layout_regroup_done')).toBeTruthy();
  });
  test('without a writable BACKUP_DIR the scan fails with a clear error and changes nothing', async () => {
    const prevDir = process.env.BACKUP_DIR;
    const before = db.prepare('SELECT COUNT(*) n FROM models').get().n;
    const blocker = path.join(ROOT, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    db.setSetting('layout_regroup_done', '');
    process.env.BACKUP_DIR = path.join(blocker, 'backups');
    try {
      await expect(scanSingleCreator(P(Q), null, Q)).rejects.toThrow(/BACKUP_DIR/);
      expect(db.prepare('SELECT COUNT(*) n FROM models').get().n).toBe(before);
      expect(db.prepare(`SELECT status, error FROM scan_log ORDER BY id DESC LIMIT 1`).get()).toEqual(expect.objectContaining({ status: 'error', error: expect.stringMatching(/BACKUP_DIR/) }));
    } finally {
      process.env.BACKUP_DIR = prevDir;
      db.setSetting('layout_regroup_done', new Date().toISOString());
    }
  });
});

describe('S3: folded rows', () => {
  test('not in show_hidden lists, collections or hidden counts', async () => {
    const all = await request(app).get('/api/models?show_hidden=1&limit=500');
    const listed = new Set(all.body.models.map(m => m.id));
    for (const n of ['DC', 'Orc Supported', 'Elf Supported', 'Troll S']) expect(listed.has(ids[n])).toBe(false);
    expect(listed.has(work(`${Q}/Gnome`).id)).toBe(true); // hidden by the user: still listed
    const stats = await request(app).get('/api/stats');
    expect(stats.body.totalHidden).toBe(2); // Gnome, Bird
    const cols = await request(app).get('/api/collections');
    expect(cols.body.find(c => c.name === 'Heroes').model_count).toBe(4);
    expect(cols.body.find(c => c.name === 'Was: DC').description).toMatch(/Was one card "DC"/);
  });
  test('unhiding a folded row answers 409; bulk unhide skips it', async () => {
    const r = await request(app).patch(`/api/models/${ids.DC}`).send({ hidden: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/folded into card/);
    expect(row(ids.DC).hidden).toBe(1);
    const gnome = work(`${Q}/Gnome`);
    const b = await request(app).post('/api/models/bulk').send({ ids: [ids.DC, gnome.id], hidden: false });
    expect(b.body.skippedFolded).toBe(1);
    expect(row(ids.DC).hidden).toBe(1);
    expect(row(gnome.id).hidden).toBe(0);
    await request(app).post('/api/models/bulk').send({ ids: [gnome.id], hidden: true });
  });
});

describe('nits', () => {
  test('printed_at follows a file by name + size', () => {
    const wy = work(`${Q}/Wyvern`);
    expect(db.prepare('SELECT printed_at FROM model_files WHERE model_id = ?').get(wy.id).printed_at).toBe('2026-02-03T00:00:00Z');
  });
  test('dotfiles (.smbdelete…) are skipped', () => {
    expect(db.prepare(`SELECT COUNT(*) n FROM model_files WHERE filename LIKE '.smbdelete%'`).get().n).toBe(0);
  });
  test('favorite tools are listed by the favorites filter', async () => {
    const tool = db.prepare(`SELECT id FROM models WHERE kind = 'tool'`).get();
    expect(tool).toBeTruthy();
    await request(app).patch(`/api/models/${tool.id}`).send({ is_favorite: true });
    const fav = await request(app).get('/api/models?favorite=1');
    expect(fav.body.models.map(m => m.id)).toContain(tool.id);
    const plain = await request(app).get('/api/models?limit=500');
    expect(plain.body.models.map(m => m.id)).not.toContain(tool.id);
  });
  test('apply-franchise moves cards that share the folder under "#slug" paths with it', async () => {
    const cid = db.prepare('SELECT id FROM creators WHERE name = ?').get(Q).id;
    mk('StudioR/Gob/gob.stl');
    const a = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path, franchise, kind) VALUES ('r-gob', 'Gob', ?, ?, 'Fantasy', 'model')`).run(cid, P('StudioR/Gob')).lastInsertRowid;
    const b = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path, kind) VALUES ('r-gob2', 'Gob Bust', ?, ?, 'work')`).run(cid, P('StudioR/Gob#work-gob-bust')).lastInsertRowid;
    db.prepare(`UPDATE models SET franchise = NULL WHERE id NOT IN (?, ?)`).run(a, b);
    const r = await request(app).post('/api/organize/apply-franchise').send({ dryRun: false });
    expect(r.status).toBe(200);
    expect(row(a).folder_path).toBe(P('StudioR/Fantasy/Gob'));
    expect(row(b).folder_path).toBe(P('StudioR/Fantasy/Gob#work-gob-bust'));
  });
});

describe('S2, S6, S7: _Meta status, health, gaps', () => {
  test('/api/meta/status reports malformed manifests and corrupt model.json', async () => {
    const r = await request(app).get('/api/meta/status');
    expect(r.status).toBe(200);
    expect(r.body.errors.some(e => /gumroad_manifest\.json: 1 malformed/.test(e))).toBe(true);
    expect(r.body.errors.some(e => /Ghoul.*model\.json/.test(e))).toBe(true);
    expect(r.body.counts.sidecarErrors).toBe(1);
  });
  test('gaps: owned when any file (name key + size) is on a card; one entry per creator + name', async () => {
    const r = await request(app).get('/api/attribution/gaps');
    const names = r.body.products.map(p => p.name);
    expect(names).toEqual(['Ghost Pack']);
    expect(r.body.products[0].files).toBe(2);
  });
  test('/api/health answers from its cache: no synchronous filesystem calls', async () => {
    await request(app).get('/api/health');
    const rd = jest.spyOn(fs, 'readdirSync');
    const ac = jest.spyOn(fs, 'accessSync');
    try {
      const r = await request(app).get('/api/health');
      expect(r.body.libraries.length).toBeGreaterThan(0);
      expect(typeof r.body.libraryWritable).toBe('boolean');
      expect(rd).not.toHaveBeenCalled();
      expect(ac).not.toHaveBeenCalled();
    } finally { rd.mockRestore(); ac.mockRestore(); }
  });
});
