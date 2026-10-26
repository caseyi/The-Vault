/**
 * lib/mesh-render.js + mesh selection in lib/pictures.js (docs/thumbnails.md §2.4):
 * STL (binary, ASCII), OBJ and 3MF parsing, a non-blank centred render, multi-part folders,
 * zip entries, and the render time of a 1M-triangle mesh.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const fx = require('./mesh-fixtures');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mesh-')));
process.env.IMAGES_DIR = path.join(ROOT, 'images');
const mr = require('../lib/mesh-render');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const file = (name, data) => { const p = path.join(ROOT, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
async function collect(src) {
  const tris = [];
  const n = await mr.forEachTriangle(src, (...v) => tris.push(v));
  return { n, tris };
}
/** Model pixels: the clay is warm (R >= B); the background is a cool grey (B = R + 3). */
function analyse(png) {
  const { width, height, data } = mr.decodePng(png);
  let n = 0, sx = 0, sy = 0, minx = width, maxx = 0, miny = height, maxy = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 3;
    if (data[o] >= data[o + 2]) { n++; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  return { width, height, n, cx: sx / n, cy: sy / n, minx, maxx, miny, maxy, share: n / (width * height) };
}

describe('parsers', () => {
  const cube = fx.boxTris(0, 0, 0, 10, 20, 30);

  test('binary STL', async () => {
    const { n, tris } = await collect({ kind: 'file', path: file('cube-bin.stl', fx.binaryStl(cube)) });
    expect(n).toBe(12);
    expect(tris[0].map(v => Math.round(v))).toEqual(cube[0]);
  });

  test('binary STL whose header starts with "solid" is still binary (size matches)', async () => {
    const buf = fx.binaryStl(cube);
    buf.write('solid SolidWorks export', 0, 'latin1');
    expect((await collect({ kind: 'file', path: file('cube-solid-header.stl', buf) })).n).toBe(12);
  });

  test('ASCII STL', async () => {
    const { n, tris } = await collect({ kind: 'file', path: file('cube-ascii.stl', fx.asciiStl(cube)) });
    expect(n).toBe(12);
    expect(tris[5]).toEqual(cube[5]);
  });

  test('OBJ (v/vt/vn face syntax, fans quads)', async () => {
    const { n } = await collect({ kind: 'file', path: file('cube.obj', fx.obj(cube)) });
    expect(n).toBe(12);
    const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf -4 -3 -2\n';
    expect((await collect({ kind: 'file', path: file('quad.obj', quad) })).n).toBe(3);
  });

  test('3MF applies the build item transform', async () => {
    const { n, tris } = await collect({ kind: 'file', path: file('cube.3mf', fx.threeMf(cube, AdmZip, { translate: [100, 0, 0] })) });
    expect(n).toBe(12);
    expect(Math.min(...tris.flatMap(t => [t[0], t[3], t[6]]))).toBeCloseTo(100);
  });

  test('STL streamed from a zip entry, and a 3MF inside a zip', async () => {
    const z = new AdmZip();
    z.addFile('Parts/cube.stl', fx.binaryStl(cube));
    z.addFile('Parts/cube.3mf', fx.threeMf(cube, AdmZip));
    const zp = file('parts.zip', z.toBuffer());
    expect((await collect({ kind: 'zip', zipPath: zp, entry: 'Parts/cube.stl' })).n).toBe(12);
    expect((await collect({ kind: 'zip', zipPath: zp, entry: 'Parts/cube.3mf' })).n).toBe(12);
  });

  test('an empty STL renders nothing (error, not a blank picture)', async () => {
    await expect(mr.renderMeshes([{ kind: 'file', path: file('empty.stl', 'solid x\nendsolid x\n') }])).rejects.toThrow(/no triangles/);
  });
});

describe('render', () => {
  test('produces a non-blank 640x640 PNG with the model centred', async () => {
    const p = file('torus.stl', fx.binaryStl(fx.torusTris(80, 40)));
    const r = await mr.renderMeshes([{ kind: 'file', path: p }]);
    expect(r.png.slice(1, 4).toString()).toBe('PNG');
    const a = analyse(r.png);
    expect(a.width).toBe(640);
    expect(a.share).toBeGreaterThan(0.15);
    expect(a.share).toBeLessThan(0.9);
    expect(Math.abs(a.cx - 320)).toBeLessThan(40);
    expect(Math.abs(a.cy - 320)).toBeLessThan(40);
    // auto-framing: the model fills most of the frame but keeps a margin
    expect(Math.max(a.maxx - a.minx, a.maxy - a.miny)).toBeGreaterThan(480);
    expect(a.minx).toBeGreaterThan(10);
    expect(a.miny).toBeGreaterThan(10);
    // shading varies across the model (not a flat silhouette)
    const { data } = mr.decodePng(r.png);
    const lum = new Set();
    for (let i = 0; i < data.length; i += 3) if (data[i] >= data[i + 2]) lum.add(data[i] >> 3);
    expect(lum.size).toBeGreaterThan(10);
  });

  test('a model far from the origin is still framed and centred', async () => {
    const tris = fx.boxTris(1000, 2000, 50, 1040, 2030, 110);
    const a = analyse((await mr.renderMeshes([{ kind: 'file', path: file('far.stl', fx.binaryStl(tris)) }])).png);
    expect(Math.abs(a.cx - 320)).toBeLessThan(40);
    expect(a.share).toBeGreaterThan(0.1);
  });

  test('meshes over the in-memory cap are streamed twice and give the same picture', async () => {
    const p = file('torus2.stl', fx.binaryStl(fx.torusTris(300, 150)));
    const a = await mr.renderMeshes([{ kind: 'file', path: p }]);
    const b = await mr.renderMeshes([{ kind: 'file', path: p }], { memTriangles: 1000 });
    expect(b.triangles).toBe(a.triangles);
    expect(Buffer.compare(a.png, b.png)).toBe(0);
  });

  test('up axis: the flat bottom of a round base points down, whichever axis it is on', async () => {
    const orient = [
      ['-z', (p) => p],
      ['-y', ([x, y, z]) => [x, z, -y]],     // Y-up export
      ['-x', ([x, y, z]) => [z, y, -x]],     // base facing -X
      ['+x', ([x, y, z]) => [-z, y, x]],     // base facing +X
      ['+z', ([x, y, z]) => [x, -y, -z]],    // upside down
    ];
    for (const [want, map] of orient) {
      const r = await mr.renderMeshes([{ kind: 'file', path: file(`mini${want}.stl`, fx.binaryStl(fx.miniTris(map))) }]);
      expect(r.down).toBe(want);
      // stood up: the figure is taller than the base is wide, and the base is at the bottom
      const a = analyse(r.png);
      expect(a.maxy - a.miny).toBeGreaterThan((a.maxx - a.minx) * 1.1);
    }
  });

  test('up axis: no flat face (or a tie with -Z) keeps Z up', async () => {
    expect((await mr.renderMeshes([{ kind: 'file', path: file('round.stl', fx.binaryStl(fx.torusTris(40, 20))) }])).down).toBe('-z');
    expect((await mr.renderMeshes([{ kind: 'file', path: file('rod.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 10, 80, 10))) }])).down).toBe('-z');
    expect((await mr.renderMeshes([{ kind: 'file', path: file('plate.stl', fx.binaryStl(fx.boxTris(0, 0, 0, 80, 80, 5))) }])).upAxis).toBe('z');
  });

  test('up axis: multi-part renders use the largest part for all parts', async () => {
    const yup = ([x, y, z]) => [x, z, -y];
    const body = file('kitY/body.stl', fx.binaryStl(fx.miniTris(yup)));
    // a small part attached to the figure (so the parts are one assembly)
    const arm = file('kitY/arm.stl', fx.binaryStl(fx.boxTris(10, 10, -3, 11, 16, 3)));
    const r = await mr.renderMeshes([{ kind: 'file', path: arm }, { kind: 'file', path: body }]);
    expect(r.down).toBe('-y');
  });

  test('assembly: a statue split at the waist and parts sharing coordinates render together', async () => {
    const legs = file('statue/legs.stl', fx.binaryStl(fx.boxTris(-10, -6, 0, 10, 6, 40)));
    const torso = file('statue/torso.stl', fx.asciiStl(fx.boxTris(-12, -7, 40, 12, 7, 75)));
    const head = file('statue/head.stl', fx.binaryStl(fx.boxTris(-5, -5, 75, 5, 5, 88)));
    const arm = file('statue/arm_left.stl', fx.binaryStl(fx.boxTris(-20, -3, 45, -12, 3, 72))); // touches the torso
    const r = await mr.renderMeshes([legs, torso, head, arm].map(p => ({ kind: 'file', path: p })));
    expect(r.assembly).toBe(true);
    expect(r.parts).toEqual([0, 1, 2, 3]);
    const a = analyse(r.png);
    expect(a.maxy - a.miny).toBeGreaterThan(450); // the whole statue fills the frame height
    // Wicked: parts exported in place, overlapping boxes
    const body = file('wicked/body.stl', fx.binaryStl(fx.miniTris()));
    const cape = file('wicked/cape.stl', fx.binaryStl(fx.boxTris(-6, 3, 8, 6, 5, 30)));
    expect((await mr.renderMeshes([{ kind: 'file', path: body }, { kind: 'file', path: cape }])).assembly).toBe(true);
  });

  test('not an assembly: parts laid out apart render only the largest part (Flind, Eyepatch)', async () => {
    // Eyepatch: a figure and its base far apart → each would be tiny in the frame
    const fig = file('eyepatch/eyepatch_32mm.stl', fx.binaryStl(fx.miniTris()));
    const base = file('eyepatch/eyepatch_base.stl', fx.binaryStl(fx.boxTris(300, 300, 0, 330, 330, 4)));
    const r = await mr.renderMeshes([{ kind: 'file', path: base }, { kind: 'file', path: fig }]);
    expect(r.assembly).toBe(false);
    expect(r.parts).toEqual([1]);
    const a = analyse(r.png);
    expect(a.maxy - a.miny).toBeGreaterThan(450); // the figure alone fills the frame
    // Flind: body, arms, head and a base disc side by side on the plate (Y-up export)
    const yup = ([x, y, z]) => [x, z, -y];
    const parts = [
      ['flind/body.stl', fx.miniTris(yup)],
      ['flind/arm_l.stl', fx.boxTris(40, 0, -3, 46, 20, 3)],
      ['flind/arm_r.stl', fx.boxTris(60, 0, -3, 66, 20, 3)],
      ['flind/head.stl', fx.boxTris(80, 0, -4, 88, 9, 4)],
    ].map(([n, t]) => ({ kind: 'file', path: file(n, fx.binaryStl(t)) }));
    const f = await mr.renderMeshes(parts);
    expect(f.assembly).toBe(false);
    expect(f.parts).toEqual([0]);
    expect(f.down).toBe('-y'); // its own up axis
  });

  test('assemblyCheck ignores base-like names when picking the largest part', () => {
    const box = (x0, x1) => [x0, 0, 0, x1, 10, 10];
    const r = mr.assemblyCheck([{ kind: 'file', path: '/a/round_base.stl' }, { kind: 'file', path: '/a/hero.stl' }], [box(0, 100), box(500, 510)], [9000, 500]);
    expect(r).toEqual({ assembly: false, main: 1 });
  });

  test('1M triangles render in bounded time (reported)', async () => {
    const p = path.join(ROOT, 'big.stl');
    const n = fx.writeTorusStl(fs, p, 1000, 500);
    expect(n).toBe(1000000);
    const t = Date.now();
    const r = await mr.renderMeshes([{ kind: 'file', path: p }]);
    const ms = Date.now() - t;
    // eslint-disable-next-line no-console
    console.log(`[mesh-render] 1,000,000 triangles: ${ms} ms (read ${r.ms.read}, raster ${r.ms.raster}, shade ${r.ms.shade}, encode ${r.ms.encode}), coverage ${(r.coverage * 100).toFixed(1)}%`);
    expect(r.triangles).toBe(1000000);
    expect(ms).toBeLessThan(30000);
    fs.unlinkSync(p);
  }, 60000);
});

describe('which mesh to render (lib/pictures.js)', () => {
  const pictures = require('../lib/pictures');
  const c = (p, size) => ({ id: p, name: path.basename(p), dir: path.dirname(p), size, source: { kind: 'file', path: p } });

  test('support, test and base-only files are skipped', () => {
    expect(pictures.meshKind('supports.stl')).toBe('skip');
    expect(pictures.meshKind('bust_supports.stl')).toBe('skip');
    expect(pictures.meshKind('tolerance test.stl')).toBe('skip');
    expect(pictures.meshKind('Base.stl')).toBe('skip');
    expect(pictures.meshKind('base_2.obj')).toBe('skip');
    expect(pictures.meshKind('bust_supported.stl')).toBe('mesh');
    expect(pictures.meshKind('baseball bat.stl')).toBe('mesh');
  });

  test('parts of one folder render together; unsupported folders win', () => {
    const pick = pictures.chooseMeshes([
      c('/l/M/Supported/body_sup.stl', 9e6), c('/l/M/Supported/head_sup.stl', 3e6),
      c('/l/M/Unsupported/body.stl', 8e6), c('/l/M/Unsupported/head.stl', 2e6), c('/l/M/Unsupported/supports.stl', 5e6),
    ]);
    expect(pick.mode).toBe('parts');
    expect(pick.parts.map(p => p.name).sort()).toEqual(['body.stl', 'head.stl']);
  });

  test('too many triangles for a group: the largest single mesh', () => {
    const pick = pictures.chooseMeshes([c('/l/M/a.stl', 150e6), c('/l/M/b.stl', 140e6)]);
    expect(pick.mode).toBe('single');
    expect(pick.parts[0].name).toBe('a.stl');
  });
});
