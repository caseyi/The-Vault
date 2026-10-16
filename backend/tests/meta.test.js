/**
 * lib/meta.js — _Meta loading and matching, with small fixtures modeled on the
 * real files in "STL Archive/_Meta" (Oct 2026): two manifests (the older one with
 * "Unknown Product" rows), the unclaimed tracker, tracker_claimed.tsv, the Drive
 * listing + links, filing_rules.csv and a genre_map.csv at the library root.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const metaLib = require('../lib/meta');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-meta-'));
const LIB = path.join(ROOT, 'STL Archive');
const META = path.join(LIB, '_Meta');
fs.mkdirSync(META, { recursive: true });

const U_ALAN = 'https://gumroad.com/d/f079aaaa';
const U_HAWK = 'https://gumroad.com/d/b3d5hawk';
const U_JP = 'https://gumroad.com/d/fae1c886';
const U_BUNDLE = 'https://gumroad.com/d/blackfriday';

const write = (name, body) => fs.writeFileSync(path.join(META, name), typeof body === 'string' ? body : JSON.stringify(body, null, 1));

write('gumroad_manifest.json', [
  { creator: 'Unknown', product_name: 'Unknown Product', download_url: U_ALAN, files: [] },
  { creator: 'B3DSERK Studios', product_name: 'B3DSERK June Term 2022: Hawkman Sculpture 1/6 ready for printing', download_url: U_HAWK,
    files: [
      { file_name: 'B3DSERK - Hawk Man Statue 350mm (One Piece)', extension: 'zip', file_size: 1500000 },
      { file_name: 'B3DSERK - Hawk Man Statue 350mm (X Pose)', extension: 'zip', file_size: 900000 },
    ] },
]);
write('gumroad_manifest_fresh.json', [
  { creator: 'Wicked', product_name: 'Wicked Movies Alan Grant Sculpture: Tested and ready for 3D printing', download_url: U_ALAN,
    files: [
      { file_name: 'Wicked - Alan Grant Sculpture (Non Supported)', extension: 'zip', file_size: 5000000 },
      { file_name: 'Wicked - Alan Grant Sculpture (Chitubox Pre Supported)', extension: 'zip', file_size: 6000000 },
      { file_name: 'Wicked - Alan Grant Sculpture (Size and Printing Information)', extension: 'txt', file_size: 2212 },
    ] },
  // the same product again (both manifests list it) — merged by download_url
  { creator: 'B3DSERK Studios', product_name: 'B3DSERK June Term 2022: Hawkman Sculpture 1/6 ready for printing', download_url: U_HAWK,
    files: [{ file_name: 'B3DSERK - Hawk Man Statue 350mm (One Piece)', extension: 'zip', file_size: 1500000 }] },
  { creator: 'Wicked', product_name: 'Wicked Movies Jurassic Park Diorama: Tested and ready for 3D printing ', download_url: U_JP,
    files: [{ file_name: 'Wicked - Jurassic Park Diorama (Non Supported)', extension: 'zip', file_size: 7000000 }] },
  // a bundle repeating a byte size: 7000000 is no longer unique
  { creator: 'Wicked', product_name: 'BLACK FRIDAY - Wicked 3D Models All Collection', download_url: U_BUNDLE,
    files: [{ file_name: 'Patreon All Collection', extension: 'zip', file_size: 7000000 }] },
]);
write('gumroad_manifest_broken.json', '{ not json');
write('gumroad_unclaimed_tracker.csv', [
  'Creator,Product,Status,First Seen,Last Seen,Code,URL',
  'Wicked,Alan Grant Sculpture,Claimed (Sep 10 2026),2026-03-01,2026-03-01,xyz,https://wickedart.gumroad.com/l/xyz',
  'B3DSERK,Vampirella Sculpture,Claimed (Sep 2 2026),2026-03-01,2026-03-01,9sws9r6,https://b3dserk.gumroad.com/l/VampirellaS/9sws9r6',
  'ZEZ,"Thor STL + BUST","Unclaimed - live (tier-gated, $15)",2026-09-01,2026-09-10,,https://www.patreon.com/zez/thor',
].join('\n'));
write('tracker_claimed.tsv', 'B3DSERK\tHawkman Sculpture\nB3DSERK\tVampirella Sculpture\n');
write('drive_links_all.csv', [
  'creator,label,url,email_date',
  'Wicked,GOOGLE DRIVE WICKED MOVIES JURASSIC PARK TERM 2026,https://drive.google.com/drive/folders/1SEi,2026-03-21',
  'Wicked,GOOGLE DRIVE WICKED MARVEL FEBRUARY TERM 2026,https://drive.google.com/drive/folders/1Yrr,2026-03-01',
].join('\n'));
write('drive_listing.csv', [
  'folder_id,creator,label,file_id,name,status',
  '1SEi,Wicked,GOOGLE DRIVE WICKED MOVIES JURASSIC PARK TERM 2026,f1,Alan Grant Sculpture/Wicked - Alan Grant Sculpture (Non Supported).zip,ok',
  '1SEi,Wicked,GOOGLE DRIVE WICKED MOVIES JURASSIC PARK TERM 2026,f2,Jurassic Park Diorama/Wicked - Jurassic Park Diorama (Non Supported).zip,ok',
  '1Yrr,Wicked,GOOGLE DRIVE WICKED MARVEL FEBRUARY TERM 2026,f3,Jean Gray Sculpture/Wicked - Jean Grey Sculpture (X Pose).zip,TRUNCATED',
].join('\n'));
write('filing_rules.csv', 'kind,key,value\nguess,superman,DC\nguess,red sonja,"Other Comics (Image:Top Cow: Dark horse, etc)"\nfix,tchala,t\'challa\n');
fs.writeFileSync(path.join(LIB, 'genre_map.csv'), 'character,genre\nAlan Grant,Movies\n');

let meta;
beforeAll(() => { meta = metaLib.loadMeta({ dirs: [META], roots: [LIB] }); });
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('loadMeta', () => {
  test('merges manifests by download_url; a real name replaces "Unknown Product"', () => {
    expect(meta.products).toHaveLength(4);
    const alan = meta.products.find(p => p.libraryUrl === U_ALAN);
    expect(alan).toMatchObject({ creator: 'Wicked', name: 'Wicked Movies Alan Grant Sculpture', genre: 'Movies', character: 'Alan Grant', edition: 'Sculpture' });
    const hawk = meta.products.find(p => p.libraryUrl === U_HAWK);
    expect(hawk.files).toHaveLength(2); // unioned, not duplicated
    expect(hawk).toMatchObject({ creator: 'B3DSERK', term: '2022-06', character: 'Hawkman' });
  });
  test('Drive: term from the label month, else from the email date', () => {
    const alan = meta.products.find(p => p.libraryUrl === U_ALAN);
    expect(alan.term).toBe('2026-03'); // label without month → email 2026-03-21
    expect(alan.termLabel).toBe('GOOGLE DRIVE WICKED MOVIES JURASSIC PARK TERM 2026');
    expect(metaLib.driveForFile(meta, 'Wicked - Jean Grey Sculpture (X Pose)-20260302T101010Z-3-001.zip')).toMatchObject({ term: '2026-02', genre: 'Marvel' });
    expect(metaLib.driveForStem(meta, 'Wicked', 'Jurassic Park', 'Diorama')).toMatchObject({ term: '2026-03' });
  });
  test('tracker → public URL / claimed / status by fuzzy product match', () => {
    const alan = meta.products.find(p => p.libraryUrl === U_ALAN);
    expect(alan).toMatchObject({ productUrl: 'https://wickedart.gumroad.com/l/xyz', claimed: '2026-03-01', status: 'Claimed (Sep 10 2026)' });
    expect(metaLib.trackerForStem(meta, 'B3DSERK', 'Vampirella', 'Sculpture').url).toMatch(/VampirellaS/);
    expect(meta.tracker.some(t => t.product === 'Hawkman Sculpture' && t.status === 'Claimed')).toBe(true);
  });
  test('status reports counts and file errors (never throws)', () => {
    const st = metaLib.metaStatus(meta);
    expect(st.counts).toMatchObject({ products: 4, tracker: 4, driveFiles: 3, genreMap: 1, rules: 3 });
    expect(st.counts.productFiles).toBe(7);
    expect(st.errors.some(e => /gumroad_manifest_broken\.json/.test(e))).toBe(true);
    expect(metaLib.loadMeta({ dirs: [path.join(ROOT, 'nope')] }).products).toEqual([]);
  });
});

describe('matching', () => {
  test('exact (name + size), unique size, name only', () => {
    expect(metaLib.matchFile(meta, 'Wicked - Alan Grant Sculpture (Non Supported).zip', 5000000)).toMatchObject({ by: 'exact' });
    // Drive copy: stamped name, same bytes
    expect(metaLib.matchFile(meta, 'Wicked - Alan Grant Sculpture (Non Supported)-20260321T183917Z-3-002.zip', 5000000)).toMatchObject({ by: 'exact' });
    // renamed on disk, same bytes → unique size
    expect(metaLib.matchFile(meta, 'alan grant chitu.zip', 6000000)).toMatchObject({ by: 'size', product: { libraryUrl: U_ALAN } });
    // re-uploaded (different size), same name
    expect(metaLib.matchFile(meta, 'Wicked - Alan Grant Sculpture (Non Supported).zip', 5000123)).toMatchObject({ by: 'name' });
  });
  test('part names (no studio prefix, no edition) never match on the name alone', () => {
    expect(metaLib.isDistinctiveName('Cape_Full.stl')).toBe(false);
    expect(metaLib.isDistinctiveName('R_Leg.stl')).toBe(false);
    expect(metaLib.isDistinctiveName('Wicked - Alan Grant Sculpture (Non Supported).zip')).toBe(true);
    expect(metaLib.isKnownGenre(meta, 'Other Comics (Image:Top Cow: Dark horse, etc)')).toBe(true);
    expect(metaLib.isKnownGenre(meta, 'Humblewood STLs')).toBe(false);
  });
  test('only unique byte sizes count; tiny files never size-match', () => {
    expect(metaLib.matchFile(meta, 'renamed.zip', 7000000)).toBeNull();
    expect(metaLib.matchFile(meta, 'readme.txt', 2212)).toBeNull();
  });
  test('stem (creator + character + edition) and genre rules', () => {
    expect(metaLib.productsForStem(meta, 'Wicked', 'Jurassic Park', 'Diorama').map(p => p.libraryUrl)).toEqual([U_JP]);
    expect(metaLib.productsForStem(meta, 'B3DSERK', 'Hawk Man', 'Sculpture').map(p => p.libraryUrl)).toEqual([U_HAWK]);
    expect(metaLib.genreForCharacter(meta, 'Alan Grant')).toEqual({ genre: 'Movies', by: 'genre_map' });
    expect(metaLib.genreForCharacter(meta, 'Superman')).toEqual({ genre: 'DC', by: 'rules' });
    expect(metaLib.genreForCharacter(meta, 'Red Sonja Classic')).toEqual({ genre: 'Other Comics (Image:Top Cow: Dark horse, etc)', by: 'rules' });
    expect(metaLib.genreForCharacter(meta, 'Superman Red Son')).toBeNull(); // organizer rule: one-word keys match whole names only
    expect(metaLib.genreForCharacter(meta, 'Batgirl')).toBeNull();
  });
  test('model.json sidecars', () => {
    const f = path.join(ROOT, 'model.json');
    fs.writeFileSync(f, JSON.stringify({ studio: 'Wicked', creator: 'SW3D', genre: 'Star Wars', character: 'HK-47', type: 'Sculpture', source: 'google-drive', claim_url: '', release_term: '2026-09' }));
    expect(metaLib.readSidecar(f)).toMatchObject({ creator: 'SW3D', character: 'HK-47', type: 'Sculpture', release_term: '2026-09', claim_url: null });
    fs.writeFileSync(f, 'nope');
    expect(metaLib.readSidecar(f)).toBeNull();
  });
});

describe('reviewer fixes: malformed _Meta, ambiguous matches (S2, S4)', () => {
  const R2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-meta2-'));
  const M2 = path.join(R2, '_Meta');
  fs.mkdirSync(M2, { recursive: true });
  const w2 = (name, body) => fs.writeFileSync(path.join(M2, name), typeof body === 'string' ? body : JSON.stringify(body));
  afterAll(() => fs.rmSync(R2, { recursive: true, force: true }));

  test('malformed manifests and vault.json never throw; bad entries are reported', () => {
    w2('gumroad_manifest.json', [
      { creator: 'Wicked', product_name: 'Wicked Movies Joker Sculpture', download_url: 'u-joker', files: {} },
      { creator: 'Wicked', product_name: 'Wicked Movies Bane Sculpture', download_url: 'u-bane', files: [null, { file_name: 'Wicked - Bane Sculpture (One Piece)', extension: 'zip', file_size: 4444444 }] },
      null, 7, 'x', { creator: 'Wicked', product_name: 42 },
      { creator: 'Wicked', product_name: 'Wicked Movies Zero Files' , download_url: 'u-zero', files: [] },
    ]);
    w2('gumroad_manifest_two.json', '{"products": 5}');
    w2('vault.json', '{"containers":5,"studioAliases":"x","libraryLabels":[1]}');
    let meta;
    expect(() => { meta = metaLib.loadMeta({ dirs: [M2], roots: [R2] }); }).not.toThrow();
    expect(meta.products.map(p => p.libraryUrl)).toEqual(['u-bane']); // Joker: no usable files; zero-file products dropped
    expect(meta.errors.some(e => /gumroad_manifest\.json: \d+ malformed/.test(e))).toBe(true);
    expect(meta.vault.containers).toBeUndefined();
    const st = metaLib.metaStatus(meta);
    expect(st.counts.products).toBe(1);
  });

  test('corrupt model.json is reported, not fatal', () => {
    const f = path.join(R2, 'model.json');
    fs.writeFileSync(f, '{"studio": ');
    const errors = [];
    expect(metaLib.readSidecar(f, errors)).toBeNull();
    fs.writeFileSync(f, '["not", "an object"]');
    expect(metaLib.readSidecar(f, errors)).toBeNull();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/model\.json/);
  });

  test('name+size hits in several products: the work\'s own stem decides, else no match', () => {
    w2('gumroad_manifest.json', [
      { creator: 'Wicked', product_name: 'Wicked Marvel Thor Sculpture', download_url: 'u-thor', files: [{ file_name: 'Base', extension: 'stl', file_size: 3000084 }, { file_name: 'Wicked - Thor Sculpture (One Piece)', extension: 'zip', file_size: 1234567 }] },
      { creator: 'Wicked', product_name: 'Wicked Marvel Loki Sculpture', download_url: 'u-loki', files: [{ file_name: 'Base', extension: 'stl', file_size: 3000084 }, { file_name: 'Wicked - Loki Sculpture (One Piece)', extension: 'zip', file_size: 7654321 }] },
    ]);
    fs.rmSync(path.join(M2, 'gumroad_manifest_two.json'), { force: true });
    const meta = metaLib.loadMeta({ dirs: [M2], roots: [R2] });
    expect(metaLib.matchFile(meta, 'Base.stl', 3000084)).toBeNull();
    expect(metaLib.matchFile(meta, 'Base.stl', 3000084, { creator: 'Wicked', character: 'Loki' }).product.libraryUrl).toBe('u-loki');
    expect(metaLib.matchFile(meta, 'Base.stl', 3000084, { creator: 'Wicked', character: 'Hulk' })).toBeNull();
  });

  test('size-only matches of loose .stl parts stay within the creator family', () => {
    const meta = metaLib.loadMeta({ dirs: [M2], roots: [R2] });
    // a unique size, but a loose part: not for another studio's file, nor without a creator
    expect(metaLib.matchFile(meta, 'Arm_L.stl', 3000084)).toBeNull();
    expect(metaLib.matchFile(meta, 'Torso.stl', 1234567, { creator: 'Loot Studios' })).toBeNull();
    expect(metaLib.matchFile(meta, 'Torso.stl', 1234567, { creator: 'Wicked' }).by).toBe('size');
    // archives still match on size alone (renamed downloads)
    expect(metaLib.matchFile(meta, 'renamed.zip', 1234567).product.libraryUrl).toBe('u-thor');
  });
});

test('a part name with a matching size from another studio is no match (S4)', () => {
  const R3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-meta3-'));
  fs.writeFileSync(path.join(R3, 'gumroad_manifest.json'), JSON.stringify([
    { creator: 'Star Wars 3D Models', product_name: 'Second Sister Bust - Star Wars 3D Models', download_url: 'u-ss', files: [{ file_name: 'Base', extension: 'stl', file_size: 2000084 }, { file_name: 'SW3D - Second Sister Bust', extension: 'zip', file_size: 5000001 }] },
  ]));
  const meta = metaLib.loadMeta({ dirs: [R3], roots: [] });
  expect(metaLib.matchFile(meta, 'Base.stl', 2000084, { creator: 'ArchVillian Games' })).toBeNull();
  expect(metaLib.matchFile(meta, 'Base.stl', 2000084, { creator: 'Star Wars 3D Models' }).by).toBe('exact');
  expect(metaLib.matchFile(meta, 'Base.stl', 2000084).by).toBe('exact'); // no work context: unchanged
  fs.rmSync(R3, { recursive: true, force: true });
});

test('one product under two download URLs is one product; typo stems still decide; the older file shape loads (S4)', () => {
  const R4 = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-meta4-'));
  const grundy = (url) => ({ creator: 'B3DSERK Studios', product_name: 'B3DSERK September term 2022: Grundy Sculpture', download_url: url,
    files: [{ file_name: 'B3DSERK - Solomon Grundy Statue 455mm (One Piece)', extension: 'zip', file_size: 174330534 }] });
  const sini = (n, url) => ({ creator: 'B3DSERK Studios', product_name: `B3DSERK May Term 2022: Siniestro ${n}`, download_url: url,
    files: [{ file_name: 'B3DSERK - Sinestro Bust 220mm (Images)', extension: 'zip', file_size: 62307120 }] });
  fs.writeFileSync(path.join(R4, 'gumroad_manifest.json'), JSON.stringify([
    grundy('u-g1'), grundy('u-g2'), sini('Bust', 'u-sb'), sini('Sculpture', 'u-ss'),
    { creator: 'Wicked', product_name: 'Wicked Movies T-Rex Portrait Bust', download_url: 'u-trex', files: [{ name: 'Wicked - T-Rex Bust (One Piece)', size: '283.6 MB', url: 'https://x' }] },
  ]));
  const meta = metaLib.loadMeta({ dirs: [R4], roots: [] });
  expect(meta.errors).toEqual([]);
  expect(metaLib.matchFile(meta, 'B3DSERK - Solomon Grundy Statue 455mm (One Piece).zip', 174330534, { creator: 'B3DSERK', character: 'Solomon Grundy' }).by).toBe('exact');
  expect(metaLib.matchFile(meta, 'B3DSERK - Sinestro Bust 220mm (Images).zip', 62307120, { creator: 'B3DSERK', character: 'Sinestro', edition: 'Bust' }).product.libraryUrl).toBe('u-sb');
  expect(metaLib.matchFile(meta, 'B3DSERK - Sinestro Bust 220mm (Images).zip', 62307120, { creator: 'B3DSERK', character: 'Batman' })).toBeNull();
  const trex = meta.products.find(p => p.libraryUrl === 'u-trex');
  expect(trex.files[0]).toMatchObject({ size: 0, approxSize: 297376154 });
  expect(metaLib.matchFile(meta, 'Wicked - T-Rex Bust (One Piece).zip', 297000000).by).toBe('name');
  fs.rmSync(R4, { recursive: true, force: true });
});
