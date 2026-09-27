/**
 * B10: render extraction from archives — images only, size caps, RAR works
 * (node-unrar-js v2 is async; it silently extracted nothing before).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-arc-'));
process.env.DB_PATH = path.join(ROOT, 'vault.db');
process.env.IMAGES_DIR = path.join(ROOT, 'images');
process.env.LIBRARY_PATH = path.join(ROOT, 'lib');
fs.mkdirSync(process.env.LIBRARY_PATH, { recursive: true });

const AdmZip = require('adm-zip');
const { extractImagesFromArchive } = require('../scanner');

/** Minimal RAR 4.x writer (stored / uncompressed entries) for test fixtures. */
function makeRar(entries) {
  const hdr = (body) => { const crc = Buffer.alloc(2); crc.writeUInt16LE(zlib.crc32(body) & 0xffff); return Buffer.concat([crc, body]); };
  const main = Buffer.alloc(11); main.writeUInt8(0x73, 0); main.writeUInt16LE(0, 1); main.writeUInt16LE(13, 3);
  const parts = [Buffer.from('Rar!\x1a\x07\x00', 'binary'), hdr(main)];
  for (const [name, data] of entries) {
    const nb = Buffer.from(name);
    const b = Buffer.alloc(30 + nb.length);
    let o = 0;
    b.writeUInt8(0x74, o); o += 1;
    b.writeUInt16LE(0x8000, o); o += 2;
    b.writeUInt16LE(32 + nb.length, o); o += 2;
    b.writeUInt32LE(data.length, o); o += 4;
    b.writeUInt32LE(data.length, o); o += 4;
    b.writeUInt8(2, o); o += 1;
    b.writeUInt32LE(zlib.crc32(data) >>> 0, o); o += 4;
    b.writeUInt32LE(0x5a210000, o); o += 4;
    b.writeUInt8(29, o); o += 1;
    b.writeUInt8(0x30, o); o += 1;
    b.writeUInt16LE(nb.length, o); o += 2;
    b.writeUInt32LE(0x20, o); o += 4;
    nb.copy(b, o);
    parts.push(hdr(b), data);
  }
  const end = Buffer.alloc(5); end.writeUInt8(0x7b, 0); end.writeUInt16LE(0x4000, 1); end.writeUInt16LE(7, 3);
  parts.push(hdr(end));
  return Buffer.concat(parts);
}

afterAll(() => {
  try { require('../db').close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => { delete process.env.ARCHIVE_MAX_MB; });

test('zip: only image entries are extracted (flattened + sanitised names)', async () => {
  const z = new AdmZip();
  z.addFile('Renders/front view.png', Buffer.from('PNG'));
  z.addFile('../../evil.jpg', Buffer.from('JPG'));
  z.addFile('model.stl', Buffer.from('solid x'));
  const zp = path.join(ROOT, 'lib', 'renders.zip');
  z.writeZip(zp);
  const out = await extractImagesFromArchive(zp, 'uuid-zip');
  expect(out.sort()).toEqual(['/images/uuid-zip/evil.jpg', '/images/uuid-zip/front_view.png']);
  const dir = path.join(ROOT, 'images', 'uuid-zip');
  expect(fs.readdirSync(dir).sort()).toEqual(['evil.jpg', 'front_view.png']);
  expect(fs.existsSync(path.join(ROOT, 'evil.jpg'))).toBe(false);
});

test('rar: images are extracted, STLs are skipped', async () => {
  const rp = path.join(ROOT, 'lib', 'renders.rar');
  fs.writeFileSync(rp, makeRar([
    ['renders/front.png', Buffer.from('PNGDATA')],
    ['model.stl', Buffer.from('solid x\nendsolid x\n')],
    ['back.jpg', Buffer.from('JPEGDATA')],
  ]));
  const out = await extractImagesFromArchive(rp, 'uuid-rar');
  expect(out.sort()).toEqual(['/images/uuid-rar/back.jpg', '/images/uuid-rar/front.png']);
  expect(fs.readFileSync(path.join(ROOT, 'images', 'uuid-rar', 'front.png'), 'utf8')).toBe('PNGDATA');
  expect(fs.existsSync(path.join(ROOT, 'images', 'uuid-rar', 'model.stl'))).toBe(false);
});

test('archives over ARCHIVE_MAX_MB are skipped', async () => {
  const z = new AdmZip();
  z.addFile('r.png', require('crypto').randomBytes(64 * 1024)); // incompressible
  const zp = path.join(ROOT, 'lib', 'big.zip');
  z.writeZip(zp);
  process.env.ARCHIVE_MAX_MB = '0.01';
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await extractImagesFromArchive(zp, 'uuid-big')).toEqual([]);
  warn.mockRestore();
  delete process.env.ARCHIVE_MAX_MB;
  expect(await extractImagesFromArchive(zp, 'uuid-big')).toEqual(['/images/uuid-big/r.png']);
});
