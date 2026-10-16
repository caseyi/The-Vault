/**
 * One card per release (Casey: "sometimes there are 2 from different years, e.g. Kingpin and
 * Daredevil, from 2 releases; keep these separate"). A creator + character work splits when two or
 * more releases hold printable files: distinct manifest products, terms, a year or version
 * qualifier in a folder. Sculpture + Bust of one release stay together, dioramas never split, a
 * card that already existed keeps its row for the release holding most of its files, and the
 * rescan afterwards changes nothing. Enrich never proposes merging releases.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-rel-')));
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
process.env.DB_PATH = path.join(DATA, 'vault.db');
process.env.IMAGES_DIR = path.join(DATA, 'images');
process.env.LIBRARY_PATH = LIB;
process.env.BACKUP_DIR = path.join(DATA, 'backups');
process.env.ENRICH_FAKE = '1';
process.env.ENRICH_FAKE_DELAY_MS = '0';
delete process.env.LIBRARY_LABELS;
delete process.env.LAYOUT_MODE;
delete process.env.ALLOWED_ORIGINS;

let seq = 9000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (seq += 37)));
  return full;
}
const M = 'Wicked/Marvel';
// release 1: the Netflix Daredevil (store products without a term)
mk(`${M}/Marvel Netflix Daredevil Bust STLs/Wicked - Daredevil Bust (With Chain).zip`, 4100001);
mk(`${M}/Marvel Netflix Daredevil Sculpture STLs/Wicked - Daredevil Sculpture (Non Supported).zip`, 4100002);
mk(`${M}/Cap Marvel/WICKED - Captain Marvel Sculpture (Non Supported).zip`, 4100003);
mk(`${M}/Cap Marvel/WICKED - Captain Marvel Bust (Non Supported).zip`, 4100004);
// a part-variant "V2" folder inside one sculpt is not a release
mk(`${M}/Ghost Rider/WICKED - Ghost Rider Sculpture (Non Supported)/V1/head.stl`);
mk(`${M}/Ghost Rider/WICKED - Ghost Rider Sculpture (Non Supported)/V2/head.stl`);
mk(`${M}/Daredevil and Kingpin Diorama/WICKED - Daredevil & Kingpin Diorama (One Piece).zip`);
fs.mkdirSync(path.join(LIB, '_Meta'), { recursive: true });
fs.writeFileSync(path.join(LIB, '_Meta', 'gumroad_manifest.json'), JSON.stringify([
  { creator: 'Wicked', product_name: 'Wicked Marvel: Netflix Daredevil Bust', download_url: 'u-ddn-b', files: [{ file_name: 'Wicked - Daredevil Bust (With Chain)', extension: 'zip', file_size: 4100001 }] },
  { creator: 'Wicked', product_name: 'Wicked Marvel: Netflix Daredevil Sculpture', download_url: 'u-ddn-s', files: [{ file_name: 'Wicked - Daredevil Sculpture (Non Supported)', extension: 'zip', file_size: 4100002 }] },
  { creator: 'Wicked', product_name: 'Wicked Marvel March 2026 Term Daredevil Portrait Bust', download_url: 'u-dd26-b', files: [{ file_name: 'Wicked - Daredevil Portrait Bust (Size and Printing Information)', extension: 'txt', file_size: 2311 }] },
  { creator: 'Wicked', product_name: 'Wicked Marvel Captain Marvel Sculpture', download_url: 'u-cm-s', files: [{ file_name: 'WICKED - Captain Marvel Sculpture (Non Supported)', extension: 'zip', file_size: 4100003 }] },
  { creator: 'Wicked', product_name: 'Wicked Captain Marvel Bust', download_url: 'u-cm-b', files: [{ file_name: 'WICKED - Captain Marvel Bust (Non Supported)', extension: 'zip', file_size: 4100004 }] },
]));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { scanLibrary } = require('../scanner');
const enrich = require('../lib/enrich');

const cards = (like) => db.prepare(`SELECT * FROM models WHERE work_key LIKE ? AND folded_into IS NULL ORDER BY work_key`).all(like);
let before, second, third;

beforeAll(async () => {
  await scanLibrary(LIB);
  before = db.prepare(`SELECT * FROM models WHERE work_key = 'Wicked|work|daredevil'`).get();
  db.prepare(`UPDATE models SET tags = '["dd-fav"]', print_status = 'printed' WHERE id = ?`).run(before.id);
  // release 2 arrives: Drive downloads of the March 2026 Term in a "Daredevil v Kingpin 2025" folder,
  // and Captain Marvel 2025 (no store match, the folder year says it)
  const NEW = `${M}/Daredevil v Kingpin 2025`;
  mk(`${NEW}/Daredevil Sculpture-20260603T184523Z-3-001.zip`);
  mk(`${NEW}/Daredevil Sculpture-20260603T184523Z-3-002.zip`);
  mk(`${NEW}/Daredevil Bust Portrait-20260603T184520Z-3-001.zip`);
  mk(`${NEW}/Wicked - Daredevil Portrait Bust (Size and Printing Information).txt`, 2311);
  mk(`${NEW}/WICKED - Daredevil & Kingpin Diorama (Non Supported).zip`);
  mk(`${M}/Captain Marvel 2025/WICKED - Captain Marvel Sculpture (Chitubox Pre Supported)-002.zip`);
  mk(`${M}/Captain Marvel 2025/WICKED - Captain Marvel Portrait Bust (Non Supported)-002.zip`);
  second = await scanLibrary(LIB);
  third = await scanLibrary(LIB);
});
afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('release split', () => {
  test('one release keeps today\'s key (no churn)', () => {
    expect(before).toBeTruthy();
    expect(before.name).toBe('Daredevil');
    expect(JSON.parse(before.editions)).toEqual(['Sculpture', 'Bust']); // the Netflix Sculpture + Bust are one release
  });

  test('two releases → two cards; the release holding most known files keeps the row and its data', () => {
    const dd = cards('Wicked|work|daredevil%');
    expect(dd.map(c => c.work_key)).toEqual(['Wicked|work|daredevil|r:2026-03', 'Wicked|work|daredevil|r:netflix']);
    const netflix = dd.find(c => c.work_key.endsWith('netflix'));
    const term = dd.find(c => c.work_key.endsWith('2026-03'));
    expect(netflix.id).toBe(before.id);
    expect(JSON.parse(netflix.tags)).toEqual(['dd-fav']);
    expect(netflix.print_status).toBe('printed');
    expect(netflix.name).toBe('Daredevil (Netflix)');
    expect(term.name).toBe('Daredevil (2026)');
    expect(term.release_term).toBe('2026-03');
    expect(term.release_label).toBeTruthy();
    expect(term.notes).toBe('Split from Daredevil (release 2026)');
    expect(JSON.parse(term.editions)).toEqual(['Sculpture', 'Bust']); // Sculpture + Bust of one release together
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(term.id).n).toBe(4);
    expect(db.prepare('SELECT COUNT(*) n FROM model_files WHERE model_id = ?').get(netflix.id).n).toBe(2);
    expect(fs.readdirSync(process.env.BACKUP_DIR).some(f => /^vault-pre-split-.*\.db$/.test(f))).toBe(true);
  });

  test('a year folder with no store match is a release too', () => {
    const cm = cards('Wicked|work|captain marvel%');
    expect(cm.map(c => [c.work_key, c.name])).toEqual([
      ['Wicked|work|captain marvel|r:2025', 'Captain Marvel (2025)'],
      ['Wicked|work|captain marvel|r:base', 'Captain Marvel'],
    ]);
  });

  test('dioramas never split; a bare "V2" part folder is not a release', () => {
    const dio = db.prepare(`SELECT * FROM models WHERE kind = 'diorama' AND folded_into IS NULL`).all();
    expect(dio).toHaveLength(1);
    expect(dio[0].work_key).not.toMatch(/\|r:/);
    expect(cards('Wicked|work|ghost rider%').map(c => c.work_key)).toEqual(['Wicked|work|ghost rider']);
  });

  test('the rescan after a split is a no-op', () => {
    expect(second.modelsAdded).toBeGreaterThanOrEqual(2);
    expect(third).toMatchObject({ modelsAdded: 0, modelsUpdated: 0, folded: 0 });
  });

  test('model detail lists the sibling releases; list items carry release_label', async () => {
    const term = cards('Wicked|work|daredevil|r:2026-03')[0];
    const d = (await request(app).get(`/api/models/${term.id}`)).body;
    expect(d.siblings).toEqual([expect.objectContaining({ id: before.id, name: 'Daredevil (Netflix)', editions: ['Sculpture', 'Bust'] })]);
    const list = (await request(app).get('/api/models?search=Daredevil')).body.models;
    expect(list.find(m => m.id === term.id).release_label).toBeTruthy();
  });
});

describe('enrich and releases', () => {
  test('evidence carries the release and sibling names; releases are never merge candidates', () => {
    const sel = enrich.selectCards(db, { scope: 'all' }, { libraryRoot: LIB });
    const term = sel.cards.find(c => c.work_key === 'Wicked|work|daredevil|r:2026-03');
    expect(term.ev.release).toBe('2026-03');
    expect(term.ev.siblings).toEqual(['Daredevil (Netflix)']);
    expect((term.ev.similar || []).some(s => s.id === before.id)).toBe(false);
    expect(enrich.systemPrompt({ genres: [], groups: {}, fixes: [] })).toMatch(/Never merge releases/);
  });

  test('a merge between releases is refused; aliases join characters, not releases', () => {
    const term = cards('Wicked|work|daredevil|r:2026-03')[0];
    const sid = db.prepare(`INSERT INTO suggestions (model_id, type, target_id, confidence) VALUES (?, 'merge', ?, 0.9)`).run(term.id, before.id).lastInsertRowid;
    const r = enrich.decide(db, [sid], 'accept');
    expect(r.errors[0].error).toMatch(/different releases/);
    expect(db.prepare('SELECT folded_into FROM models WHERE id = ?').get(term.id).folded_into).toBeNull();
    expect(enrich.releaseOf('Wicked|work|daredevil|r:2026-03')).toEqual({ base: 'Wicked|work|daredevil', release: '2026-03' });
    expect(enrich.storeAlias(db, { work_key: 'Wicked|work|dare devil|r:2025', name: 'Dare Devil (2025)' }, { work_key: 'Wicked|work|daredevil|r:2026-03', name: 'Daredevil (2026)', character: 'Daredevil' })).toBe(true);
    expect(db.prepare(`SELECT from_key, to_key, to_name FROM aliases WHERE from_key = 'Wicked|work|dare devil'`).get())
      .toEqual({ from_key: 'Wicked|work|dare devil', to_key: 'Wicked|work|daredevil', to_name: 'Daredevil' });
  });
});
