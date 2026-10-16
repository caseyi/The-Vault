/**
 * lib/naming.js — studio identity parser (docs/library-metadata.md §4).
 * Every input below is a REAL file or folder name from the Oct 2026 NAS inventories
 * (shadow/inv/*.txt) or the Drive listing in _Meta: Drive stamps, part suffixes,
 * every variant spelling seen, B3DSERK / SW3D / ZEZ naming, accessories, dioramas, typos.
 */
const n = require('../lib/naming');

// [name, creator, edition, variant, character ('' = generic: never an identity)]
const CASES = [
  ["Wicked - Legolas Vs Troll Diorama (Lite Version) - (Stl Pre Supported) Update-003.zip", "Wicked", "Diorama", "presupported-stl", "Legolas vs Troll"],
  ["WICKED - Legolas Vs Troll Diorama (Lite Version)-20260603T170306Z-3-004.zip", "Wicked", "Diorama", null, "Legolas vs Troll"],
  ["WICKED - Troll Portrait Bust-20260603T170308Z-3-002.zip", "Wicked", "Bust", null, "Troll"],
  ["WICKED - Legolas Portrait Bust-20260603T170302Z-3-001.zip", "Wicked", "Bust", null, "Legolas"],
  ["WICKED - Balrog Statue 863.63mm (Chitubox Pre Supported)_2.zip", "Wicked", "Sculpture", "presupported-chitubox", "Balrog"],
  ["WICKED - Balrog Statue 863.63mm (STL Pre Supported) .zip", "Wicked", "Sculpture", "presupported-stl", "Balrog"],
  ["WICKED - Barlog Statue 863.63mm (One Piece)_2.zip", "Wicked", "Sculpture", "one-piece", "Balrog"],
  ["WICKED - Balrog Scculture Images.zip", "Wicked", "Sculpture", "images", "Balrog"],
  ["WICKED - Gandalf Statue 459.31 mm (One Piece) (1).zip", "Wicked", "Sculpture", "one-piece", "Gandalf"],
  ["WICKED - DIORAMA BASE Gandalf & Balrog (Chitubox and STL Balrog Section)_2.zip", "Wicked", "Diorama", "presupported-chitubox", "Gandalf & Balrog"],
  ["Xpose Diorama Base Gandalf & Barlog", null, "Diorama", "x-pose", "Gandalf & Balrog"],
  ["WICKED - Ken Bust 345mm (One Piee).zip", "Wicked", "Bust", "one-piece", "Ken"],
  ["WICKED - Capitain Marvel 310mm (X Pose).zip", "Wicked", null, "x-pose", "Captain Marvel"],
  ["WICKED - Capitain Marvel Statue 310mm (Pre Supported Chitubox).zip", "Wicked", "Sculpture", "presupported-chitubox", "Captain Marvel"],
  ["WICKED - Captain Marvel Bust 265mm (Pre Supported STL).zip", "Wicked", "Bust", "presupported-stl", "Captain Marvel"],
  ["Wicked - Green Goblin Statue 497mm - Presupported (Chitubox).zip", "Wicked", "Sculpture", "presupported-chitubox", "Green Goblin"],
  ["Wicked - Green Goblin Statue Xpose.zip", "Wicked", "Sculpture", "x-pose", "Green Goblin"],
  ["Wicked - Green Goblin Bust 275mm PreSupported (STL).zip", "Wicked", "Bust", "presupported-stl", "Green Goblin"],
  ["Wicked - Green Goblin Sculpture Images.zip", "Wicked", "Sculpture", "images", "Green Goblin"],
  ["Wicked_Marvel_Hulk_3d_Bust-_Avengers_STL_ready_for_printing.zip", "Wicked", "Bust", null, "Hulk Avengers"],
  ["150520 Wicked - Hulk STL_2.zip", "Wicked", null, null, "Hulk"],
  ["WICKED - Diorama Daredevil & Kingpin 548mm (Renders).zip", "Wicked", "Diorama", "images", "Daredevil & Kingpin"],
  ["WICKED - Kingpin and Daredevil Diorama Sculpture (Size).txt", "Wicked", "Diorama", "info", "Kingpin and Daredevil"],
  ["WICKED - Diorama Daredevil (R_Boot_FIX).zip", "Wicked", "Diorama", null, "Daredevil"],
  ["Xpose Diorama Base DareDevil & Kingpin.zip", null, "Diorama", "x-pose", "DareDevil & Kingpin"],
  ["Wicked - Krampus Portrait Bust (Non Supported).zip", "Wicked", "Bust", "unsupported", "Krampus"],
  ["WICKED - Krampus Portrait Bust (Size).txt", "Wicked", "Bust", "info", "Krampus"],
  ["Wicked - Moon Knight Bust Portrait (Images).zip", "Wicked", "Bust", "images", "Moon Knight"],
  ["Wicked - MoonKnight Sculpture (Images).zip", "Wicked", "Sculpture", "images", "Moon Knight"],
  ["WICKED - Turboman Torso Bust For Statue (STL Only).zip", "Wicked", "Sculpture", null, "Turboman"],
  ["WICKED - Turboman Torso Bust For Statue (Chitubox & STL Pre Supported).zip", "Wicked", "Sculpture", "presupported-chitubox", "Turboman"],
  ["Wicked - Emma Frost Bust 300mm (Chitubox Pre Supproted).zip", "Wicked", "Bust", "presupported-chitubox", "Emma Frost"],
  ["Wicked - Emma Frost Statue 420mm (One Piece) - Update.zip", "Wicked", "Sculpture", "one-piece", "Emma Frost"],
  ["WICKED - Spider Woman Statue (506mm with small base and 645.66mm with big base) (X Pose).zip", "Wicked", "Sculpture", "x-pose", "Spider Woman"],
  ["WICKED - Spider Woman Bust 260mm (Measures).txt", "Wicked", "Bust", "info", "Spider Woman"],
  ["Update - WICKED - Red Skull Statue 435mm (Non Supported).zip", "Wicked", "Sculpture", "unsupported", "Red Skull"],
  ["WICKED - Red Skull Bust Torso For Statue (STL Only) - FIX.zip", "Wicked", "Sculpture", null, "Red Skull"],
  ["Wicked - Spiderman Statue 424mm Non Supported (Update).zip", "Wicked", "Sculpture", "unsupported", "Spiderman"],
  ["Wicked - HulkBuster Bust 385 mm Presupported (Chitubox).zip", "Wicked", "Bust", "presupported-chitubox", "HulkBuster"],
  ["WICKED - Iron Man Statue 409.31mm (Info).zip", "Wicked", "Sculpture", "info", "Iron Man"],
  ["Wicked - Drax Bust Images.zip", "Wicked", "Bust", "images", "Drax"],
  ["Wicked - Drax Bust 300mm Non Supported.zip", "Wicked", "Bust", "unsupported", "Drax"],
  ["WICKED - Tony Stark Statue 380mm (X_Pose).zip", "Wicked", "Sculpture", "x-pose", "Tony Stark"],
  ["Wicked - Jean Grey Sculpture (Stl Pre Supported).zip", "Wicked", "Sculpture", "presupported-stl", "Jean Grey"],
  ["Wicked - Quick Silver Bust Portrait (Images).zip", "Wicked", "Bust", "images", "Quicksilver"],
  ["Wicked - Gipsy Danger Portrait Bust (Non Supported).zip", "Wicked", "Bust", "unsupported", "Gipsy Danger"],
  ["Wicked - Clint Barton Ronin Second Torso for Sculpture (One Piece).zip", "Wicked", "Sculpture", "one-piece", "Clint Barton Ronin"],
  ["WICKED - Alien Warrior Statue 377,14mm (Chitubox Pre Supported).zip", "Wicked", "Sculpture", "presupported-chitubox", "Alien Warrior"],
  ["WICKED - DIORAMA BASE Aliens (X pose) (1).zip", "Wicked", "Diorama", "x-pose", "Aliens"],
  ["Aliens DIORAMA COMPLETE", null, "Diorama", null, "Aliens"],
  ["B3DSERK - Joker Statue 421mm (Pre Support Chitubox).zip", "B3DSERK", "Sculpture", "presupported-chitubox", "Joker"],
  ["B3DSERK - Joker Statue 421mm (Renders)_2.zip", "B3DSERK", "Sculpture", "images", "Joker"],
  ["B3DSERK_Talon Sculpture 435 mm (OnePiece).zip", "B3DSERK", "Sculpture", "one-piece", "Talon"],
  ["B3DSERK_Talon Sculpture 435 mm (PreSupported_Chitubox).zip", "B3DSERK", "Sculpture", "presupported-chitubox", "Talon"],
  ["B3DSERK June Term - Mr.Freeze Sculpture (435 mm) Non Supported.zip", "B3DSERK", "Sculpture", "unsupported", "Mr Freeze"],
  ["B3DSERK - Hawk Man Statue 350mm Non Supported- (Update 01-12-23).zip", "B3DSERK", "Sculpture", "unsupported", "Hawk Man"],
  ["B3DSERK Constantine - Bust (5 pieces) updated.zip", "B3DSERK", "Bust", null, "Constantine"],
  ["B3DSERK - Green Lantern Statue Jhon Stewart Torso Bust For Sculpture 400mm (Non Supported and One Piece).zip", "B3DSERK", "Sculpture", "unsupported", "Green Lantern John Stewart"],
  ["B3DSERK - Wonder Woman Bust 210mm - Pre Supported Chitubox.zip", "B3DSERK", "Bust", "presupported-chitubox", "Wonder Woman"],
  ["B3DSERK- Power Girl Statue 315mm (X pose).zip", "B3DSERK", "Sculpture", "x-pose", "Power Girl"],
  ["B3dserk - Batman Beyond Portrait Bust (Chitubox Pre Supported).zip", "B3DSERK", "Bust", "presupported-chitubox", "Batman Beyond"],
  ["B3DSERK Batmanand Robin Diorama (X Pose).zip", "B3DSERK", "Diorama", "x-pose", "Batman and Robin"],
  ["B3DSERK - Batman 1966 Torso For Bust (STL Only - With or Without Cape).zip", "B3DSERK", "Bust", null, "Batman 1966"],
  ["B3DSERK - Diorama Base Batman & Robin (STL Pre Supported).zip", "B3DSERK", "Diorama", "presupported-stl", "Batman & Robin"],
  ["B3dserk - Jor-El Ship (One Piece).zip", "B3DSERK", "Accessory", "one-piece", "Jor-El"],
  ["B3DSERK - Star Saphire Bust (Size).txt", "B3DSERK", "Bust", "info", "Star Sapphire"],
  ["Aurra Sing Bust - Star Wars 3D Modes - 32 cm - 11 parts.zip", "SW3D", "Bust", null, "Aurra Sing"],
  ["Aurra Sing Sculpture - Pre Supports - 50--100- - Star Wars 3D Models.zip", "SW3D", "Sculpture", "presupported-stl", "Aurra Sing"],
  ["Aurra Sing Bust Images.zip", null, "Bust", "images", "Aurra Sing"],
  ["Mandalorian Sculpture - Star Wars 3D Models -30 cm - 44 parts", "SW3D", "Sculpture", null, "Mandalorian"],
  ["Han Solo Blaster - Pres Support - 50%-100%.zip", null, "Accessory", "presupported-stl", "Han Solo"],
  ["Renders Han Solo Blaster", null, "Accessory", "images", "Han Solo"],
  ["Diorama_Base-_Mandalorian_and_Boba_Fett_Star_Wars_3D_Models_-_Tested_and_Ready_for_3D_printing.zip", "SW3D", "Diorama", null, "Mandalorian and Boba Fett"],
  ["Sw3d - Hera Syndulla Blaster Bust (Stl Pre Supporte).zip", "SW3D", "Accessory", "presupported-stl", "Hera Syndulla"],
  ["SW3D - HK47 Droid Sculpture (Non Supported).zip", "SW3D", "Sculpture", "unsupported", "HK47 Droid"],
  ["SW3D - DT-12 Greedo Blaster (One Piece).zip", "SW3D", "Accessory", "one-piece", "DT-12 Greedo"],
  ["carnage 1-6.zip", null, null, null, "Carnage"],
  ["carnage bust (1).zip", null, "Bust", null, "Carnage"],
  ["carange render.zip", null, null, "images", "Carnage"],
  ["COLOSSUS PRESUPPORTS.zip", null, null, "presupported-stl", "Colossus"],
  ["bust cable 1-6.zip", null, "Bust", null, "Cable"],
  ["1-4 Colossus stl.zip", null, null, null, "Colossus"],
  ["presuport 1-12.zip", null, null, "presupported-stl", ""],
  ["MOVIES August Term 2024-20241001T212825Z-003.zip", null, null, null, ""],
  ["Sculptures and Busts", null, "Bust", null, ""],
  ["Full Pieces", null, null, null, ""],
  ["Upper body", null, null, null, ""],
  ["100", null, null, null, ""],
  ["32mm", null, null, null, ""],
  ["Images", null, null, "images", ""],
  ["Mandalorian Sculpture - Pre Supports - 50- - 100- - Star Wars 3D Models.zip", "SW3D", "Sculpture", "presupported-stl", "Mandalorian"],
  ["Mandalorian Sculpture - Star Wars 3D Models -30 cm - 44 parts_2.zip", "SW3D", "Sculpture", null, "Mandalorian"],
  ["Wicked - Masterchief Sculpture (Non Supported).zip", "Wicked", "Sculpture", "unsupported", "Master Chief"],
  ["WICKED - Cyclops Sculpture (X Pose)_ADMIN_Apr-12-160754-2026_Conflict.zip", "Wicked", "Sculpture", "x-pose", "Cyclops"],
  ["Wicked - Iron Patriot Sculpture SOLID BASE.zip", "Wicked", "Sculpture", null, "Iron Patriot"],
  ["Wings Full Vulture Bust 400mm.zip", null, "Bust", null, "Vulture"],
  ["One Piece - Upper Body - Lowe Body Joker FIX.zip", null, null, "one-piece", "Joker"],
  ["Wicked -February diorama Iron Patriot + Rocket base STL.zip", "Wicked", "Diorama", null, "Iron Patriot + Rocket"],
];

