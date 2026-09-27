/**
 * Integration tests against a REAL temp SQLite DB + temp library on disk.
 * Covers the 2026-09 hardening fixes (B2–B7, B11, B13, B15, U1, contract items).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-it-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
const OUTSIDE = path.join(ROOT, 'outside');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
delete process.env.LIBRARY_HOST_PATH;
delete process.env.LIBRARY_NAME;
delete process.env.ORGANIZE_SSH_TARGET;
delete process.env.ALLOWED_ORIGINS;

function mk(rel, content = 'solid x\nendsolid x\n') {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'top secret');
fs.writeFileSync(path.join(OUTSIDE, 'evil.stl'), 'solid evil');

// ── Library fixture ──────────────────────────────────────────────────────────
// U1: printable files only in variant sub-folders
mk('StudioA/Wicked - Mandalorian Bust/Supported/bust_supported.stl');
mk('StudioA/Wicked - Mandalorian Bust/Supported/base_supported.stl');
mk('StudioA/Wicked - Mandalorian Bust/Unsupported/bust_unsupported.stl');
mk('StudioA/Wicked - Mandalorian Bust/Renders/render_2.png', 'PNG');
mk('StudioA/Wicked - Mandalorian Bust/render_1.png', 'PNG');
mk('StudioA/Dragon/dragon.stl');
mk('StudioA/Knight/knight.stl');
mk('StudioB/Marvel/Avengers/Iron Man/ironman.stl');
mk('StudioB/Boba Fett Helmet/FDM/helmet_fdm.stl');
mk('StudioB/Boba Fett Helmet/Resin/helmet_resin.stl');
mk('StudioB/Boba Fett Helmet/Renders/r.jpg', 'JPG');
// independent sub-model next to a variant folder → NOT merged
mk('StudioB/Mixed Pack/Supported/a.stl');
mk('StudioB/Mixed Pack/Bonus Goblin/goblin.stl');
// stale pre-fix model living inside a variant folder (absorbed on scan)
mk('StudioC/Old Model/Supported/x.stl');
mk('StudioC/Other/o.stl');
// B5: per-creator rescan
for (const n of ['01', '02', '03', '04', '05']) mk(`StudioD/Model${n}/m.stl`);

// Render zip for reextract (B4)
const AdmZip = require('adm-zip');
{
  const z = new AdmZip();
  z.addFile('render_main.png', Buffer.from('PNGDATA'));
  z.addFile('notes.txt', Buffer.from('hello'));
  z.writeZip(path.join(LIB, 'StudioA/Dragon/renders.zip'));
}

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary, scanSingleCreator } = require('../scanner');
const { acquireAiJob } = require('../lib/jobs');

const byPath = (rel) => db.prepare('SELECT * FROM models WHERE folder_path = ?').get(path.join(LIB, rel));

beforeAll(async () => {
  // Pre-insert the kind of row the OLD scanner produced for a variant folder
  const cid = db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)').run('StudioC', path.join(LIB, 'StudioC')).lastInsertRowid;
  const kid = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path, tags, print_status, is_favorite)
    VALUES ('stale-uuid', 'Supported', ?, ?, '["legacy"]', 'printed', 1)`).run(cid, path.join(LIB, 'StudioC/Old Model/Supported')).lastInsertRowid;
  db.prepare(`INSERT INTO model_files (model_id, filename, filepath, filetype) VALUES (?, 'x.stl', ?, 'stl')`)
    .run(kid, path.join(LIB, 'StudioC/Old Model/Supported/x.stl'));
  const col = db.prepare(`INSERT INTO collections (name) VALUES ('Faves')`).run().lastInsertRowid;
  db.prepare('INSERT INTO collection_models (collection_id, model_id) VALUES (?, ?)').run(col, kid);

  await scanLibrary(LIB);
});

afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── U1: variant sub-folders are one model ─────────────────────────────────────

describe('U1 variant folder grouping', () => {
  test('model with only Supported/Unsupported/Renders sub-folders is ONE model', () => {
    const m = byPath('StudioA/Wicked - Mandalorian Bust');
    expect(m).toBeTruthy();
    expect(m.name).toBe('Wicked Mandalorian Bust');
    expect(m.franchise).toBeNull(); // no bogus franchise from the variant folder
    for (const bogus of ['Supported', 'Unsupported', 'Renders']) {
      expect(byPath(`StudioA/Wicked - Mandalorian Bust/${bogus}`)).toBeFalsy();
    }
    const files = db.prepare('SELECT filename, release_name FROM model_files WHERE model_id = ?').all(m.id);
    expect(files.map(f => f.filename).sort()).toEqual(
      ['base_supported.stl', 'bust_supported.stl', 'bust_unsupported.stl', 'render_1.png', 'render_2.png'].sort());
    // renders from both the model folder and Renders/ are kept
    const imgs = JSON.parse(m.images);
    expect(imgs.some(i => i.endsWith('render_1.png'))).toBe(true);
    expect(imgs.some(i => i.endsWith('render_2.png'))).toBe(true);
  });

  test('FDM/Resin variants merge; an independent sub-model blocks the merge', () => {
    expect(byPath('StudioB/Boba Fett Helmet')).toBeTruthy();
    expect(byPath('StudioB/Boba Fett Helmet/FDM')).toBeFalsy();
    expect(byPath('StudioB/Mixed Pack')).toBeFalsy();
    expect(byPath('StudioB/Mixed Pack/Bonus Goblin')).toBeTruthy();
  });

  test('stale pre-fix variant model is absorbed (files, tags, status, collections) and hidden', () => {
    const parent = byPath('StudioC/Old Model');
    const kid = byPath('StudioC/Old Model/Supported');
    expect(parent).toBeTruthy();
    expect(kid.hidden).toBe(1);
    expect(JSON.parse(parent.tags)).toContain('legacy');
    expect(parent.print_status).toBe('printed');
    expect(parent.is_favorite).toBe(1);
    const f = db.prepare('SELECT model_id FROM model_files WHERE filepath = ?').get(path.join(LIB, 'StudioC/Old Model/Supported/x.stl'));
    expect(f.model_id).toBe(parent.id);
    expect(db.prepare('SELECT COUNT(*) n FROM collection_models WHERE model_id = ?').get(parent.id).n).toBe(1);
  });

  test('a folder-role override on a sub-folder takes precedence over the merge', async () => {
    mk('StudioE/Override Me/FDM/a.stl');
    mk('StudioE/Override Me/Resin/b.stl');
    mk('StudioE/Plain/p.stl');
    db.prepare(`INSERT INTO folder_overrides (path, role) VALUES (?, 'passthrough')`).run(path.join(LIB, 'StudioE/Override Me/FDM'));
    const creatorId = db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)').run('StudioE', path.join(LIB, 'StudioE')).lastInsertRowid;
    await scanSingleCreator(path.join(LIB, 'StudioE'), creatorId, 'StudioE');
    expect(byPath('StudioE/Override Me')).toBeFalsy();
    expect(byPath('StudioE/Override Me/FDM')).toBeTruthy();
  });
});

// ── B3: user edits survive a forced rescan ────────────────────────────────────

describe('B3 rescans preserve user data', () => {
  test('custom name + franchise survive a forced rescan; unlocked names still refresh', async () => {
    const dragon = byPath('StudioA/Dragon');
    let res = await request(app).patch(`/api/models/${dragon.id}`).send({ name: 'My Custom Dragon', franchise: 'Star Wars' });
    expect(res.status).toBe(200);
    const iron = byPath('StudioB/Marvel/Avengers/Iron Man');
    expect(iron.franchise).toBe('Marvel');
    await request(app).patch(`/api/models/${iron.id}`).send({ franchise: 'MCU' });
    const knight = byPath('StudioA/Knight');
    db.prepare(`UPDATE models SET name = 'Stale Name' WHERE id = ?`).run(knight.id);

    db.prepare('UPDATE models SET folder_hash = NULL').run(); // what a forced rescan does
    await scanLibrary(LIB);

    const d2 = byPath('StudioA/Dragon');
    expect(d2.name).toBe('My Custom Dragon');
    expect(d2.name_locked).toBe(1);
    expect(d2.franchise).toBe('Star Wars');
    expect(byPath('StudioB/Marvel/Avengers/Iron Man').franchise).toBe('MCU');
    expect(byPath('StudioA/Knight').name).toBe('Knight');
  });

  test('AI annotate RENAME (by preview id) locks the name', async () => {
    const knight = byPath('StudioA/Knight');
    const prev = await request(app).post('/api/organize/annotate/preview').send({ directives: ['RENAME: Knight -> Sir Knight'] });
    expect(prev.body.changes[0].id).toBe(knight.id);
    const res = await request(app).post('/api/organize/annotate/apply').send({ changes: prev.body.changes });
    expect(res.body.applied).toBe(1);
    const k = byPath('StudioA/Knight');
    expect(k.name).toBe('Sir Knight');
    expect(k.name_locked).toBe(1);
  });

  test('annotate never guesses between ambiguous partial matches', async () => {
    const prev = await request(app).post('/api/organize/annotate/preview').send({ directives: ['FRANCHISE: Model0 -> Foo'] });
    expect(prev.body.changes[0].found).toBe(false); // Model01..05 all match "Model0"
    const res = await request(app).post('/api/organize/annotate/apply').send({ directives: ['FRANCHISE: Model0 -> Foo'] });
    expect(res.body.applied).toBe(0);
  });
});

// ── B5: per-creator rescan processes every model in a chunk ───────────────────

describe('B5 scanSingleCreator', () => {
  test('new models after an unchanged one in the same chunk are all added', async () => {
    for (const n of ['06', '07', '08']) mk(`StudioD/Model${n}/m.stl`);
    const c = db.prepare(`SELECT * FROM creators WHERE name = 'StudioD'`).get();
    const r = await scanSingleCreator(c.folder_path, c.id, c.name);
    expect(r.modelsAdded).toBe(3);
    expect(r.modelsSkipped).toBe(5);
    expect(db.prepare('SELECT COUNT(*) n FROM models WHERE creator_id = ?').get(c.id).n).toBe(8);
  });
});

// ── B13: route order ──────────────────────────────────────────────────────────

describe('B13 routes', () => {
  test('/api/models/common-tags is reachable and :id only matches digits', async () => {
    const a = byPath('StudioA/Dragon'), b = byPath('StudioD/Model01');
    await request(app).patch(`/api/models/${a.id}`).send({ tags: ['x', 'shared'] });
    await request(app).patch(`/api/models/${b.id}`).send({ tags: ['shared', 'y'] });
    const res = await request(app).get(`/api/models/common-tags?ids=${a.id},${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body.commonTags).toEqual(['shared']);
    expect(res.body.allTags).toEqual(['shared', 'x', 'y']);
    expect((await request(app).get('/api/models/abc')).status).toBe(404);
  });
});

// ── B4: reextract over GET (EventSource) and POST ─────────────────────────────

describe('B4 reextract', () => {
  test.each(['get', 'post'])('%s /api/creators/:id/reextract streams and completes', async (method) => {
    const c = db.prepare(`SELECT id FROM creators WHERE name = 'StudioA'`).get();
    const res = await request(app)[method](`/api/creators/${c.id}/reextract`).buffer(true).parse((r, cb) => {
      let d = ''; r.on('data', x => { d += x; }); r.on('end', () => cb(null, d));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.body).toMatch(/"type":"done","success":true/);
    expect(res.body).toMatch(/image\(s\) saved/);
    const d = byPath('StudioA/Dragon');
    expect(JSON.parse(d.images).some(i => i.endsWith('render_main.png'))).toBe(true);
  });
});

// ── B6/B15: path confinement ──────────────────────────────────────────────────

describe('path confinement', () => {
  beforeAll(() => { fs.symlinkSync(OUTSIDE, path.join(LIB, 'escape')); });
  afterAll(() => { fs.unlinkSync(path.join(LIB, 'escape')); });

  test('loose-files / fs-tree reject paths outside the library (incl. traversal + symlinks)', async () => {
    for (const p of ['/etc', OUTSIDE, `${LIB}/../outside`, path.join(LIB, 'escape')]) {
      expect((await request(app).get('/api/organize/loose-files').query({ path: p })).status).toBe(403);
      expect((await request(app).get('/api/organize/fs-tree').query({ path: p })).status).toBe(403);
    }
    expect((await request(app).get('/api/organize/loose-files').query({ path: `${LIB}/a\0b` })).status).toBe(400);
    expect((await request(app).get('/api/organize/loose-files').query({ path: path.join(LIB, 'StudioA') })).status).toBe(200);
  });

  test('classify-folders, group-files, folder-overrides and POST /api/scan are confined', async () => {
    let res = await request(app).post('/api/organize/classify-folders').set('x-claude-key', 'sk-ant-test').send({ path: '/etc' });
    expect(res.status).toBe(403);
    res = await request(app).post('/api/organize/group-files').send({ path: OUTSIDE, groups: [{ name: 'g', files: ['secret.txt'] }], dryRun: false });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(OUTSIDE, 'secret.txt'))).toBe(true);
    res = await request(app).post('/api/organize/folder-overrides').send({ path: '/etc', role: 'ignore' });
    expect(res.status).toBe(403);
    res = await request(app).post('/api/scan').send({ path: '/etc' });
    expect(res.status).toBe(403);
  });

  test('file-serving and zip routes refuse DB rows that point outside the library', async () => {
    const m = byPath('StudioA/Dragon');
    const stl = db.prepare(`INSERT INTO model_files (model_id, filename, filepath, filetype) VALUES (?, 'evil.stl', ?, 'stl')`)
      .run(m.id, path.join(OUTSIDE, 'evil.stl')).lastInsertRowid;
    expect((await request(app).get(`/api/files/${stl}/stl`)).status).toBe(403);
    expect((await request(app).get(`/api/files/${stl}/zip-contents`)).status).toBe(403);
    expect((await request(app).post(`/api/files/${stl}/extract-images`).send({})).status).toBe(403);
    db.prepare('DELETE FROM model_files WHERE id = ?').run(stl);
    // a real in-library STL still streams
    const ok = db.prepare(`SELECT id FROM model_files WHERE model_id = ? AND filetype = 'stl'`).get(m.id);
    const res = await request(app).get(`/api/files/${ok.id}/stl`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('PATCH thumbnail_path must stay under /images/', async () => {
    const m = byPath('StudioA/Dragon');
    for (const bad of ['/images/../../etc/passwd', '/etc/passwd', '../x.png', '/images/a\\..\\b']) {
      expect((await request(app).patch(`/api/models/${m.id}`).send({ thumbnail_path: bad })).status).toBe(400);
    }
    expect((await request(app).patch(`/api/models/${m.id}`).send({ thumbnail_path: `/images/${m.uuid}/render_main.png` })).status).toBe(200);
  });
});

// ── B2 / B7: loose file grouping + generated script ──────────────────────────

describe('B2 group-files', () => {
  const dir = path.join(LIB, 'Loose');
  beforeAll(() => {
    mk('Loose/a.stl', 'A');
    mk('Loose/b.stl', 'NEW');
    mk('Loose/grp/b.stl', 'OLD');
  });

  test('rejects unsafe names and never overwrites', async () => {
    const res = await request(app).post('/api/organize/group-files').send({
      path: dir, dryRun: false,
      groups: [
        { name: 'grp', files: ['b.stl'] },
        { name: '../escaped', files: ['a.stl'] },
        { name: 'ok', files: ['../a.stl', 'a\0.stl'] },
        { name: '', files: ['a.stl'] },
      ],
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'grp/b.stl'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(dir, 'b.stl'), 'utf8')).toBe('NEW');
    expect(fs.existsSync(path.join(LIB, 'escaped'))).toBe(false);
    expect(res.body.errors.filter(e => e.type === 'invalid').length).toBe(4);
    expect(res.body.errors.some(e => e.type === 'move' && /exists/.test(e.error))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a.stl'))).toBe(true);
  });

  test('moves files, falling back to copy+unlink across devices (EXDEV)', async () => {
    const spy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; });
    const res = await request(app).post('/api/organize/group-files').send({ path: dir, dryRun: false, groups: [{ name: 'moved', files: ['a.stl'] }] });
    spy.mockRestore();
    expect(res.body.errors).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'moved/a.stl'), 'utf8')).toBe('A');
    expect(fs.existsSync(path.join(dir, 'a.stl'))).toBe(false);
  });
});

describe('B7 generated script', () => {
  test('filenames are shell-quoted — "$(touch pwned).stl" is inert', async () => {
    mk('Script/$(touch pwned).stl', 'x');
    mk("Script/it's `id`.stl", 'y');
    const dir = path.join(LIB, 'Script');
    const res = await request(app).post('/api/organize/group-files').send({
      path: dir, groups: [{ name: 'Group $(whoami)', files: ['$(touch pwned).stl', "it's `id`.stl"] }],
    });
    expect(res.status).toBe(200);
    const { script } = res.body;
    expect(script).not.toMatch(/ssh casey@dagobah/);
    expect(script).toContain(`mv -n -- '$(touch pwned).stl' 'Group $(whoami)/'`);
    execFileSync('bash', ['-c', script], { cwd: OUTSIDE });
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(OUTSIDE, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'Group $(whoami)', '$(touch pwned).stl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'Group $(whoami)', "it's `id`.stl"))).toBe(true);
  });

  test('maps the container path to LIBRARY_HOST_PATH and uses ORGANIZE_SSH_TARGET', async () => {
    process.env.LIBRARY_HOST_PATH = '/volume1/STL Archive';
    process.env.ORGANIZE_SSH_TARGET = 'me@nas';
    try {
      const res = await request(app).post('/api/organize/group-files').send({ path: path.join(LIB, 'StudioA'), groups: [{ name: 'g', files: ['f.stl'] }] });
      expect(res.body.script).toContain(`cd -- '/volume1/STL Archive/StudioA'`);
      expect(res.body.script).toContain('ssh me@nas');
    } finally {
      delete process.env.LIBRARY_HOST_PATH;
      delete process.env.ORGANIZE_SSH_TARGET;
    }
  });
});

// ── B6: apply-franchise ───────────────────────────────────────────────────────

describe('B6 apply-franchise', () => {
  let model;
  beforeAll(async () => {
    mk('StudioF/Model X/m.stl');
    mk('StudioF/Model X/sub/n.stl');
    mk('StudioF/Model Y/y.stl');
    mk('StudioF/Blocked/Model Y/already.txt', 'x');
    const creatorId = db.prepare('INSERT INTO creators (name, folder_path) VALUES (?, ?)').run('StudioF', path.join(LIB, 'StudioF')).lastInsertRowid;
    await scanSingleCreator(path.join(LIB, 'StudioF'), creatorId, 'StudioF');
    model = byPath('StudioF/Model X');
    db.prepare(`UPDATE models SET franchise = '../../../outside' WHERE id = ?`).run(model.id);
    db.prepare(`UPDATE models SET franchise = 'Blocked' WHERE id = ?`).run(byPath('StudioF/Model Y').id);
  });

  test('franchise is sanitised to one path segment; existing destinations are refused', async () => {
    const iron = byPath('StudioB/Marvel/Avengers/Iron Man');
    db.prepare(`UPDATE models SET franchise = 'Marvel' WHERE id = ?`).run(iron.id);
    const res = await request(app).post('/api/organize/apply-franchise').send({ dryRun: true });
    db.prepare(`UPDATE models SET franchise = ? WHERE id = ?`).run(iron.franchise, iron.id);
    expect(res.body.moves.find(m => m.id === iron.id)).toBeUndefined();
    const mv = res.body.moves.find(m => m.id === model.id);
    expect(mv.to).toBe(path.join(LIB, 'StudioF', 'outside', 'Model X'));
    expect(res.body.errors.some(e => /already exists/.test(e.error))).toBe(true);
  });

  test('read-only library → clear 409 before anything moves', async () => {
    const spy = jest.spyOn(fs, 'accessSync').mockImplementation(() => { const e = new Error('read-only'); e.code = 'EROFS'; throw e; });
    const res = await request(app).post('/api/organize/apply-franchise').send({ dryRun: false });
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.readOnly).toBe(true);
    expect(fs.existsSync(path.join(LIB, 'StudioF/Model X'))).toBe(true);
  });

  test('moves the folder and rewrites folder_path + model_files in one go', async () => {
    const onlyThis = db.prepare(`UPDATE models SET franchise = NULL WHERE franchise IS NOT NULL AND id != ?`);
    const saved = db.prepare('SELECT id, franchise FROM models WHERE franchise IS NOT NULL').all();
    onlyThis.run(model.id);
    try {
      const res = await request(app).post('/api/organize/apply-franchise').send({ dryRun: false });
      expect(res.status).toBe(200);
      expect(res.body.summary.executed).toBe(1);
      const newDir = path.join(LIB, 'StudioF', 'outside', 'Model X');
      expect(fs.existsSync(path.join(newDir, 'sub', 'n.stl'))).toBe(true);
      expect(db.prepare('SELECT folder_path FROM models WHERE id = ?').get(model.id).folder_path).toBe(newDir);
      const files = db.prepare('SELECT filepath FROM model_files WHERE model_id = ?').all(model.id).map(f => f.filepath);
      expect(files.every(f => f.startsWith(newDir + path.sep))).toBe(true);
      expect(fs.existsSync(path.join(ROOT, 'outside', 'Model X'))).toBe(false);
    } finally {
      const restore = db.prepare('UPDATE models SET franchise = ? WHERE id = ?');
      for (const r of saved) restore.run(r.franchise, r.id);
    }
  });
});

// ── B15: LIKE escaping, limit clamping, scan log ring buffer, cancel ─────────

describe('B15 query hygiene', () => {
  test('search wildcards are literal', async () => {
    const all = await request(app).get('/api/models').query({ limit: 500 });
    const pct = await request(app).get('/api/models').query({ search: '%' });
    expect(all.body.total).toBeGreaterThan(5);
    expect(pct.body.total).toBe(0);
    const us = await request(app).get('/api/models').query({ search: 'Model_1' });
    expect(us.body.total).toBe(0); // "_" is not a wildcard (Model01 doesn't match)
  });

  test('negative / huge limit and page are clamped', async () => {
    let res = await request(app).get('/api/models').query({ limit: -5, page: -3 });
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.models.length).toBe(1);
    res = await request(app).get('/api/models').query({ limit: 1e9 });
    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(1);
  });
});

describe('B15 scan status ring buffer + cancel (worker thread)', () => {
  const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const p = (await request(app).get('/api/scan/progress')).body;
      if (!p.inProgress) return p;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('scan did not finish');
  };

  test('/api/scan/status returns at most 500 lines and flags truncation', async () => {
    for (let i = 0; i < 320; i++) mk(`Bulk/Model ${String(i).padStart(3, '0')}/m.stl`);
    const res = await request(app).post('/api/scan').send({ path: LIB });
    expect(res.status).toBe(200);
    await waitIdle();
    const st = (await request(app).get('/api/scan/status')).body;
    expect(st.log.length).toBeLessThanOrEqual(500);
    expect(st.truncated).toBe(true);
    expect(st.summary.success).toBe(true);
  }, 30000);

  test('a cancelled scan never leaves a scan_log row stuck at running', async () => {
    const before = db.prepare('SELECT MAX(id) AS id FROM scan_log').get().id;
    const res = await request(app).post('/api/scan').send({ path: LIB, force: true });
    expect(res.status).toBe(200);
    // wait until the worker has actually started its scan_log row
    for (let i = 0; i < 100; i++) {
      if (db.prepare('SELECT MAX(id) AS id FROM scan_log').get().id > before) break;
      await new Promise(r => setTimeout(r, 5));
    }
    const c = await request(app).post('/api/scan/cancel');
    await waitIdle();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scan_log WHERE status = 'running'`).get().n).toBe(0);
    const row = db.prepare('SELECT status FROM scan_log WHERE id > ? ORDER BY id DESC LIMIT 1').get(before);
    if (c.body.cancelled && row) expect(['cancelled', 'complete']).toContain(row.status);
    const st = (await request(app).get('/api/scan/status')).body;
    if (c.body.cancelled) expect(st.summary.error).toBe('Scan cancelled');
  }, 30000);
});

// ── Health (U13) ──────────────────────────────────────────────────────────────

describe('organize health', () => {
  test('variant-only names are not cross-creator dupes; copies are near-dupes', async () => {
    const ins = db.prepare(`INSERT INTO models (uuid, name, creator_id, folder_path) VALUES (?, ?, ?, ?)`);
    const c1 = db.prepare(`SELECT id FROM creators WHERE name = 'StudioA'`).get().id;
    const c2 = db.prepare(`SELECT id FROM creators WHERE name = 'StudioB'`).get().id;
    ins.run('h1', 'Supported', c1, '/virtual/a/Supported');
    ins.run('h2', 'Supported', c2, '/virtual/b/Supported');
    ins.run('h3', 'Resin', c1, '/virtual/a/Resin');
    ins.run('h4', 'Resin', c2, '/virtual/b/Resin');
    ins.run('h5', 'StudioA - Samurai Oni 2024-04', c1, '/virtual/a/Samurai');
    ins.run('h6', 'StudioA - Samurai Oni 2024-04 (copy)', c1, '/virtual/a/Samurai copy');
    const res = await request(app).get('/api/organize/health');
    expect(res.status).toBe(200);
    expect(res.body.crossCreatorDupes.map(d => d.key)).not.toEqual(expect.arrayContaining(['supported']));
    expect(res.body.crossCreatorDupes.map(d => d.key)).not.toEqual(expect.arrayContaining(['resin']));
    expect(res.body.duplicates.some(d => [d.a.name, d.b.name].sort().join('|') === 'StudioA - Samurai Oni 2024-04|StudioA - Samurai Oni 2024-04 (copy)')).toBe(true);
    db.prepare(`DELETE FROM models WHERE uuid IN ('h1','h2','h3','h4','h5','h6')`).run();
  });
});

// ── Contract: origin policy, health, AI job guard ─────────────────────────────

describe('origin policy (ALLOWED_ORIGINS)', () => {
  test('foreign origins are refused; same-origin, no-origin and Tauri are allowed', async () => {
    expect((await request(app).get('/api/stats').set('Origin', 'http://evil.example')).status).toBe(403);
    const pre = await request(app).options('/api/organize/group-files').set('Origin', 'http://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(403);
    expect((await request(app).get('/api/stats')).status).toBe(200);
    // same hostname as Host, port ignored
    expect((await request(app).get('/api/stats').set('Host', 'nas.local:8484').set('Origin', 'http://nas.local:3000')).status).toBe(200);
    expect((await request(app).get('/api/stats').set('Host', 'backend:3001').set('X-Forwarded-Host', '192.168.1.140:8484').set('Origin', 'http://192.168.1.140:8484')).status).toBe(200);
    const t = await request(app).get('/api/stats').set('Origin', 'tauri://localhost');
    expect(t.status).toBe(200);
    expect(t.headers['access-control-allow-origin']).toBe('tauri://localhost');
    const tp = await request(app).options('/api/models/1').set('Origin', 'http://tauri.localhost').set('Access-Control-Request-Method', 'PATCH');
    expect(tp.status).toBe(204);
  });
});

describe('contract', () => {
  test('/api/health reports build + library info', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toMatchObject({ ok: true, libraryPath: LIB, gitSha: 'dev', libraryWritable: true });
    expect(res.body).toHaveProperty('buildDate');
    expect(res.body).toHaveProperty('version');
  });

  test('only one AI batch job at a time (409)', async () => {
    const release = acquireAiJob('test-job');
    try {
      const res = await request(app).get('/api/ai/generate-tags').query({ key: 'sk-ant-x' });
      expect(res.status).toBe(409);
      expect(res.body.running.name).toBe('test-job');
    } finally { release(); }
  });
});
