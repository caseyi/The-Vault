/**
 * Thumbnails (docs/thumbnails.md) against a real temp DB, library and images folder:
 * migration columns, picture finding during scans (render archives, loose images, archive peek),
 * the attempt signature, the fill job over SSE, mesh renders, /thumbs generation, cache headers,
 * fallback without sharp, path confinement, list/detail fields and user thumbnails.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-thumbs-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
const IMAGES = path.join(DATA, 'images');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = IMAGES;
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
delete process.env.THUMBS_NO_SHARP;
delete process.env.THUMB_PIPELINE_VERSION;
delete process.env.ALLOWED_ORIGINS;

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const fx = require('./mesh-fixtures');

const put = (rel, data) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

let request, app, db, scanLibrary, pictures, server, base;
const byName = (name) => db.prepare('SELECT * FROM models WHERE name = ?').get(name);
const imgs = (m) => JSON.parse(m.images || '[]');

/** Read an SSE response to the end: [events]. */
async function sse(url) {
  const res = await fetch(base + url);
  const text = await res.text();
  return { status: res.status, events: text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6))) };
}

beforeAll(async () => {
  // render archive by name
  {
    const z = new AdmZip();
    z.addFile('render_main.png', await fx.noisyImage(sharp, 120, 90));
    put('Studio/Render Card/Renders.zip', z.toBuffer());
    put('Studio/Render Card/thing.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 10, 10)));
  }
  // loose image
  put('Studio/Loose Card/model.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 10, 10)));
  put('Studio/Loose Card/photo.jpg', await fx.noisyImage(sharp, 160, 120, 'jpeg'));
  // archive peek: the zip name carries no render keyword; a tiny icon must be ignored
  {
    const z = new AdmZip();
    z.addFile('MH-06/hero_front.png', await fx.noisyImage(sharp, 300, 240));
    z.addFile('MH-06/detail.jpg', await fx.noisyImage(sharp, 200, 200, 'jpeg'));
    z.addFile('MH-06/icon.png', await fx.noisyImage(sharp, 40, 40));
    z.addFile('MH-06/level_1.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 10, 10)));
    put('Studio/Peek Card/MH-06-SUP-Levels.zip', z.toBuffer());
  }
  // only meshes: two parts of one model
  put('Studio/Mesh Card/body.stl', fx.binaryStl(fx.torusTris(60, 30)));
  put('Studio/Mesh Card/head.stl', fx.asciiStl(fx.boxTris(-8, -8, 22, 8, 8, 38)));
  put('Studio/Mesh Card/supports.stl', fx.binaryStl(fx.boxTris(-100, -100, 0, -90, -90, 5)));
  // a mesh, rendered later, then a photo arrives
  put('Studio/Swap Card/swap.obj', fx.obj(fx.boxTris(0, 0, 0, 20, 10, 30)));
  // nothing to show: an empty STL
  put('Studio/Empty Card/empty.stl', 'solid x\nendsolid x\n');

  request = require('supertest');
  app = require('../server');
  db = require('../db');
  ({ scanLibrary } = require('../scanner'));
  pictures = require('../lib/pictures');
  await scanLibrary(LIB);
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}, 60000);

afterAll(async () => {
  require('../lib/thumbs').stopFiller();
  await new Promise(r => server.close(r));
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('migration', () => {
  test('models has thumb_source and thumb_attempt', () => {
    const cols = db.prepare('PRAGMA table_info(models)').all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['thumb_source', 'thumb_attempt']));
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(db.SCHEMA_VERSION);
    expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
  });
});

describe('finding pictures during a scan', () => {
  test('render archive by name → archive; loose image → folder', () => {
    const r = byName('Render Card');
    expect(r.thumb_source).toBe('archive');
    expect(r.thumbnail_path).toMatch(/render_main\.png$/);
    const l = byName('Loose Card');
    expect(l.thumb_source).toBe('folder');
    expect(l.thumbnail_path).toMatch(/photo\.jpg$/);
  });

  test('archive peek takes the best images from a zip without a render name and skips tiny icons', () => {
    const p = byName('Peek Card');
    expect(p.thumb_source).toBe('archive-peek');
    const names = imgs(p).map(i => i.split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['hero_front.png', 'detail.jpg']));
    expect(names).not.toContain('icon.png');
    expect(p.thumbnail_path).toMatch(/hero_front\.png$/);
    expect(fs.existsSync(path.join(IMAGES, p.uuid, 'hero_front.png'))).toBe(true);
  });

  test('peek ranking: bigger and better-named images first', () => {
    expect(pictures.peekScore('a/hero.png', 500000, 'x.zip')).toBeGreaterThan(pictures.peekScore('a/back.png', 500000, 'x.zip'));
    expect(pictures.peekScore('a/img.png', 2000000, 'x.zip')).toBeGreaterThan(pictures.peekScore('a/img.png', 30000, 'x.zip'));
    expect(pictures.peekScore('__MACOSX/a/._hero.png', 500000, 'x.zip')).toBeLessThan(0);
  });

  test('a card without pictures remembers its attempt', () => {
    const m = byName('Mesh Card');
    expect(imgs(m)).toEqual([]);
    const a = pictures.parseAttempt(m.thumb_attempt);
    expect(a.version).toBe(pictures.pipelineVersion());
    expect(a.steps).toBe('afp');
  });
});

describe('attempt signature', () => {
  test('an unchanged rescan does not look again; a pipeline version bump retries once', async () => {
    const spy = jest.spyOn(pictures, 'findPictures');
    try {
      await scanLibrary(LIB);
      expect(spy).not.toHaveBeenCalled();
      process.env.THUMB_PIPELINE_VERSION = 'test-2';
      await scanLibrary(LIB);
      const retried = spy.mock.calls.length;
      expect(retried).toBeGreaterThanOrEqual(3); // Mesh, Swap and Empty card
      expect(pictures.parseAttempt(byName('Empty Card').thumb_attempt).version).toBe('test-2');
      spy.mockClear();
      await scanLibrary(LIB);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env.THUMB_PIPELINE_VERSION;
      spy.mockRestore();
    }
    await scanLibrary(LIB); // back to the normal version (retries once more)
  });

  test('loose images are retried for an unchanged card that has none', async () => {
    const l = byName('Loose Card');
    db.prepare(`UPDATE models SET images = '[]', thumbnail_path = NULL, thumb_source = NULL, thumb_attempt = NULL WHERE id = ?`).run(l.id);
    await scanLibrary(LIB);
    const after = byName('Loose Card');
    expect(after.thumb_source).toBe('folder');
    expect(after.thumbnail_path).toMatch(/photo\.jpg$/);
  });
});

describe('fill job (SSE) and mesh renders', () => {
  test('renders cards with meshes, remembers failures, reports progress', async () => {
    const { status, events } = await sse('/api/thumbs/fill?scope=missing&steps=peek,render');
    expect(status).toBe(200);
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done', success: true });
    expect(done.found.stl).toBeGreaterThanOrEqual(2); // Mesh Card, Swap Card
    expect(done.failed).toBeGreaterThanOrEqual(1);    // Empty Card
    expect(events.some(e => e.type === 'progress' && typeof e.total === 'number')).toBe(true);
    expect(events.some(e => e.level && e.msg && e.ts)).toBe(true);

    const m = byName('Mesh Card');
    expect(m.thumb_source).toBe('stl');
    expect(m.thumbnail_path).toBe(`/images/${m.uuid}/stl-preview.png`);
    const png = fs.readFileSync(path.join(IMAGES, m.uuid, 'stl-preview.png'));
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([640, 640]);
    expect(pictures.parseAttempt(byName('Empty Card').thumb_attempt).steps).toContain('r');

    // nothing left to do for 'missing'
    const again = await sse('/api/thumbs/fill?scope=missing&steps=peek,render');
    expect(again.events[again.events.length - 1]).toMatchObject({ type: 'done', success: true, total: 0 });
  }, 60000);

  test('one job at a time: 409 while a fill runs', async () => {
    const first = await fetch(base + '/api/thumbs/fill?scope=all&steps=peek,render');
    expect(first.status).toBe(200);
    const second = await fetch(base + '/api/thumbs/fill?scope=all');
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBeTruthy();
    expect(body.running).toBeTruthy();
    await first.text();
  }, 60000);

  test('GET /api/models/:id/meshes lists loose meshes and zip entries', async () => {
    const m = byName('Mesh Card');
    const res = await request(app).get(`/api/models/${m.id}/meshes`);
    expect(res.status).toBe(200);
    const labels = res.body.files.map(f => f.label);
    expect(labels).toEqual(expect.arrayContaining(['body.stl', 'head.stl', 'supports.stl']));
    expect(res.body.files.find(f => f.label === 'supports.stl').kind).toBe('skip');
    const p = byName('Peek Card');
    const z = (await request(app).get(`/api/models/${p.id}/meshes`)).body.files;
    expect(z.some(f => f.path.endsWith('MH-06-SUP-Levels.zip::MH-06/level_1.stl'))).toBe(true);
  });

  test('POST /api/models/:id/thumbnail/render renders a chosen file (also a zip entry)', async () => {
    const m = byName('Mesh Card');
    const head = path.join(LIB, 'Studio/Mesh Card/head.stl');
    const res = await request(app).post(`/api/models/${m.id}/thumbnail/render`).send({ file: head });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, thumb_source: 'stl', thumbnail_path: `/images/${m.uuid}/stl-preview.png` });
    expect(res.body.thumb_url).toMatch(new RegExp(`^/thumbs/${m.uuid}/stl-preview\\.png\\?w=480&v=`));
    expect(res.body.images[0]).toBe(res.body.thumbnail_path);

    const p = byName('Peek Card');
    const entry = `${path.join(LIB, 'Studio/Peek Card/MH-06-SUP-Levels.zip')}::MH-06/level_1.stl`;
    const z = await request(app).post(`/api/models/${p.id}/thumbnail/render`).send({ file: entry });
    expect(z.status).toBe(200);
    expect(byName('Peek Card').thumb_source).toBe('stl');
  }, 60000);

  test('render: files outside the library or not of this card are refused', async () => {
    const m = byName('Mesh Card');
    expect((await request(app).post(`/api/models/${m.id}/thumbnail/render`).send({ file: '/etc/passwd' })).status).toBe(403);
    const other = path.join(LIB, 'Studio/Loose Card/model.stl');
    expect((await request(app).post(`/api/models/${m.id}/thumbnail/render`).send({ file: other })).status).toBe(400);
    const e = byName('Empty Card');
    expect((await request(app).post(`/api/models/${e.id}/thumbnail/render`).send({})).status).toBe(422);
  }, 60000);
});

