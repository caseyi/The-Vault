/**
 * lib/pictures.js on real archives built in the test: Drive-export zips that wrap the original zips
 * (nested peek and nested meshes), RAR read from disk (no ARCHIVE_MAX_MB), unsupported geometry
 * preferred over presupported, and temp files cleaned up.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pics-')));
const LIB = path.join(ROOT, 'lib');
const IMAGES = path.join(ROOT, 'images');
process.env.DB_PATH = path.join(ROOT, 'vault.db');
process.env.IMAGES_DIR = IMAGES;
process.env.LIBRARY_PATH = LIB;

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const fx = require('./mesh-fixtures');
const pictures = require('../lib/pictures');
const mr = require('../lib/mesh-render');

jest.spyOn(console, 'warn').mockImplementation(() => {});
afterAll(() => { try { require('../db').close(); } catch {} fs.rmSync(ROOT, { recursive: true, force: true }); });

const put = (rel, data) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const fileRow = (p) => ({ filepath: p, filename: path.basename(p), filesize: fs.statSync(p).size });
const tmpLeft = () => { try { return fs.readdirSync(path.join(IMAGES, '.tmp')); } catch { return []; } };
const zipOf = (entries) => { const z = new AdmZip(); for (const [n, d] of entries) z.addFile(n, d); return z.toBuffer(); };

describe('nested zips (Google Drive exports)', () => {
  let outer;
  beforeAll(async () => {
    const images = zipOf([['Malenia front.png', await fx.noisyImage(sharp, 260, 200)], ['Malenia back.jpg', await fx.noisyImage(sharp, 200, 200, 'jpeg')]]);
    const presup = zipOf([['Malenia presup/body_sup.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 10, 30))]]);
    const unsup = zipOf([['Malenia/body.stl', fx.binaryStl(fx.miniTris())]]);
    outer = put('Malenia/Malenia - CA3D-20250109T005855Z-001.zip', zipOf([
      ['Malenia - CA3D/Malenia Images - CA3D.zip', images],
      ['Malenia - CA3D/Malenia pre supports - CA3D.zip', presup],
      ['Malenia - CA3D/Malenia Without cuts - CA3D.zip', unsup],
      ['Malenia - CA3D/readme.txt', Buffer.from('hi')],
    ]));
  });

  test('peek opens the render-named inner zip and extracts its images; temp files are removed', async () => {
    const res = await pictures.findPictures({ files: [fileRow(outer)], uuid: 'u-nested', steps: 'afp' });
    expect(res.source).toBe('archive-peek');
    expect(res.images.map(i => i.split('/').pop()).sort()).toEqual(['Malenia_back.jpg', 'Malenia_front.png']);
    expect(fs.existsSync(path.join(IMAGES, 'u-nested', 'Malenia_front.png'))).toBe(true);
    expect(tmpLeft()).toEqual([]);
  });

  test('inner zips over the size cap (64 MB uncompressed) are not opened', async () => {
    process.env.INNER_ZIP_MAX_MB = '0.001';
    try {
      const res = await pictures.findPictures({ files: [fileRow(outer)], uuid: 'u-nested-big', steps: 'p' });
      expect(res.images).toEqual([]);
    } finally { delete process.env.INNER_ZIP_MAX_MB; }
  });

  test('meshes inside inner zips are rendered when nothing else is, unsupported first', async () => {
    const r = await pictures.renderPreview([fileRow(outer)], 'u-nested-mesh');
    expect(r).toBeTruthy();
    expect(r.parts[0]).toContain('Without cuts - CA3D.zip::Malenia/body.stl');
    expect(fs.existsSync(path.join(IMAGES, 'u-nested-mesh', 'stl-preview.png'))).toBe(true);
    expect(tmpLeft()).toEqual([]);
  });

  test('a nested entry can be rendered explicitly', async () => {
    const id = `${outer}::Malenia - CA3D/Malenia pre supports - CA3D.zip::Malenia presup/body_sup.stl`;
    const r = await pictures.renderPreview([fileRow(outer)], 'u-nested-pick', { file: id });
    expect(r.parts).toEqual([id]);
    expect(tmpLeft()).toEqual([]);
  });
});

describe('RAR read from disk', () => {
  let rar;
  beforeAll(async () => {
    rar = put('Mulan/Mulan.rar', fx.makeRar([
      ['Mulan/Renders/mulan_hero.png', await fx.noisyImage(sharp, 220, 220)],
      ['Mulan/Renders/tiny_icon.png', await fx.noisyImage(sharp, 30, 30)],
      ['Mulan/STL/mulan.stl', fx.binaryStl(fx.miniTris())],
    ]));
  });

  test('peek lists and extracts the chosen images even over ARCHIVE_MAX_MB', async () => {
    process.env.ARCHIVE_MAX_MB = '0.001';
    try {
      const res = await pictures.findPictures({ files: [fileRow(rar)], uuid: 'u-rar', steps: 'p' });
      expect(res.source).toBe('archive-peek');
      expect(res.images).toEqual(['/images/u-rar/mulan_hero.png']);
      expect(fs.readdirSync(path.join(IMAGES, 'u-rar'))).toEqual(['mulan_hero.png']);
    } finally { delete process.env.ARCHIVE_MAX_MB; }
    expect(tmpLeft()).toEqual([]);
  });

  test('a RAR mesh entry is rendered through a temp file', async () => {
    const { inZip } = await pictures.meshCandidates([fileRow(rar)]);
    expect(inZip.map(c => c.id)).toEqual([`${rar}::Mulan/STL/mulan.stl`]);
    const r = await pictures.renderPreview([fileRow(rar)], 'u-rar-mesh');
    expect(r.parts).toEqual([`${rar}::Mulan/STL/mulan.stl`]);
    expect(r.upAxis).toBe('z');
    expect(tmpLeft()).toEqual([]);
  });

  test('render archives by name (scanner) use the disk extractor too', async () => {
    const r2 = put('Mulan/Mulan Renders.rar', fx.makeRar([['a/render.png', Buffer.from('PNGDATA')], ['m.stl', Buffer.from('solid')]]));
    process.env.ARCHIVE_MAX_MB = '0.000001';
    try {
      const out = await require('../scanner').extractImagesFromArchive(r2, 'u-rar-named');
      expect(out).toEqual(['/images/u-rar-named/render.png']);
    } finally { delete process.env.ARCHIVE_MAX_MB; }
  });
});

describe('unsupported geometry is preferred', () => {
  const c = (id, size, packed = false) => {
    const segs = id.split('::');
    const inner = segs[segs.length - 1];
    return { id, name: path.basename(inner), dir: segs.length > 1 ? `${segs.slice(0, -1).join('::')}::${path.posix.dirname(inner)}` : path.dirname(id), size, packed };
  };

  test('Loot-style folders: _UnSupported beats _Supported_Solid, whatever the sizes', () => {
    const base = '/l/Loot/All_32mm/ShipsCrew_32mm';
    const pick = pictures.chooseMeshes([
      c(`${base}/ShipsCrew_32mm_Supported_Solid/DrownedMate_32mm_Supported_Solid/DrownedMate_32mm_Supported.stl`, 40e6),
      c(`${base}/ShipsCrew_32mm_Supported_Solid/DrownedMate_32mm_Supported_Solid/DrownedMate_32mm_Base_Supported.stl`, 10e6),
      c(`${base}/ShipsCrew_32mm_UnSupported/DrownedMate_32mm_UnSupported/DrownedMate_32mm.stl`, 9e6),
      c(`${base}/ShipsCrew_32mm_UnSupported/DrownedMate_32mm_UnSupported/DrownedMate_32mm_Base.stl`, 2e6),
    ]);
    expect(pick.presupported).toBe(false);
    expect(pick.parts.every(p => p.id.includes('_UnSupported/'))).toBe(true);
  });

  test('Wicked-style zips: "(Stl Pre Supported)" loses to a plain Stl zip; loose files win ties', () => {
    const d = '/l/Wicked/DC/The Drowned';
    const pick = pictures.chooseMeshes([
      c(`${d}/B3DSERK - The Drowned Sculpture (Stl Pre Supported)-003.zip::Pre Supported/drowned_full.stl`, 200e6, true),
      c(`${d}/B3DSERK - The Drowned Sculpture-20250318T004015Z-001.zip::Stl/drowned_body.stl`, 60e6, true),
      c(`${d}/B3DSERK - The Drowned Sculpture-20250318T004015Z-001.zip::Stl/drowned_head.stl`, 20e6, true),
    ]);
    expect(pick.presupported).toBe(false);
    expect(pick.parts.map(p => p.name).sort()).toEqual(['drowned_body.stl', 'drowned_head.stl']);
    expect(pictures.supPenalty('Malenia pre supports - CA3D.zip')).toBe(1);
    expect(pictures.supPenalty('Without supports')).toBe(0);
    const tie = pictures.chooseMeshes([c('/l/M/a.zip::x/m.stl', 5e6, true), c('/l/M/m.stl', 5e6)]);
    expect(tie.parts[0].id).toBe('/l/M/m.stl');
  });

  test('only presupported geometry: it is rendered', () => {
    const pick = pictures.chooseMeshes([c('/l/M/Supported/a_sup.stl', 5e6)]);
    expect(pick.parts[0].name).toBe('a_sup.stl');
    expect(pick.presupported).toBe(true);
  });

  test('presupported loose meshes + an unsupported inner zip: the inner zip wins', async () => {
    const loose = put('Drowned/Pre Supported/drowned_sup.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 10, 40)));
    const outer = put('Drowned/The Drowned-20250318T004015Z-001.zip', zipOf([
      ['The Drowned/The Drowned Stl.zip', zipOf([['Stl/drowned.stl', fx.binaryStl(fx.miniTris())]])],
    ]));
    const r = await pictures.renderPreview([fileRow(loose), fileRow(outer)], 'u-drowned');
    expect(r.parts[0]).toContain('The Drowned Stl.zip::Stl/drowned.stl');
    expect(tmpLeft()).toEqual([]);
  });
});

describe('render orientation through the pipeline', () => {
  test('a Y-up mini is stood on its base', async () => {
    const p = put('Flind/flind.stl', fx.binaryStl(fx.miniTris(([x, y, z]) => [x, z, -y])));
    const r = await pictures.renderPreview([fileRow(p)], 'u-flind');
    expect(r.upAxis).toBe('y');
    const png = fs.readFileSync(path.join(IMAGES, 'u-flind', 'stl-preview.png'));
    expect(mr.decodePng(png).width).toBe(640);
  });
});