describe('parseName — real names', () => {
  test('the table is big enough to matter', () => expect(CASES.length).toBeGreaterThanOrEqual(60));
  test.each(CASES)('%s', (name, creator, edition, variant, character) => {
    const p = n.parseName(name);
    expect(p.creator).toBe(creator);
    expect(p.edition).toBe(edition);
    expect(p.variant).toBe(variant);
    expect(p.character).toBe(character);
    expect(p.generic).toBe(character === '');
  });
});

describe('cleanStem', () => {
  test.each([
    ['WICKED - Legolas Vs Troll Diorama (Lite Version)-20260603T170306Z-3-004.zip', 'WICKED - Legolas Vs Troll Diorama (Lite Version)'],
    ['Wicked - Legolas Vs Troll Diorama (Chitubox Pre Supported)-004.zip', 'Wicked - Legolas Vs Troll Diorama (Chitubox Pre Supported)'],
    ['WICKED - Balrog Statue 863.63mm (Chitubox Pre Supported)_2.zip', 'WICKED - Balrog Statue 863.63mm (Chitubox Pre Supported)'],
    ['WICKED - Gandalf Statue 459.31 mm (One Piece) (1).zip', 'WICKED - Gandalf Statue 459.31 mm (One Piece)'],
    ['MOVIES August Term 2024-20241001T212825Z-003.zip', 'MOVIES August Term 2024'],
    ['WICKED - Cyclops Sculpture (X Pose)_ADMIN_Apr-12-160754-2026_Conflict.zip', 'WICKED - Cyclops Sculpture (X Pose)'],
  ])('%s', (raw, clean) => expect(n.cleanStem(raw)).toBe(clean));
});

