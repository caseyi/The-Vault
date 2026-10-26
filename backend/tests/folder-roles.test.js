/**
 * Folder roles (docs/folder-roles.md): CSV parsing and the file-wins merge, then each role in the
 * folder, studio and release layouts, category values and their provenance, deep creator marks.
 * Pure engine tests on temp trees (walkTree + planWorks), no DB.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const works = require('../lib/works');
const roles = require('../lib/folder-roles');

let sizeSeq = 3000;
function makeLib(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-roles-')));
  const lib = path.join(root, 'library');
  fs.mkdirSync(lib);
  for (const rel of files) {
    const full = path.join(lib, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(sizeSeq += 7));
  }
  return { root, lib };
}
/** marks: { 'rel/path': 'role' | { role, genre, group, tags } } */
function plan(lib, marks = {}) {
  const entries = Object.entries(marks).map(([rel, m]) => {
    const o = typeof m === 'string' ? { role: m } : m;
    return { path: path.join(lib, rel), role: o.role, genre: o.genre || null, group: o.group || null, tags: o.tags || [], source: 'app' };
  });
  const { overrides, roleInfo } = roles.roleMaps(roles.mergeRoles([], entries));
  const ignore = new Set([...overrides].filter(([, r]) => r === 'ignore').map(([p]) => p));
  const tree = works.walkTree(lib, { ignore });
  const p = works.planWorks({ libraryPath: lib, tree, meta: null, overrides, roleInfo });
  works.finalizeWorks(p.works, { libraries: [], libraryOf: () => null });
  for (const w of p.works) w.attr = works.attributeWork(w, null);
  return p;
}
const names = (p, creator) => p.works.filter(w => !creator || w.creator === creator).map(w => w.name).sort();
const holding = (p, frag) => p.works.filter(w => w.files.some(f => f.abs.includes(frag)));

// ── CSV parsing + merge ──────────────────────────────────────────────────────

describe('_Meta/folder_roles.csv', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeLib(['STL Archive/Misc/Terrain/rock.stl', 'STL Archive/Misc/Old Junk/x.stl', 'STL Archive/STL minis/Heroes/a/a.stl']);
    const meta = path.join(tmp.lib, 'STL Archive', '_Meta');
    fs.mkdirSync(meta);
    fs.writeFileSync(path.join(meta, 'folder_roles.csv'), [
      'path,role,genre,group,tags,note,extra',
      'Misc/Terrain,category,,,terrain|scenery,,ignored column',
      'misc/old junk,Ignore,,,,case-insensitive match,',
      'STL minis/Heroes,container,,,,,',
      'Misc/Gone,model,,,,,',
      'Misc,,,,,blank role is ignored,',
      'Misc/Terrain/../..,bogus,,,,,',
      '"STL minis/Heroes",category,,Heroes,"a, b",later row wins,',
    ].join('\n'));
  });
  afterAll(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  test('rows resolve to absolute paths; warnings are reported, not fatal', () => {
    const fr = roles.loadFileRoles([path.join(tmp.lib, 'STL Archive', '_Meta')]);
    expect(fr.files).toHaveLength(1);
    const f = fr.files[0];
    expect(f.rows).toBe(6);
    expect(f.errors.some(e => /row 5: path not found: Misc\/Gone/.test(e))).toBe(true);
    expect(f.errors.some(e => /unknown role "bogus"/.test(e))).toBe(true);
    expect(f.errors.some(e => /listed again/.test(e))).toBe(true);
    const by = new Map(fr.entries.map(e => [e.rel, e]));
    expect(by.get('Misc/Terrain')).toMatchObject({ role: 'category', tags: ['terrain', 'scenery'], source: 'file' });
    expect(by.get('Misc/Old Junk')).toMatchObject({ role: 'ignore', path: path.join(tmp.lib, 'STL Archive/Misc/Old Junk') });
    expect(by.get('STL minis/Heroes')).toMatchObject({ role: 'category', group: 'Heroes', tags: ['a', 'b'] });
  });

  test('a file without the required header is reported', () => {
    const dir = fs.mkdtempSync(path.join(tmp.root, 'm-'));
    fs.writeFileSync(path.join(dir, 'folder_roles.csv'), 'folder,kind\nMisc,category\n');
    const fr = roles.loadFileRoles([dir]);
    expect(fr.files[0].errors[0]).toMatch(/header/);
    expect(fr.entries).toEqual([]);
  });

  test('the file wins; a differing app mark is recorded as a conflict', () => {
    const file = [{ path: '/l/a', role: 'category', genre: null, group: null, tags: ['x'], source: 'file' }, { path: '/l/b', role: 'model', tags: [], source: 'file' }];
    const app = [{ path: '/l/a', role: 'ignore', tags: [], source: 'app' }, { path: '/l/b', role: 'model', tags: [], source: 'app' }, { path: '/l/c', role: 'creator', tags: [], source: 'app' }];
    const m = roles.mergeRoles(file, app);
    expect(m.get('/l/a')).toMatchObject({ role: 'category', source: 'file', conflict: { role: 'ignore' } });
    expect(m.get('/l/b')).toMatchObject({ role: 'model', source: 'file', conflict: null });
    expect(m.get('/l/c')).toMatchObject({ role: 'creator', source: 'app', conflict: null });
  });

  test('role values: container is passthrough, auto clears, tags split on | and ,', () => {
    expect(roles.normalizeRole('Container')).toBe('passthrough');
    expect(roles.normalizeRole('')).toBeNull();
    expect(roles.normalizeRole('auto')).toBeNull();
    expect(roles.normalizeRole('nope')).toBeUndefined();
    expect(roles.parseTags('Terrain| scenery ,terrain,=cmd')).toEqual(['terrain', 'scenery']);
  });
});