describe('user thumbnails and real pictures over renders', () => {
  test('new real pictures replace a mesh render as the thumbnail', async () => {
    const s0 = byName('Swap Card');
    expect(s0.thumb_source).toBe('stl');
    put('Studio/Swap Card/promo.jpg', await fx.noisyImage(sharp, 100, 100, 'jpeg'));
    await scanLibrary(LIB);
    const s = byName('Swap Card');
    expect(s.thumb_source).toBe('folder');
    expect(s.thumbnail_path).toMatch(/promo\.jpg$/);
    expect(imgs(s)[imgs(s).length - 1]).toMatch(/stl-preview\.png$/);
  });

  test('a user-chosen thumbnail is never replaced', async () => {
    const m = byName('Mesh Card');
    const res = await request(app).patch(`/api/models/${m.id}`).send({ thumbnail_path: m.thumbnail_path });
    expect(res.status).toBe(200);
    expect(byName('Mesh Card').thumb_source).toBe('user');
    put('Studio/Mesh Card/cover.jpg', await fx.noisyImage(sharp, 100, 100, 'jpeg'));
    await scanLibrary(LIB);
    const after = byName('Mesh Card');
    expect(after.thumb_source).toBe('user');
    expect(after.thumbnail_path).toBe(m.thumbnail_path);
    expect(imgs(after).some(i => i.endsWith('cover.jpg'))).toBe(true);
    const merged = pictures.mergeImages(after, ['/images/x/new.png'], 'web', { replaceThumb: true });
    expect(merged.thumbnail_path).toBe(m.thumbnail_path);
    expect(merged.thumb_source).toBe('user');
  });
});