describe('variants: Chitubox / X Pose / One Piece / Non Supported are variants of ONE work', () => {
  const same = [
    'Wicked - Krampus Portrait Bust (Non Supported).zip',
    'Wicked - Krampus Portrait Bust (One Piece).zip',
    'Wicked - Krampus Portrait Bust (Chitubox Pre Supported).zip',
    'Wicked - Krampus Portrait Bust (Stl Pre Supported).zip',
    'Wicked - Krampus Portrait Bust (X Pose).zip',
    'Wicked - Krampus Portrait Bust (Images).zip',
    'WICKED - Krampus Portrait Bust (Size).txt',
  ];
  test('same key and edition, all different variants', () => {
    const ps = same.map(x => n.parseName(x));
    expect(new Set(ps.map(p => p.key)).size).toBe(1);
    expect(new Set(ps.map(p => p.edition))).toEqual(new Set(['Bust']));
    expect(ps.map(p => p.variant)).toEqual(['unsupported', 'one-piece', 'presupported-chitubox', 'presupported-stl', 'x-pose', 'images', 'info']);
  });
  test('typo-level keys meet (Capitain/Captain, Barlog/Balrog, Masterchief/Master Chief)', () => {
    expect(n.parseName('WICKED - Capitain Marvel Statue 310mm (Pre Supported Chitubox).zip').key).toBe(n.parseName('WICKED - Captain Marvel Bust 265mm (Pre Supported STL).zip').key);
    expect(n.parseName('WICKED - Barlog Statue 863.63mm (One Piece)_2.zip').key).toBe('balrog');
    expect(n.compactKey('Masterchief')).toBe(n.compactKey('Master Chief'));
    expect(n.normKey('Daredevil & Kingpin')).toBe(n.normKey('Daredevil and Kingpin'));
  });
});

