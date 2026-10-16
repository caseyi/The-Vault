/**
 * lib/works.js — grouping files into works (gallery cards), on mini trees copied
 * structurally from the Oct 2026 inventories:
 *   Endor 3dPrint/Wicked/DC/Joker (extracted variant folders, Full Pieces, Chain With Move)
 *   Wicked Archive/Movies/Lord of the Rings (Gandalf & Balrog diorama, Barlog typo, Drive stamps)
 *   Gumroad Downloads/<Creator>/<Genre>/<Product>
 *   Loot Studios/2022-04 - Crimson Sand Arena (32mm/75mm/Supported/LYCHEE/Hollow, extraction copies)
 *   Zez/<Character> (lower-case names, bonus busts)
 * No DB: walkTree → planWorks → finalizeWorks → attributeWork.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const works = require('../lib/works');
const metaLib = require('../lib/meta');
const libs = require('../lib/libraries');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-works-')));
const LIB = path.join(ROOT, 'library');
const DAGO = path.join(LIB, 'STL Archive');
const ENDOR = path.join(LIB, '3dPrint');
let sizeSeq = 1000;
function mk(rel, size) {
  const full = path.join(LIB, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size || (sizeSeq += 7)));
  return full;
}

// ── Endor: B3DSERK Joker with extracted variant folders ──
const J = '3dPrint/Wicked/DC/Joker';
for (const v of ['(Renders)_2', '(X Pose)', '(Non Supported)', '(One Piece)', '(Pre Support Chitubox)', '(Pre Support STL)', '(Renders)']) mk(`${J}/B3DSERK - Joker Statue 421mm ${v}.zip`);
mk(`${J}/One Piece - Upper Body - Lowe Body Joker FIX.zip`);
mk(`${J}/B3DSERK - Joker Statue 421mm (X Pose)/Xpose_Base.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (X Pose)/Xpose_Joker.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (Non Supported)/Base_1.1.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (Non Supported)/Head.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (Non Supported)/Chain With Move/CHAIN_MOVE.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (Non Supported)/Full Pieces/Base_1_Full.stl`);
mk(`${J}/B3DSERK - Joker Statue 421mm (Non Supported)/Full Pieces/Head.stl`);
// Endor: Sculpture + Bust of one character in a short-named folder
mk('3dPrint/Wicked/Marvel/Cap Marvel/WICKED - Capitain Marvel Statue 310mm (Pre Supported Chitubox).zip');
mk('3dPrint/Wicked/Marvel/Cap Marvel/WICKED - Capitain Marvel 310mm (X Pose).zip');
mk('3dPrint/Wicked/Marvel/Cap Marvel/WICKED - Captain Marvel Bust 265mm (Non Supported).zip');
mk('3dPrint/Wicked/Marvel/Cap Marvel/WICKED - Captain Marvel Bust 265mm (Images).zip');
// A: genre folder (DC) vs a manifest product whose name says Star Wars; a part file named like
// another product's part file ("Cape_Full") must not name-match
mk('3dPrint/Wicked/DC/Alan Scott/B3DSERK - Alan Scott Statue (Non Supported).zip', 6060001);
mk('3dPrint/Wicked/DC/Alan Scott/B3DSERK - Alan Scott Statue (Non Supported)/Cape_Full.stl', 6060002);
// D: a misfiled copy under another group folder must not give the work that group
mk('3dPrint/Wicked/Movies/Gremlins/Wicked - Gizmo Sculpture (One Piece).zip');
mk('3dPrint/Wicked/Marvel/Spiderverse/The Spot/Wicked - Gizmo Sculpture (X Pose).zip');
// two works in one folder → virtual paths
mk('3dPrint/Wicked/DC/Batman 66 Dio/B3DSERK - Batman 1966 Bust 262mm (One Piece).zip');
mk('3dPrint/Wicked/DC/Batman 66 Dio/B3DSERK Batmanand Robin Diorama (X Pose).zip');

// ── Dagobah Wicked Archive: Lord of the Rings ──
const R = 'STL Archive/Wicked Archive/Movies/Lord of the Rings';
mk(`${R}/Gandalf and Balrog/WICKED - Balrog Statue 863.63mm (Chitubox Pre Supported)/100/Base/Base_1.chitubox`);
mk(`${R}/Gandalf and Balrog/WICKED - Balrog Statue 863.63mm (Chitubox Pre Supported)/50/Wings/Wing_L.chitubox`);
mk(`${R}/Gandalf and Balrog/WICKED - Gandalf Statue 459.31 mm (Chitubox Pre Supported)/50/Head/Head.chitubox`);
mk(`${R}/Gandalf and Balrog/Xpose Diorama Base Gandalf & Barlog/Xpose Barlog Section/Xpose_Bridge_1.stl`);
mk(`${R}/Gandalf and Balrog/X_pose (1).stl`);
mk(`${R}/Gandalf and Balrog/WICKED - DIORAMA BASE Gandalf & Balrog (Bridge_4_FIX).stl`);
mk(`${R}/WICKED - DIORAMA BASE Gandalf & Balrog/WICKED - DIORAMA BASE Gandalf & Balrog (Chitubox and STL Balrog Section).zip`);
mk(`${R}/WICKED - Balrog Statue 863.63mm/WICKED - Balrog Statue 863.63mm (One Piece).zip`);
mk(`${R}/WICKED - Barlog Statue 863.63mm/WICKED - Barlog Statue 863.63mm (Non Supported).zip`);
mk(`${R}/WICKED - Balrog Bust 500mm/WICKED - Barlog Bust 500mm (Chitubox Pre Supported).zip`);
mk(`${R}/WICKED - Gandalf Bust 270mm/WICKED - Gandalf Bust 270mm (Non Supported).zip`);
mk(`${R}/WICKED - Gandalf Statue 459.31 mm/WICKED - Gandalf Statue 459.31 mm (One Piece).zip`);
mk(`${R}/Legolas vs Troll/WICKED - Legolas Vs Troll Diorama (Lite Version)-20260603T170306Z-3-004.zip`);
mk(`${R}/Legolas vs Troll/Wicked - Legolas Vs Troll Diorama (Stl Pre Supported)-001.zip`);
mk(`${R}/Legolas vs Troll/WICKED - Troll Portrait Bust-20260603T170308Z-3-002.zip`);
mk(`${R}/Legolas vs Troll/WICKED - Legolas Portrait Bust-20260603T170302Z-3-001.zip`);
// SW3D files inside the Wicked Archive (no prefix on the pre-supported zip)
mk('STL Archive/Wicked Archive/Star Wars/Weapons/Han Solo Blaster - Pres Support - 50%-100%.zip');
mk('STL Archive/Wicked Archive/Star Wars/Weapons/Han Solo Blaster - Star Wars 3D Models - 27 parts.zip');

// ── Dagobah Gumroad Downloads: Creator/Genre/Product ──
const G = 'STL Archive/Gumroad Downloads';
mk(`${G}/Wicked/Movies/Krampus Portrait Bust/Wicked - Krampus Portrait Bust (Non Supported).zip`, 4242001);
mk(`${G}/Wicked/Movies/Krampus Portrait Bust/Wicked - Krampus Portrait Bust (X Pose).zip`);
mk(`${G}/Wicked/Movies/Krampus Portrait Bust/WICKED - Krampus Portrait Bust (Size).txt`);
mk(`${G}/Wicked/Movies/Krampus Sculpture/Wicked - Krampus Sculpture (One Piece).zip`, 4242002);
// the same Joker zip on both NASes: one card, two libraries (a backup, not a duplicate)
const jokerXPose = fs.statSync(path.join(LIB, `${J}/B3DSERK - Joker Statue 421mm (X Pose).zip`)).size;
mk(`${G}/B3DSERK Studios/DC/Joker Sculpture/B3DSERK - Joker Statue 421mm (X Pose).zip`, jokerXPose);

// ── Loot Studios release ──
const L = 'STL Archive/Loot Studios/2022-04 - Crimson Sand Arena';
mk(`${L}/All_Enemies_Part1/BugbearGladiator/32mm/No Supports/BugbearGladiator.stl`);
mk(`${L}/All_Enemies_Part1/BugbearGladiator/32mm/Supported/BugbearGladiator_Sup.stl`);
mk(`${L}/All_Enemies_Part1/BugbearGladiator/32mm/Supported/LYCHEE/BugbearGladiator.lys`);
mk(`${L}/All_Enemies_Part1/BugbearGladiator/75mm/No Supports/BugbearGladiator.stl`);
mk(`${L}/All_Enemies_Part1/BugbearGladiator/75mm/Supported/Hollow/BugbearGladiator.stl`);
mk(`${L}/All_Enemies_Part1/BugbearGladiator/75mm/Supported/Solid/BugbearGladiator.stl`);
mk(`${L}/All_Busts_v2/All_Busts_v2/LeoOfColossus_Bust/No Supports/Leo.stl`);
mk(`${L}/All_Busts_v2_2/All_Busts_v2/LeoOfColossus_Bust/Supported/Hollow/Leo.stl`);
mk('STL Archive/Loot Studios/Goblin Mines/Goblin/32mm/goblin.stl');
mk('STL Archive/Loot Studios/Goblin Mines/Goblin/75mm/goblin.stl');
mk('STL Archive/Loot Studios/2022-06 - Dwarven Forge/All Objects/barrel.stl');
mk('STL Archive/Loot Studios/2022-06 - Dwarven Forge/Env/tree.stl');
mk('STL Archive/Loot Studios/2022-06 - Dwarven Forge/Dwarf King/All Busts/king_bust.stl');
mk('STL Archive/Loot Studios/2022-06 - Dwarven Forge/Dwarf King/Model/king.stl');
mk('STL Archive/Ari campaign/Mothman/32mm/Mothman_32mm_Supported.stl');
mk('STL Archive/Ari campaign/Mothman/75mm/Mothman_75mm_Supported.stl');
mk('STL Archive/Ari campaign/Bulette/bulette.stl');

// ── Zez ──
for (const f of ['carnage 1-6.zip', 'carnage bust.zip', 'carnage bust (1).zip', 'carange render.zip', 'poster carnage.pdf']) mk(`STL Archive/Zez/Carnage/${f}`);
for (const f of ['1-4 Colossus stl.zip', 'bust colossus.zip', 'COLOSSUS PRESUPPORTS.zip', 'bust cable 1-6.zip']) mk(`STL Archive/Zez/Colossus/${f}`);
mk('STL Archive/Zez/Cable/cable 1-6.zip');

// ── special folders, sidecar ──
mk('STL Archive/_Tools/Slicer projects/Projects/next print.chitubox');
mk('STL Archive/_Inbox/Wicked/Wicked Movies Fight Club Term 2026/Edward Norton Sculpture/Wicked - Edward Norton Sculpture (One Piece).zip');
mk('STL Archive/_Duplicates_Pending_Delete/Wicked - Krampus Sculpture (One Piece).zip');
mk('STL Archive/Wicked/Movies/John Rambo/Sculpture/John Rambo Sculpture.zip');
fs.writeFileSync(path.join(DAGO, 'Wicked/Movies/John Rambo/Sculpture/model.json'), JSON.stringify({
  studio: 'Wicked', creator: 'Wicked', genre: 'Movies', character: 'John Rambo', type: 'Sculpture',
  files: ['John Rambo Sculpture.zip'], source: 'google-drive', claim_url: 'https://wickedart.gumroad.com/l/rambo', release_term: '2026-09',
}));

// ── _Meta: Krampus products (sizes match the files above) ──
fs.mkdirSync(path.join(DAGO, '_Meta'), { recursive: true });
fs.writeFileSync(path.join(DAGO, '_Meta', 'gumroad_manifest.json'), JSON.stringify([
  { creator: 'Wicked', product_name: 'Wicked Movies December 2025 Term Krampus Portrait Bust: Tested and ready for 3D printing', download_url: 'https://gumroad.com/d/krampusb',
    files: [{ file_name: 'Wicked - Krampus Portrait Bust (Non Supported)', extension: 'zip', file_size: 4242001 }, { file_name: 'Wicked - Krampus Portrait Bust (Images)', extension: 'zip', file_size: 4242003 }] },
  { creator: 'Wicked', product_name: 'Wicked Movies December 2025 Term Krampus Sculpture: Tested and ready for 3D printing', download_url: 'https://gumroad.com/d/krampuss',
    files: [{ file_name: 'Wicked - Krampus Sculpture (One Piece)', extension: 'zip', file_size: 4242002 }] },
  { creator: 'B3DSERK Studios', product_name: 'B3DSERK Star Wars Alan Scott Sculpture ready for printing', download_url: 'https://gumroad.com/d/alan',
    files: [{ file_name: 'B3DSERK - Alan Scott Statue (Non Supported)', extension: 'zip', file_size: 6060001 }] },
  { creator: 'Star Wars 3D Models', product_name: 'Count Doku Sculpture - Star Wars 3D Models - Tested and Ready for 3D printing', download_url: 'https://gumroad.com/d/doku',
    files: [{ file_name: 'Cape_Full', extension: 'stl', file_size: 123456789 }] },
  { creator: 'Wicked', product_name: 'Wicked Movies Never Downloaded Sculpture: Tested and ready for 3D printing', download_url: 'https://gumroad.com/d/never',
    files: [{ file_name: 'Wicked - Never Downloaded (One Piece)', extension: 'zip', file_size: 99999999 }] },
]));

let plan, byKey, meta, L2;
beforeAll(() => {
  process.env.LIBRARY_LABELS = 'STL Archive=Dagobah,3dPrint=Endor';
  L2 = libs.listLibraries(LIB);
  meta = metaLib.loadMeta({ dirs: L2.map(l => path.join(l.path, '_Meta')), roots: L2.map(l => l.path) });
  const tree = works.walkTree(LIB);
  plan = works.planWorks({ libraryPath: LIB, tree, meta });
  works.finalizeWorks(plan.works, { libraries: L2, libraryOf: libs.libraryOf });
  for (const w of plan.works) { w.attr = works.attributeWork(w, meta); if (w.attr.character) w.name = w.attr.character; }
  byKey = new Map(plan.works.map(w => [w.key, w]));
});
afterAll(() => { delete process.env.LIBRARY_LABELS; fs.rmSync(ROOT, { recursive: true, force: true }); });

const names = () => plan.works.map(w => w.name);
const variants = (w) => [...new Set(w.files.map(f => f.variant))].sort();

describe('libraries', () => {
  test('top-level folders are libraries with labels', () => {
    expect(L2.map(l => [l.folder, l.name])).toEqual([['3dPrint', 'Endor'], ['STL Archive', 'Dagobah']]);
    expect(libs.libraryOf(path.join(ENDOR, 'Wicked/x.zip'), L2)).toBe('Endor');
  });
});

describe('studio layout (identity, not folders)', () => {
  test('Endor Joker: extracted variant folders, Full Pieces, FIX zip → ONE card', () => {
    const w = byKey.get('B3DSERK|work|joker');
    expect(w).toBeTruthy();
    expect(w.name).toBe('Joker');
    expect(w.editions).toEqual(['Sculpture']);
    expect(variants(w)).toEqual(expect.arrayContaining(['images', 'one-piece', 'presupported-chitubox', 'presupported-stl', 'unsupported', 'x-pose']));
    expect(w.files.filter(f => f.abs.includes('/3dPrint/')).length).toBe(15);
    for (const bad of ['Full Pieces', 'Chain With Move', 'Upper Body', 'Base', 'Head']) expect(names()).not.toContain(bad);
  });
  test('the same zip on Dagobah is a backup copy on the same card', () => {
    const w = byKey.get('B3DSERK|work|joker');
    expect(w.libraries).toEqual(['Endor', 'Dagobah']);
    expect(w.folderPath).toBe(path.join(ENDOR, 'Wicked/DC/Joker'));
  });
  test('Sculpture and Bust of one character are editions of one card (typo "Capitain" merged)', () => {
    const w = byKey.get('Wicked|work|captain marvel');
    expect(w.editions).toEqual(['Sculpture', 'Bust']);
    expect(w.files).toHaveLength(4);
    expect(w.group).toBeNull(); // "Cap Marvel" is the character's own folder
  });
  test('Wicked Archive: Balrog / Gandalf cards, the diorama is its own card', () => {
    const balrog = byKey.get('Wicked|work|balrog');
    expect(balrog.editions).toEqual(['Sculpture', 'Bust']);
    expect(balrog.group).toBe('Lord of the Rings');
    expect(balrog.pathGenre).toBe('Movies');
    expect(balrog.files).toHaveLength(5);
    const gandalf = byKey.get('Wicked|work|gandalf');
    expect(gandalf.editions).toEqual(['Sculpture', 'Bust']);
    const dio = byKey.get('Wicked|diorama|gandalf balrog');
    expect(dio.kind).toBe('diorama');
    expect(dio.files.map(f => f.name).sort()).toEqual([
      'WICKED - DIORAMA BASE Gandalf & Balrog (Bridge_4_FIX).stl',
      'WICKED - DIORAMA BASE Gandalf & Balrog (Chitubox and STL Balrog Section).zip',
      'X_pose (1).stl', 'Xpose_Bridge_1.stl',
    ]);
    expect(names()).not.toContain('Gandalf and Balrog');
  });
  test('Drive multi-part zips: Legolas vs Troll diorama + Troll / Legolas busts', () => {
    expect(byKey.get('Wicked|diorama|legola troll').files).toHaveLength(2);
    expect(byKey.get('Wicked|work|troll').editions).toEqual(['Bust']);
    expect(byKey.get('Wicked|work|legola').editions).toEqual(['Bust']);
  });
  test('SW3D files in Wicked Archive/Star Wars belong to SW3D; blasters are an Accessory edition', () => {
    const w = byKey.get('SW3D|work|han solo');
    expect(w.files).toHaveLength(2);
    expect(w.editions).toEqual(['Accessory']);
  });
  test('Gumroad Downloads/<Creator>/<Genre>/<Product>: one Krampus card, attributed by manifest', () => {
    const w = byKey.get('Wicked|work|krampu');
    expect(w.editions).toEqual(['Sculpture', 'Bust']);
    expect(w.attr.genre).toBe('Movies');
    expect(w.attr.release_term).toBe('2025-12');
    expect(w.attr.attribution.confidence).toBe('exact');
    expect(w.attr.products.map(p => p.name).sort()).toEqual(['Wicked Movies December 2025 Term Krampus Portrait Bust', 'Wicked Movies December 2025 Term Krampus Sculpture']);
    const bust = w.attr.products.find(p => p.edition === 'Bust');
    expect(bust).toMatchObject({ matchedFiles: 1, totalFiles: 2, missing: ['Wicked - Krampus Portrait Bust (Images).zip'], libraryUrl: 'https://gumroad.com/d/krampusb' });
    expect(w.files.find(f => f.name === 'Wicked - Krampus Portrait Bust (Non Supported).zip')).toMatchObject({ matched_by: 'exact', product: 'Wicked Movies December 2025 Term Krampus Portrait Bust', variant: 'unsupported', edition: 'Bust', library: 'Dagobah' });
    expect(plan.works.some(x => x.creator === 'Gumroad Downloads' || x.name === 'Gumroad Downloads')).toBe(false);
  });
  test('ZEZ: lower-case names, typo, bonus bust filed under its own character', () => {
    const carnage = byKey.get('ZEZ|work|carnage');
    expect(carnage.files).toHaveLength(5);
    expect(carnage.editions).toEqual(['Bust']);
    expect(byKey.get('ZEZ|work|colossu').files).toHaveLength(3);
    const cable = byKey.get('ZEZ|work|cable');
    expect(cable.files.map(f => f.name).sort()).toEqual(['bust cable 1-6.zip', 'cable 1-6.zip']);
  });
  test('model.json sidecar is authoritative', () => {
    const w = plan.works.find(x => x.name === 'John Rambo');
    expect(w.attr.attribution.confidence).toBe('sidecar');
    expect(w.attr).toMatchObject({ genre: 'Movies', release_term: '2026-09', source: 'google-drive', sourceUrl: 'https://wickedart.gumroad.com/l/rambo' });
    expect(w.files.map(f => f.name)).toEqual(['John Rambo Sculpture.zip']);
    expect(plan.sidecars).toBe(1);
  });
  test('works sharing a folder get virtual "#slug" paths; realFolder() strips them', () => {
    const inFolder = plan.works.filter(w => works.realFolder(w.folderPath) === path.join(ENDOR, 'Wicked/DC/Batman 66 Dio'));
    expect(inFolder).toHaveLength(2);
    expect(inFolder.every(w => /#[a-z0-9-]+$/.test(w.folderPath))).toBe(true);
    expect(new Set(inFolder.map(w => w.folderPath)).size).toBe(2);
    expect(works.realFolder('/library/STL Archive/Epic Miniatures/#40 - Elven Grace')).toBe('/library/STL Archive/Epic Miniatures/#40 - Elven Grace');
  });
});

describe('lead review fixes', () => {
  test('A: the genre folder of a studio tree wins over the manifest; the disagreement is recorded', () => {
    const w = byKey.get('B3DSERK|work|alan scott');
    expect(w.attr.genre).toBe('DC');
    expect(w.attr.attribution.fields.franchise).toBe('path');
    expect(w.attr.attribution.conflicts).toEqual([{ field: 'franchise', pathValue: 'DC', metaValue: 'Star Wars' }]);
  });
  test('A: part names never name-match another product (root cause of "Alan Scott = Star Wars")', () => {
    const w = byKey.get('B3DSERK|work|alan scott');
    const cape = w.files.find(f => f.name === 'Cape_Full.stl');
    expect(cape.product).toBeNull();
    expect(w.attr.products.map(p => p.libraryUrl)).toEqual(['https://gumroad.com/d/alan']);
  });
  test('D: a group only when the work\'s own folder sits under it', () => {
    const w = byKey.get('Wicked|work|gizmo');
    expect(w.files).toHaveLength(2);
    expect(w.group).toBeNull(); // not "Spiderverse" from the misfiled copy
    expect(byKey.get('Wicked|work|balrog').group).toBe('Lord of the Rings');
  });
});

describe('release and folder layouts', () => {
  test('release items: scale/support folders are variants, term from the folder', () => {
    const w = plan.works.find(x => x.kind === 'release-item' && x.name === 'Bugbear Gladiator');
    expect(w).toBeTruthy();
    expect(w.termHint).toBe('2022-04');
    expect(w.attr.release_term).toBe('2022-04');
    expect(variants(w)).toEqual(['32mm-presupported-lychee', '32mm-supported', '32mm-unsupported', '75mm-supported', '75mm-unsupported']);
    expect(w.files).toHaveLength(6);
  });
  test('extraction copies (All_Busts_v2_2/All_Busts_v2) merge into one item', () => {
    const leo = plan.works.filter(x => /Leo Of Colossus/.test(x.name));
    expect(leo).toHaveLength(1);
    expect(leo[0].files).toHaveLength(2);
  });
  test('category-named items ("All Objects", "Env", "All Busts") take the pack or parent name', () => {
    const items = plan.works.filter(x => x.kind === 'release-item' && x.releaseLabel === 'Dwarven Forge').map(x => x.name).sort();
    expect(items.some(n => /^(all objects|env|all busts|objects|busts)$/i.test(n))).toBe(false);
    expect(items).toEqual(expect.arrayContaining(['Dwarven Forge Objects', 'Dwarven Forge Env']));
    expect(items.some(n => /^Dwarf King/.test(n))).toBe(true);
  });
  test('undated packs of a creator with dated releases are releases too', () => {
    const goblin = plan.works.find(x => x.name === 'Goblin');
    expect(goblin).toMatchObject({ kind: 'release-item', releaseLabel: 'Goblin Mines' });
    expect(goblin.attr.release_term).toBeNull();
    expect(variants(goblin)).toEqual(['32mm', '75mm']);
  });
  test('folder mode with the extended variant names: no "32mm"/"75mm" cards', () => {
    const moth = plan.works.find(x => x.kind === 'model' && x.name === 'Mothman');
    expect(moth.files).toHaveLength(2);
    expect(names().filter(n => /^(32mm|75mm|Supported|No Supports|Hollow|LYCHEE)$/i.test(n))).toEqual([]);
  });
  test('_Tools are tools; _Inbox, _Meta and _Duplicates_Pending_Delete are skipped', () => {
    expect(plan.works.filter(w => w.kind === 'tool').map(w => w.name)).toEqual(['Projects']);
    const all = plan.works.flatMap(w => w.files.map(f => f.abs));
    expect(all.some(f => /_Inbox|_Meta|_Duplicates_Pending_Delete/.test(f))).toBe(false);
  });
});

describe('helpers', () => {
  test('editDistance (Damerau) catches transpositions', () => {
    expect(works.editDistance('carange', 'carnage')).toBe(1);
    expect(works.editDistance('barlog', 'balrog')).toBe(1);
    expect(works.editDistance('batman', 'batgirl')).toBeGreaterThan(2);
  });
  test('releaseVariant', () => {
    expect(works.releaseVariant(['75mm', 'Supported', 'Hollow'])).toBe('75mm-supported');
    expect(works.releaseVariant(['1 9 Scale'])).toBe('1-9');
    expect(works.releaseVariant(['NoSupports'])).toBe('unsupported');
    expect(works.releaseVariant(['All_Enemies_Part1'])).toBe(null);
    expect(works.releaseVariant(['No Supports'])).toBe('unsupported');
  });
});