describe('list and detail fields', () => {
  test('list items carry thumb_url, thumb_urls (max 4, thumbnail first) and thumb_source', async () => {
    const res = await request(app).get('/api/models?limit=100');
    const p = res.body.models.find(x => x.name === 'Loose Card');
    expect(p.thumb_url).toMatch(new RegExp(`^/thumbs/${p.uuid}/photo\\.jpg\\?w=480&v=[0-9a-f]+$`));
    expect(p.thumb_urls[0]).toBe(p.thumb_url);
    expect(p.thumb_urls.length).toBeLessThanOrEqual(4);
    expect(p.thumb_source).toBe('folder');
    expect(p.thumb_attempt).toBeUndefined();
    const e = res.body.models.find(x => x.name === 'Empty Card');
    expect(e.thumb_url).toBeNull();
    expect(e.thumb_urls).toEqual([]);
    expect(e.thumb_source).toBeNull();
  });

  test('detail has thumb_urls aligned with images at w=1280', async () => {
    const m = byName('Swap Card');
    const res = await request(app).get(`/api/models/${m.id}`);
    expect(res.body.thumb_urls).toHaveLength(res.body.images.length);
    res.body.images.forEach((im, i) => expect(res.body.thumb_urls[i]).toBe(`${im.replace(/^\/images\//, '/thumbs/')}?w=1280&v=${res.body.thumb_urls[i].split('v=')[1]}`));
    expect(res.body.thumb_source).toBe('folder');
  });
});