describe('product names (Gumroad manifest)', () => {
  test.each([
    ['Wicked Marvel March 2026 Term Conan The Barbarian Sculpture: Tested and ready for 3D printing', 'Wicked', 'Wicked', 'Marvel', '2026-03', 'Conan the Barbarian', 'Sculpture'],
    ['Wicked Movies Jurassic Park Diorama: Tested and ready for 3D printing ', 'Wicked', 'Wicked', 'Movies', null, 'Jurassic Park', 'Diorama'],
    ['Wicked Marvel November 2025 Term Carnage 2025 Portrait Bust: Tested and ready for 3D printing', 'Wicked', 'Wicked', 'Marvel', '2025-11', 'Carnage 2025', 'Bust'],
    ['B3DSERK June Term 2022: Hawkman Sculpture 1/6 ready for printing', 'B3DSERK Studios', 'B3DSERK', null, '2022-06', 'Hawkman', 'Sculpture'],
    ['B3DSERK December term 2023: Jhon Stewart Sculpture ready for printing', 'B3DSERK Studios', 'B3DSERK', null, '2023-12', 'John Stewart', 'Sculpture'],
    ['Mandalorian Sculpture - Star Wars 3D Models - Tested and Ready for 3D printing', 'Star Wars 3D Models', 'SW3D', 'Star Wars', null, 'Mandalorian', 'Sculpture'],
    ['Wicked WILDCARD Movies Term Troll Portrait Bust: Tested and ready for 3D printing', 'Wicked', 'Wicked', 'Movies', null, 'Troll', 'Bust'],
    ['AQUAMAN STL + BUST', 'ZEZ COLLECTIBLES PATREON', 'ZEZ', null, null, 'Aquaman', null],
  ])('%s', (name, mc, creator, genre, term, character, edition) => {
    const p = n.parseProductName(name, mc);
    expect([p.creator, p.genre, p.term, p.character, p.edition]).toEqual([creator, genre, term, character, edition]);
  });
});