// ── folder layout ────────────────────────────────────────────────────────────

describe('roles in the folder layout', () => {
  let tmp;
  const FILES = [
    'Misc/Terrain/Rocks/rock.stl', 'Misc/Terrain/Trees/tree.stl', 'Misc/Terrain/loose wall.stl', 'Misc/Terrain/loose wall.jpg',
    'Misc/Unicorn/unicorn.stl',
    'Misc/Big Dragon/Head/head.stl', 'Misc/Big Dragon/Body/body.stl', 'Misc/Big Dragon/Wings/Left/wl.stl', 'Misc/Big Dragon/Wings/Right/wr.stl',
    'Misc/Old Junk/junk.stl',
    'Misc/Shelf/Stuff/Some Creator/Thing A/a.stl', 'Misc/Shelf/Stuff/Some Creator/Thing B/b.stl', 'Misc/Shelf/Other/o.stl',
    'Diorama Pieces/Part 1/p1.stl', 'Diorama Pieces/Part 2/p2.stl',
    'Marvel Stuff/X-Men/Cyclops/c.stl', 'Marvel Stuff/X-Men/Storm/s.stl',
  ];
  beforeAll(() => { tmp = makeLib(FILES); });
  afterAll(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  test('no roles: today\'s heuristics (baseline)', () => {
    const p = plan(tmp.lib);
    expect(holding(p, '/Big Dragon/').length).toBe(4); // each part folder is a card
    expect(holding(p, '/Old Junk/').length).toBe(1);
  });

  test('category: never a card, sub-folders are cards, loose files one card each, values flow down', () => {
    const p = plan(tmp.lib, { 'Misc/Terrain': { role: 'category', tags: ['terrain'] } });
    const t = holding(p, '/Terrain/');
    expect(t).toHaveLength(3);
    expect(t.map(w => w.name)).toEqual(expect.arrayContaining(['Trees', 'loose wall']));
    const loose = t.find(w => w.name === 'loose wall');
    expect(loose.files.map(f => f.name).sort()).toEqual(['loose wall.jpg', 'loose wall.stl']);
    for (const w of t) expect(w.roleTags).toEqual(['terrain']);
    expect(holding(p, '/Unicorn/')[0].roleTags).toBeUndefined();
  });

  test('category without values: a genre name is the genre, any other name the group (provenance "role")', () => {
    const p = plan(tmp.lib, { 'Marvel Stuff': { role: 'category', genre: 'Marvel' }, 'Marvel Stuff/X-Men': 'category' });
    const cy = holding(p, '/Cyclops/')[0];
    expect(cy.roleGenre).toBe('Marvel');
    expect(cy.roleGroup).toBe('X-Men');
    expect(cy.group).toBe('X-Men');
    expect(cy.attr.genre).toBe('Marvel');
    expect(cy.attr.attribution.fields.franchise).toBe('role');
    expect(cy.attr.attribution.fields.group_name).toBe('role');
    expect(names(p, 'Marvel Stuff')).toEqual([]); // a category at the creator level is not a creator
  });

  test('category at the creator level: one Unsorted folder root, sub-folders are cards as usual', () => {
    const p = plan(tmp.lib, { Misc: { role: 'category', tags: ['misc'] } });
    const misc = holding(p, '/Misc/');
    expect(misc.every(w => w.creator === 'Unsorted')).toBe(true);
    expect(p.roots.filter(r => r.path.startsWith(path.join(tmp.lib, 'Misc'))).map(r => r.creator)).toEqual(['Unsorted']);
    // normal discovery below it: Big Dragon's parts are cards, Unicorn is one card
    expect(holding(p, '/Misc/Unicorn/')).toHaveLength(1);
    // every file under Misc belongs to a card
    expect(misc.reduce((t, w) => t + w.files.length, 0)).toBe(FILES.filter(f => f.startsWith('Misc/')).length);
    for (const w of misc) { expect(w.key).toMatch(/^Unsorted\|model\|@misc\//); expect(w.roleTags).toEqual(['misc']); expect(w.group).toBe('Misc'); }
  });

  test('nearest genre and group win, tags union', () => {
    const entries = [
      { path: '/l/A', role: 'category', genre: 'Movies', group: 'Outer', tags: ['a'] },
      { path: '/l/A/B', role: 'category', genre: null, group: 'Inner', tags: ['b'] },
    ];
    const { roleInfo } = roles.roleMaps(roles.mergeRoles([], entries));
    expect(roles.categoryFor('/l/A/B/C', roleInfo, () => null, '/l')).toEqual({ genre: 'Movies', group: 'Inner', tags: ['b', 'a'] });
  });

  test('model: exactly one card with every file below it', () => {
    const p = plan(tmp.lib, { 'Misc/Big Dragon': 'model' });
    const d = holding(p, '/Big Dragon/');
    expect(d).toHaveLength(1);
    expect(d[0].name).toBe('Big Dragon');
    expect(d[0].files).toHaveLength(4);
  });

  test('model at the creator level: one card, creator Unsorted', () => {
    const p = plan(tmp.lib, { 'Diorama Pieces': 'model' });
    const d = holding(p, '/Diorama Pieces/');
    expect(d).toHaveLength(1);
    expect(d[0].creator).toBe('Unsorted');
    expect(d[0].name).toBe('Diorama Pieces');
    expect(d[0].files).toHaveLength(2);
  });

  test('ignore deep: the folder and everything below it are skipped', () => {
    const p = plan(tmp.lib, { 'Misc/Old Junk': 'ignore' });
    expect(holding(p, '/Old Junk/')).toEqual([]);
  });

  test('container deep: no card, go inside', () => {
    const p = plan(tmp.lib, { 'Misc/Big Dragon': 'passthrough' });
    expect(holding(p, '/Big Dragon/').length).toBe(4);
  });

  test('a deep creator mark becomes its own creator root, out of its parent', () => {
    const p = plan(tmp.lib, { 'Misc/Shelf/Stuff/Some Creator': 'creator' });
    expect(names(p, 'Some Creator')).toEqual(['Thing A', 'Thing B']);
    expect(holding(p, '/Some Creator/').every(w => w.creator === 'Some Creator')).toBe(true);
    expect(holding(p, '/Shelf/Other/')[0].creator).toBe('Misc');
    expect(p.roots.some(r => r.path.endsWith('Some Creator') && r.deep)).toBe(true);
  });
});

// ── studio layout ────────────────────────────────────────────────────────────

describe('roles in the studio layout', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeLib([
      'Wicked Archive/Movies/Aliens/Aliens DIORAMA COMPLETE/Queen/Wicked - Alien Queen Diorama (One Piece).zip',
      'Wicked Archive/Movies/Aliens/Aliens DIORAMA COMPLETE/Ripley/Wicked - Ripley Sculpture (Non Supported).zip',
      'Wicked Archive/Movies/Aliens/Aliens DIORAMA COMPLETE/Base/base.stl',
      'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)/ken head.stl',
      'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)/2024/ken body.stl',
      'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)/2025/ken arm.stl',
      'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)/2025/ken arm2.stl',
      'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)/2024/ken body2.stl',
      'Wicked Archive/Marvel/Mutants/Wicked - Wolverine Bust (Non Supported).zip',
      'Wicked Archive/Marvel/Mutants/Wicked - Storm Sculpture (Non Supported).zip',
    ]);
  });
  afterAll(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  test('a model-marked folder is one card keyed from its own name', () => {
    const before = plan(tmp.lib);
    expect(holding(before, 'Aliens DIORAMA COMPLETE').length).toBeGreaterThan(1);
    const p = plan(tmp.lib, { 'Wicked Archive/Movies/Aliens/Aliens DIORAMA COMPLETE': 'model' });
    const a = holding(p, 'Aliens DIORAMA COMPLETE');
    expect(a).toHaveLength(1);
    expect(a[0].files).toHaveLength(3);
    expect(a[0].kind).toBe('diorama');
    expect(a[0].creator).toBe('Wicked');
  });

  test('model folder name through the studio parser; no release split inside it', () => {
    const p = plan(tmp.lib, { 'Wicked Archive/Movies/Barbie/Wicked - Ken Bust 345mm (Non Supported)': 'model' });
    const k = holding(p, 'Ken Bust');
    expect(k).toHaveLength(1);
    expect(k[0].character).toBe('Ken');
    expect(k[0].editions).toEqual(['Bust']);
    expect(k[0].releaseId).toBeUndefined();
  });

  test('a category in a studio tree carries no identity; its name is the group', () => {
    const p = plan(tmp.lib, { 'Wicked Archive/Marvel/Mutants': 'category' });
    const w = holding(p, 'Wolverine')[0];
    expect(w.character).toBe('Wolverine');
    expect(w.attr.genre).toBe('Marvel');
    expect(w.group).toBe('Mutants');
    expect(holding(p, 'Storm')[0].character).toBe('Storm');
  });

  test('a category genre replaces the genre-folder rule', () => {
    const p = plan(tmp.lib, { 'Wicked Archive/Marvel/Mutants': { role: 'category', genre: 'X-Men Universe' } });
    expect(holding(p, 'Wolverine')[0].attr.genre).toBe('X-Men Universe');
    expect(holding(p, 'Wolverine')[0].attr.attribution.fields.franchise).toBe('role');
  });
});

// ── release layout ───────────────────────────────────────────────────────────

describe('roles in the release layout', () => {
  let tmp;
  const REL = 'Loot Studios/2022-04 - Crimson Sand Arena';
  beforeAll(() => {
    tmp = makeLib([
      `${REL}/Heroes/Gladiator/32mm/gladiator.stl`, `${REL}/Heroes/Gladiator/75mm/gladiator.stl`,
      `${REL}/Heroes/Gladiator/Shield/32mm/shield.stl`, `${REL}/Heroes/Gladiator/Helmet/32mm/helmet.stl`,
      `${REL}/Heroes/Retiarius/32mm/ret.stl`,
      'Loot Studios/2022-05 - Dark Forest/Treant/32mm/treant.stl', 'Loot Studios/2022-05 - Dark Forest/Wolf/32mm/wolf.stl',
    ]);
  });
  afterAll(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  test('a model-marked release item folder is one item', () => {
    const before = plan(tmp.lib);
    expect(holding(before, '/Gladiator/').length).toBeGreaterThan(1);
    const p = plan(tmp.lib, { [`${REL}/Heroes/Gladiator`]: 'model' });
    const g = holding(p, '/Gladiator/');
    expect(g).toHaveLength(1);
    expect(g[0].kind).toBe('release-item');
    expect(g[0].files).toHaveLength(4);
    expect(holding(p, '/Retiarius/')).toHaveLength(1);
  });

  test('a model-marked release folder is a single item', () => {
    const p = plan(tmp.lib, { 'Loot Studios/2022-05 - Dark Forest': 'model' });
    const d = holding(p, 'Dark Forest');
    expect(d).toHaveLength(1);
    expect(d[0].files).toHaveLength(2);
    expect(d[0].kind).toBe('release-item');
  });

  test('a category inside a release: its name is the group of the items', () => {
    const p = plan(tmp.lib, { [`${REL}/Heroes`]: 'category' });
    for (const w of holding(p, '/Heroes/')) expect(w.group).toBe('Heroes');
  });
});