describe('/thumbs', () => {
  test('generates a WebP once, caches it, and sends immutable headers', async () => {
    const p = byName('Peek Card');
    const url = (await request(app).get(`/api/models/${p.id}`)).body.thumb_urls.find(u => u.includes('hero_front.png')).replace('w=1280', 'w=480');
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const cached = path.join(IMAGES, '.thumbs', p.uuid, 'hero_front.png.480.webp');
    expect(fs.existsSync(cached)).toBe(true);
    const meta = await sharp(cached).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(300); // never upscaled (source is 300 wide)
    const mtime = fs.statSync(cached).mtimeMs;
    await request(app).get(url);
    expect(fs.statSync(cached).mtimeMs).toBe(mtime);
    const big = await request(app).get(url.replace('w=480', 'w=1280'));
    expect(big.status).toBe(200);
    expect(fs.existsSync(path.join(IMAGES, '.thumbs', p.uuid, 'hero_front.png.1280.webp'))).toBe(true);
  });

  test('without sharp the original is served (and the URL version says so)', async () => {
    const l = byName('Loose Card');
    process.env.THUMBS_NO_SHARP = '1';
    try {
      const item = (await request(app).get('/api/models?limit=100')).body.models.find(x => x.id === l.id);
      expect(item.thumb_url).toMatch(/v=[0-9a-f]+n$/);
      const res = await request(app).get(item.thumb_url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg/);
      expect(res.headers['x-thumb-fallback']).toBe('1');
      expect(res.headers['cache-control']).toContain('immutable');
    } finally { delete process.env.THUMBS_NO_SHARP; }
  });

  test('an image sharp cannot read falls back to the original', async () => {
    fs.mkdirSync(path.join(IMAGES, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(IMAGES, 'broken', 'bad.png'), 'not really a png');
    const res = await request(app).get('/thumbs/broken/bad.png?w=480&v=1');
    expect(res.status).toBe(200);
    expect(res.headers['x-thumb-fallback']).toBe('1');
  });

  test('paths stay inside IMAGES_DIR', async () => {
    fs.writeFileSync(path.join(ROOT, 'secret.png'), 'secret');
    fs.symlinkSync(path.join(ROOT, 'secret.png'), path.join(IMAGES, 'link.png'));
    for (const u of ['/thumbs/..%2F..%2Fsecret.png', '/thumbs/%2e%2e/%2e%2e/secret.png', '/thumbs/link.png', '/thumbs/.thumbs/x.png', '/thumbs/a%00b.png']) {
      const res = await request(app).get(u);
      expect([400, 403, 404]).toContain(res.status);
      expect(res.text || '').not.toContain('secret');
    }
    expect((await request(app).get('/images/.thumbs/x')).status).toBe(404);
  });

  test('/images is cached for a week with an ETag', async () => {
    const l = byName('Loose Card');
    const res = await request(app).get(l.thumbnail_path);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=604800');
    expect(res.headers.etag).toBeTruthy();
  });

  test('status and rebuild', async () => {
    const st = (await request(app).get('/api/thumbs/status')).body;
    expect(st.sharp).toBe(true);
    expect(st.cached).toBeGreaterThanOrEqual(1);
    expect(st.bytes).toBeGreaterThan(0);
    expect(st.cards.withPicture).toBeGreaterThanOrEqual(5);
    expect(st.cards.rendered).toBeGreaterThanOrEqual(1);
    expect(st.cards.missing).toBeGreaterThanOrEqual(1);
    expect(st.cached + st.missing).toBeGreaterThan(0);
    const rb = (await request(app).post('/api/thumbs/rebuild')).body;
    expect(rb.ok).toBe(true);
    expect(rb.queued).toBe(st.cached + st.missing);
    for (let i = 0; i < 100; i++) {
      const s = (await request(app).get('/api/thumbs/status')).body;
      if (s.generating === 0) { expect(s.missing).toBe(0); return; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('rebuild did not finish');
  }, 30000);
});

describe('migration 8 backfill', () => {
  test('existing pictures get a best-guess thumb_source', () => {
    const file = path.join(ROOT, 'v7.db');
    const saved = process.env.DB_PATH;
    process.env.DB_PATH = file;
    try {
      // a current database taken back to version 7 (columns of migration 8 dropped), with pictures
      jest.isolateModules(() => {
        const d = require('../db');
        d.exec(`
          ALTER TABLE models DROP COLUMN thumb_source;
          ALTER TABLE models DROP COLUMN thumb_attempt;
          INSERT INTO models (uuid, name, folder_path, thumbnail_path, images) VALUES
            ('u1', 'Web', '/l/a', '/images/u1/scraped_1.jpg', '["/images/u1/scraped_1.jpg"]'),
            ('u2', 'Loose', '/l/b', '/images/u2/My_photo.jpg', '["/images/u2/My_photo.jpg"]'),
            ('u3', 'Zip', '/l/c', '/images/u3/render.png', '["/images/u3/render.png"]'),
            ('u4', 'None', '/l/d', NULL, '[]');
          INSERT INTO model_files (model_id, filename, filepath, filetype) VALUES (2, 'My photo.jpg', '/l/b/My photo.jpg', 'image');
          PRAGMA user_version = 7;
        `);
        d.close();
      });
    } catch (e) { process.env.DB_PATH = saved; throw e; }
    try {
      jest.isolateModules(() => {
        const db2 = require('../db');
        const src = Object.fromEntries(db2.prepare('SELECT name, thumb_source FROM models').all().map(r => [r.name, r.thumb_source]));
        expect(src).toEqual({ Web: 'web', Loose: 'folder', Zip: 'archive', None: null });
        expect(db2.prepare('PRAGMA user_version').get().user_version).toBe(db2.SCHEMA_VERSION);
        db2.close();
      });
    } finally { process.env.DB_PATH = saved; }
  });
});
