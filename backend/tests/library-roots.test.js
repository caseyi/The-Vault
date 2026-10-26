/**
 * Library roots are never cards (Casey, Oct 2026: one "STL Archive" card held a huge mix).
 * The real NAS has three loose zips at the top of "STL Archive" (Red+Dragon (1).zip, …), and
 * add-library.sh mounts Endor at /library/Endor, a name that is not a mount name. Both used to turn
 * the whole library into one creator: the root became a giant card and Wicked was never parsed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const works = require('../lib/works');
const libs = require('../lib/libraries');

let sizeSeq = 2000;
function makeLib(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-roots-')));
  const lib = path.join(root, 'library');
  fs.mkdirSync(lib);
  for (const rel of files) {
    const full = path.join(lib, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(sizeSeq += 7));
  }
  return { root, lib };
}
function plan(lib) {
  const tree = works.walkTree(lib, {});
  return works.planWorks({ libraryPath: lib, tree, meta: null });
}
const byCreator = (p, c) => p.works.filter(w => w.creator === c);

const WICKED = [
  'Wicked Archive/Movies/Krampus/Wicked - Krampus Portrait Bust (Non Supported).zip',
  'Wicked Archive/Movies/Krampus/Wicked - Krampus Portrait Bust (Pre Supported - STL).zip',
  'Wicked Archive/Marvel/Kingpin/Wicked - Kingpin Sculpture (Non Supported).zip',
];
const CREATORS = [
  'Loot Studios/2022-04 - Crimson Sand Arena/Heroes/Gladiator/32mm/gladiator.stl',
  'Loot Studios/2022-04 - Crimson Sand Arena/Heroes/Gladiator/75mm/gladiator.stl',
  'CA 3D/Aztec Goddess/aztec goddess.stl',
  'CA 3D/Aztec Goddess/aztec goddess base.stl',
  'CA 3D/Medusa/medusa.stl',
];

describe('library folders with loose files at the top', () => {
  let tmp, p;
  beforeAll(() => {
    tmp = makeLib([
      ...[...WICKED, ...CREATORS].map(f => `STL Archive/${f}`),
      'STL Archive/Red+Dragon (1).zip',
      'STL Archive/Red+Dragon.jpg',
      'STL Archive/Goblin+Air+Ballon copy.zip',
      'STL Archive/Nejavina-Slavic-DnD-Setting-KS-Free-STL.zip',
      'STL Archive/.env',
      'STL Archive/.DS_Store',
      'Endor/Wicked/DC/Joker/B3DSERK - Joker Statue 421mm (Non Supported).zip',
      'Endor/Wicked/DC/Joker/B3DSERK - Joker Statue 421mm (X Pose).zip',
      'Endor/treantv1/32mm/No Supports/32mm_Treant.stl',
      'Endor/treantv1/75mm/No Supports/75mm_Treant.stl',
      'Endor/Sliced Files/Thing/thing.ctb',
      'Endor/Sliced Files/Other/other.ctb',
    ]);
    p = plan(tmp.lib);
  });
  afterAll(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  test('no card or creator is a library', () => {
    expect(byCreator(p, 'STL Archive')).toEqual([]);
    expect(byCreator(p, 'Endor')).toEqual([]);
    expect(p.works.find(w => /^(STL Archive|Endor)$/.test(w.name))).toBeUndefined();
    // the library folder is only a root for its own loose files
    expect(p.roots.filter(r => r.type !== 'loose').map(r => r.path)).not.toContain(path.join(tmp.lib, 'STL Archive'));
  });

  test('loose files become one Unsorted card each, with a readable name', () => {
    const loose = byCreator(p, 'Unsorted');
    expect(loose.map(w => w.name).sort()).toEqual(['Goblin Air Ballon', 'Nejavina Slavic DnD Setting KS Free STL', 'Red Dragon']);
    const dragon = loose.find(w => w.name === 'Red Dragon');
    expect(dragon.files.map(f => f.name).sort()).toEqual(['Red+Dragon (1).zip', 'Red+Dragon.jpg']);
    expect(loose.every(w => w.kind === 'model')).toBe(true);
    // .env / .DS_Store are never files of a card
    expect(p.works.flatMap(w => w.files).some(f => /^\.(env|DS_Store)$/.test(f.name))).toBe(false);
  });

  test('loose cards sharing the library folder get distinct virtual paths', () => {
    const loose = byCreator(p, 'Unsorted');
    works.finalizeWorks(loose, { libraries: [], libraryOf: () => null });
    const paths = loose.map(w => w.folderPath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const fp of paths) expect(works.realFolder(fp)).toBe(path.join(tmp.lib, 'STL Archive'));
  });

  test('studio parsing still runs in both libraries', () => {
    const wicked = byCreator(p, 'Wicked').map(w => w.character || w.name);
    expect(wicked).toEqual(expect.arrayContaining(['Krampus', 'Kingpin']));
    const joker = p.works.find(w => w.creator === 'B3DSERK');
    expect(joker && joker.character).toBe('Joker');
    expect(joker.files).toHaveLength(2);
  });

  test('the other creators of each library are creators', () => {
    const creators = new Set(p.works.map(w => w.creator));
    for (const c of ['Loot Studios', 'CA 3D', 'treantv1', 'Sliced Files']) expect(creators).toContain(c);
  });
});

describe('a container named like one keeps descending with loose files', () => {
  test('"Downloads" with loose zips and creator folders', () => {
    const tmp = makeLib([
      'STL Archive/Downloads/Some Pack.zip',
      'STL Archive/Downloads/Epic Miniatures/Orc/orc.stl',
      'STL Archive/Downloads/Epic Miniatures/Elf/elf.stl',
      'STL Archive/Misc/thing/thing.stl',
    ]);
    try {
      const p = plan(tmp.lib);
      expect(byCreator(p, 'Downloads')).toEqual([]);
      expect(byCreator(p, 'Unsorted').map(w => w.name)).toEqual(['Some Pack']);
      expect(byCreator(p, 'Epic Miniatures').length).toBe(2);
    } finally { fs.rmSync(tmp.root, { recursive: true, force: true }); }
  });

  test('a plain creator-per-folder library: loose files at its top get cards too', () => {
    const tmp = makeLib(['Red Dragon.zip', 'Epic Miniatures/Orc/orc.stl', 'Epic Miniatures/Elf/elf.stl']);
    try {
      const p = plan(tmp.lib);
      expect(byCreator(p, 'Unsorted').map(w => w.name)).toEqual(['Red Dragon']);
      expect(byCreator(p, 'Epic Miniatures').length).toBe(2);
    } finally { fs.rmSync(tmp.root, { recursive: true, force: true }); }
  });

  test('a scoped scan of one creator leaves the loose cards alone', () => {
    const tmp = makeLib(['STL Archive/Red Dragon.zip', 'STL Archive/Epic Miniatures/Orc/orc.stl', 'STL Archive/Epic Miniatures/Elf/elf.stl', 'STL Archive/Misc/x/x.stl']);
    try {
      const scope = path.join(tmp.lib, 'STL Archive', 'Epic Miniatures');
      const tree = works.walkTree(tmp.lib, { scope });
      const p = works.planWorks({ libraryPath: tmp.lib, tree, meta: null, scope });
      expect(byCreator(p, 'Unsorted')).toEqual([]);
      expect(byCreator(p, 'Epic Miniatures').length).toBe(2);
    } finally { fs.rmSync(tmp.root, { recursive: true, force: true }); }
  });
});

describe('libraryFolderNames', () => {
  const labels = libs.parseLabels('STL Archive=Dagobah,3dPrint=Endor');
  test('once one top-level folder is a mount, every top-level folder is a library', () => {
    expect(libs.libraryFolderNames(['STL Archive', 'Endor', '_Meta', '@eaDir'], labels)).toEqual(['STL Archive', 'Endor']);
    expect(libs.libraryFolderNames(['3dPrint', 'More Prints'], new Map())).toEqual(['3dPrint', 'More Prints']);
  });
  test('a creator-per-folder library has none', () => {
    expect(libs.libraryFolderNames(['Wicked', 'Loot Studios', 'Zez'], labels)).toEqual([]);
  });
});
