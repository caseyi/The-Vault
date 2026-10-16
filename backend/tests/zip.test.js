/**
 * lib/zip.js — yauzl streaming listing/extraction (replaces whole-file adm-zip reads).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const zipLib = require('../lib/zip');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-zip-'));
// a real 1×1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const ZIP = path.join(ROOT, 'Wicked - Krampus Portrait Bust (Images).zip');

beforeAll(() => {
  const z = new AdmZip();
  z.addFile('Krampus/01 front.png', PNG);
  z.addFile('Krampus/render_main.png', PNG);
  z.addFile('Krampus/back.jpg', Buffer.from('JPEGDATA'));
  z.addFile('../../evil.png', PNG);
  z.addFile('Krampus/Krampus_Head.stl', Buffer.from('solid x\nendsolid x\n'));
  z.addFile('Krampus/notes.txt', Buffer.from('hello'));
  z.writeZip(ZIP);
  fs.writeFileSync(path.join(ROOT, 'broken.zip'), Buffer.alloc(4096)); // all zeros, like the rebuilt library
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => { delete process.env.ZIP_MAX_MB; delete process.env.ARCHIVE_MAX_MB; });

test('listZip reads the central directory (names + sizes)', async () => {
  const list = await zipLib.listZip(ZIP);
  expect(list.map(e => e.name).filter(n => !/evil/.test(n)).sort()).toEqual(['Krampus/01 front.png', 'Krampus/Krampus_Head.stl', 'Krampus/back.jpg', 'Krampus/notes.txt', 'Krampus/render_main.png']);
  expect(list.some(e => /evil\.png$/.test(e.name))).toBe(true);
  expect(list.find(e => e.name === 'Krampus/01 front.png').size).toBe(PNG.length);
});

test('extractZipImages: images only, flattened + sanitised, never outside the target', async () => {
  const dest = path.join(ROOT, 'out1');
  const saved = await zipLib.extractZipImages(ZIP, dest);
  expect(saved.sort()).toEqual(['01_front.png', 'back.jpg', 'evil.png', 'render_main.png']);
  expect(fs.readdirSync(dest).sort()).toEqual(['01_front.png', 'back.jpg', 'evil.png', 'render_main.png']);
  expect(fs.readFileSync(path.join(dest, '01_front.png')).equals(PNG)).toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'evil.png'))).toBe(false);
});

test('select and limit (best-ranked first)', async () => {
  const one = await zipLib.extractZipImages(ZIP, path.join(ROOT, 'out2'), { select: ['Krampus/back.jpg'] });
  expect(one).toEqual(['back.jpg']);
  const rank = (names) => [...names].sort((a, b) => (/render_main/.test(b) ? 1 : 0) - (/render_main/.test(a) ? 1 : 0));
  const top = await zipLib.extractZipImages(ZIP, path.join(ROOT, 'out3'), { limit: 1, rank });
  expect(top).toEqual(['render_main.png']);
});

test('a zero-filled "zip" fails cleanly', async () => {
  await expect(zipLib.listZip(path.join(ROOT, 'broken.zip'))).rejects.toThrow(/central directory/i);
});

test('size cap: ZIP_MAX_MB, else an explicit ARCHIVE_MAX_MB, else none', () => {
  expect(zipLib.zipTooBig(ZIP)).toBe(false);
  process.env.ARCHIVE_MAX_MB = '0.0001';
  expect(zipLib.zipTooBig(ZIP)).toBe(true);
  process.env.ZIP_MAX_MB = '10';
  expect(zipLib.zipTooBig(ZIP)).toBe(false);
  process.env.ZIP_MAX_MB = '0'; // 0 = no limit, even with ARCHIVE_MAX_MB set (compose default)
  expect(zipLib.zipTooBig(ZIP)).toBe(false);
});

test('scanner.extractImagesFromArchive uses the streaming reader (with a limit)', async () => {
  process.env.IMAGES_DIR = path.join(ROOT, 'images');
  jest.resetModules();
  jest.doMock('../db', () => {
    const stmt = { run: () => ({}), get: () => null, all: () => [] };
    return { prepare: () => stmt, exec: () => {}, transaction: (fn) => fn };
  });
  const { extractImagesFromArchive } = require('../scanner');
  const urls = await extractImagesFromArchive(ZIP, 'uuid-z', { limit: 2 });
  // ranked by the thumbnail scorer: "01 front" / "render_main" beat "back" and "evil"
  expect(urls.sort()).toEqual(['/images/uuid-z/01_front.png', '/images/uuid-z/render_main.png']);
});