describe('Drive labels, releases, term folders', () => {
  test('drive labels', () => {
    expect(n.parseDriveLabel('GOOGLE DRIVE WICKED MARVEL FEBRUARY TERM 2026')).toMatchObject({ creator: 'Wicked', genre: 'Marvel', month: 2, year: 2026 });
    expect(n.parseDriveLabel('GOOGLE DRIVE WICKED MOVIES KARATE KID TERM 2026')).toMatchObject({ creator: 'Wicked', genre: 'Movies', month: null, franchise: 'Karate Kid' });
    expect(n.parseDriveLabel('GOOGLE DRIVE BEDSERK SEPTEMBER TERM 2026')).toMatchObject({ creator: 'B3DSERK', month: 9 });
    expect(n.parseDriveLabel('GOOGLE DRIVE WICKED VIDEO GAMES SAMUS TERM 2026')).toMatchObject({ genre: 'Video Games', franchise: 'Samus' });
  });
  test('release folders', () => {
    expect(n.parseRelease('2022-04 - Crimson Sand Arena')).toEqual({ term: '2022-04', label: 'Crimson Sand Arena', number: null });
    expect(n.parseRelease('#40 - Elven Grace')).toEqual({ term: null, label: 'Elven Grace', number: 40 });
    expect(n.parseRelease('Archvillain Games - Archvillain Society Vol. XI')).toMatchObject({ term: null });
    expect(n.parseRelease('Goblin Mines')).toBeNull();
  });
  test('term folders are transparent', () => {
    expect(n.parseTermFolder('MOVIES August Term 2024')).toEqual({ term: '2024-08', genre: 'Movies' });
    expect(n.parseTermFolder('Aug 2024')).toEqual({ term: '2024-08', genre: null });
    expect(n.parseName('MOVIES June Term 2024').generic).toBe(true);
  });
  test('filing_rules fix rows extend the seed typo fixes', () => {
    const fix = n.makeFixer({ 'tchala': "t'challa" });
    expect(n.parseName('Wicked - Tchala Bust.zip', { fix }).character).toBe("T'challa");
  });
});
