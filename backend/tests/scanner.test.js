/**
 * Tests for scanner.js pure utility functions
 *
 * These test matchesHint, inferReleaseName, analyzeFolder, and pickRenderArchives
 * WITHOUT requiring the database (scanner.js's prepared statements are mocked).
 *
 * Run with: npx jest tests/scanner.test.js
 */

// Mock the db module completely — scanner.js compiles prepared statements at load time
jest.mock('../db', () => {
  const mockStmt = { run: () => ({}), get: () => null, all: () => [], bind: () => mockStmt };
  return {
    prepare: () => mockStmt,
    exec: () => {},
    transaction: (fn) => fn,
  };
});

const { matchesHint, pickRenderArchives, analyzeFolder, inferReleaseName, discoverModelFolders } = require('../scanner');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── matchesHint ──────────────────────────────────────────────────────────────

describe('matchesHint', () => {
  test('returns false for null/empty hint', () => {
    expect(matchesHint('renders.zip', null)).toBe(false);
    expect(matchesHint('renders.zip', '')).toBe(false);
  });

  test('exact match (case-insensitive)', () => {
    expect(matchesHint('Renders.zip', 'renders.zip')).toBe(true);
    expect(matchesHint('renders.zip', 'Renders.zip')).toBe(true);
    expect(matchesHint('other.zip', 'renders.zip')).toBe(false);
  });

  test('wildcard match with *', () => {
    expect(matchesHint('my_renders_pack.zip', '*render*')).toBe(true);
    expect(matchesHint('preview_images.zip', '*preview*')).toBe(true);
    expect(matchesHint('stl_files.zip', '*render*')).toBe(false);
  });

  test('comma-separated patterns', () => {
    expect(matchesHint('renders.zip', 'renders.zip, *preview*')).toBe(true);
    expect(matchesHint('preview_pack.zip', 'renders.zip, *preview*')).toBe(true);
    expect(matchesHint('stl_pack.zip', 'renders.zip, *preview*')).toBe(false);
  });

  test('wildcard at start only', () => {
    expect(matchesHint('renders.zip', '*.zip')).toBe(true);
    expect(matchesHint('renders.stl', '*.zip')).toBe(false);
  });

  test('wildcard at end only', () => {
    expect(matchesHint('renders.zip', 'renders*')).toBe(true);
    expect(matchesHint('other.zip', 'renders*')).toBe(false);
  });

  test('handles special regex characters in filename', () => {
    expect(matchesHint('file(1).zip', 'file(1).zip')).toBe(true);
  });
});

// ── inferReleaseName ─────────────────────────────────────────────────────────

describe('inferReleaseName', () => {
  test('strips bracket tags', () => {
    expect(inferReleaseName('[GroupTag] Some Release (Renders)')).toBe('Some Release (Renders)');
  });

  test('strips creator name prefix', () => {
    // Note: inferReleaseName strips file extensions first, so .2 is treated as ext
    expect(inferReleaseName('CreatorName_CoolPack_v1.2', 'CreatorName')).toBe('CoolPack v1');
    expect(inferReleaseName('CreatorName_CoolPack', 'CreatorName')).toBe('CoolPack');
  });

  test('replaces underscores with spaces', () => {
    expect(inferReleaseName('FDM_Supported_Files')).toBe('FDM Supported Files');
  });

  test('strips zip extension', () => {
    expect(inferReleaseName('renders.zip')).toBe('renders');
  });

  test('returns basename if stripping would empty it', () => {
    expect(inferReleaseName('CreatorName', 'CreatorName')).toBe('CreatorName');
  });

  test('handles complex names with dashes and underscores', () => {
    const result = inferReleaseName('Artist_Studio_Fantasy_Pack_v2', 'Artist Studio');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── pickRenderArchives ───────────────────────────────────────────────────────────

describe('pickRenderArchives', () => {
  const makeAnalysis = (zipNames, autoDetectedRenders = []) => ({
    files: zipNames.map(f => ({
      filename: f, filepath: `/fake/${f}`, ext: '.zip',
    })),
    renderArchives: autoDetectedRenders.map(f => `/fake/${f}`),
  });

  test('returns hinted ZIPs when hint matches', () => {
    const a = makeAnalysis(['renders.zip', 'stls.zip'], ['renders.zip']);
    expect(pickRenderArchives(a, 'renders.zip')).toEqual(['/fake/renders.zip']);
  });

  test('falls back to auto-detect when hint matches nothing', () => {
    const a = makeAnalysis(['pack1.zip', 'pack2.zip'], ['pack1.zip']);
    expect(pickRenderArchives(a, '*nonexistent*')).toEqual(['/fake/pack1.zip']);
  });

  test('returns auto-detected when no hint', () => {
    const a = makeAnalysis(['renders.zip', 'stls.zip'], ['renders.zip']);
    expect(pickRenderArchives(a, null)).toEqual(['/fake/renders.zip']);
  });

  test('returns multiple hinted matches', () => {
    const a = makeAnalysis(['renders1.zip', 'renders2.zip', 'stls.zip'], []);
    expect(pickRenderArchives(a, '*renders*').length).toBe(2);
  });
});

// ── analyzeFolder ────────────────────────────────────────────────────────────

describe('analyzeFolder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('detects STL files', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.stl'), 'fake stl');
    const r = analyzeFolder(tmpDir);
    expect(r.hasStl).toBe(true);
    expect(r.files.length).toBe(1);
    expect(r.files[0].filename).toBe('model.stl');
    expect(r.files[0].filepath).toBe(path.join(tmpDir, 'model.stl'));
  });

  test('detects slicer files', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.chitubox'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'model.lys'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.hasChitubox).toBe(true);
    expect(r.hasLychee).toBe(true);
  });

  test('detects images', () => {
    fs.writeFileSync(path.join(tmpDir, 'photo.png'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'pic.jpg'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.images.length).toBe(2);
  });

  test('skips @eaDir and other ignored folders', () => {
    const ea = path.join(tmpDir, '@eaDir');
    fs.mkdirSync(ea);
    fs.writeFileSync(path.join(ea, 'junk.stl'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'real.stl'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(1);
    expect(r.files[0].filename).toBe('real.stl');
  });

  test('skips #recycle folder', () => {
    const rec = path.join(tmpDir, '#recycle');
    fs.mkdirSync(rec);
    fs.writeFileSync(path.join(rec, 'deleted.stl'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(0);
  });

  test('handles subdirectories with release names', () => {
    const sub = path.join(tmpDir, 'FDM_Files');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'model.stl'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.releases.has('FDM Files')).toBe(true);
    expect(r.files[0].release_name).toBe('FDM Files');
  });

  test('returns empty result for nonexistent folder', () => {
    const r = analyzeFolder('/no/such/path/ever');
    expect(r.files.length).toBe(0);
    expect(r.hasStl).toBe(false);
  });

  test('detects render ZIPs by keyword', () => {
    fs.writeFileSync(path.join(tmpDir, 'renders_pack.zip'), 'fake');
    fs.writeFileSync(path.join(tmpDir, 'stl_files.zip'), 'fake');
    const r = analyzeFolder(tmpDir);
    expect(r.renderArchives.length).toBe(1);
    expect(path.basename(r.renderArchives[0])).toBe('renders_pack.zip');
  });

  test('detects "presentation" keyword in render archive name', () => {
    fs.writeFileSync(path.join(tmpDir, 'Group Presentation.zip'), 'fake');
    fs.writeFileSync(path.join(tmpDir, 'stl_files.zip'), 'fake');
    const r = analyzeFolder(tmpDir);
    expect(r.renderArchives.length).toBe(1);
    expect(path.basename(r.renderArchives[0])).toBe('Group Presentation.zip');
  });

  test('detects .rar render archives', () => {
    fs.writeFileSync(path.join(tmpDir, 'Group Presentation.rar'), 'fake');
    const r = analyzeFolder(tmpDir);
    expect(r.renderArchives.length).toBe(1);
    expect(path.basename(r.renderArchives[0])).toBe('Group Presentation.rar');
  });

  test('skips @SynoEAStream junk files', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.stl'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'model.stl@SynoEAStream'), 'junk');
    fs.writeFileSync(path.join(tmpDir, '._model.stl'), 'junk');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(1);
    expect(r.files[0].filename).toBe('model.stl');
  });

  test('skips @SynoEAStream files inside subdirectories', () => {
    const sub = path.join(tmpDir, 'STL_Files');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'arm.stl'), 'x');
    fs.writeFileSync(path.join(sub, 'arm.stl@SynoEAStream'), 'junk');
    fs.writeFileSync(path.join(sub, 'leg.stl@SynoResource'), 'junk');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(1);
    expect(r.files[0].filename).toBe('arm.stl');
  });

  test('finds files in deeply nested subfolders', () => {
    // Wicked archive/Weapons/Lukes lightsaber/files structure
    const lvl1 = path.join(tmpDir, 'Weapons');
    const lvl2 = path.join(lvl1, 'Lukes lightsaber');
    const lvl3 = path.join(lvl2, 'files');
    fs.mkdirSync(lvl3, { recursive: true });
    fs.writeFileSync(path.join(lvl3, 'saber_hilt.stl'), 'x');
    fs.writeFileSync(path.join(lvl3, 'saber_blade.stl'), 'y');
    fs.writeFileSync(path.join(lvl2, 'preview.png'), 'img');
    const r = analyzeFolder(tmpDir);
    expect(r.hasStl).toBe(true);
    expect(r.files.filter(f => f.ext === '.stl').length).toBe(2);
    expect(r.images.length).toBe(1);
  });

  test('skips @eaDir folders nested inside subdirectories', () => {
    const sub = path.join(tmpDir, 'STL_Files');
    const eaDir = path.join(sub, '@eaDir');
    fs.mkdirSync(eaDir, { recursive: true });
    fs.writeFileSync(path.join(sub, 'model.stl'), 'x');
    fs.writeFileSync(path.join(eaDir, 'model.stl@SynoEAStream'), 'junk');
    fs.writeFileSync(path.join(eaDir, 'SYNO_THUMB.jpg'), 'junk');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(1);
    expect(r.files[0].filename).toBe('model.stl');
  });

  test('handles mixed depth with junk files at every level', () => {
    const lvl1 = path.join(tmpDir, 'Characters');
    const lvl2 = path.join(lvl1, 'Gojira');
    fs.mkdirSync(lvl2, { recursive: true });
    fs.writeFileSync(path.join(lvl1, 'base.stl'), 'x');
    fs.writeFileSync(path.join(lvl1, '._base.stl'), 'junk');
    fs.writeFileSync(path.join(lvl2, 'head.stl'), 'y');
    fs.writeFileSync(path.join(lvl2, 'head.stl@SynoEAStream'), 'junk');
    fs.mkdirSync(path.join(lvl2, '@eaDir'));
    fs.writeFileSync(path.join(lvl2, '@eaDir', 'stuff'), 'junk');
    const r = analyzeFolder(tmpDir);
    const stls = r.files.filter(f => f.ext === '.stl');
    expect(stls.length).toBe(2);
    expect(stls.map(f => f.filename).sort()).toEqual(['base.stl', 'head.stl']);
  });

  test('assigns null release_name to loose non-zip files', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.stl'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.files[0].release_name).toBeNull();
  });

  test('records file sizes', () => {
    const content = 'A'.repeat(1000);
    fs.writeFileSync(path.join(tmpDir, 'big.stl'), content);
    const r = analyzeFolder(tmpDir);
    expect(r.files[0].size).toBe(1000);
  });

  test('handles nested subdirectories', () => {
    const sub1 = path.join(tmpDir, 'Supported');
    const sub2 = path.join(sub1, 'Resin');
    fs.mkdirSync(sub2, { recursive: true });
    fs.writeFileSync(path.join(sub2, 'model.stl'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.files.length).toBe(1);
    expect(r.files[0].release_name).toBe('Supported');
  });

  test('detects .3mf and .obj as STL type', () => {
    fs.writeFileSync(path.join(tmpDir, 'model.3mf'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'model.obj'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.hasStl).toBe(true);
    expect(r.files.length).toBe(2);
  });

  test('detects plate/gcode files', () => {
    fs.writeFileSync(path.join(tmpDir, 'print.gcode'), 'x');
    const r = analyzeFolder(tmpDir);
    expect(r.hasPlate).toBe(true);
  });
});

// ── discoverModelFolders ─────────────────────────────────────────────────────

describe('discoverModelFolders', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('flat structure: folders with STLs are models', () => {
    const m1 = path.join(tmpDir, 'Dragon');
    const m2 = path.join(tmpDir, 'Knight');
    fs.mkdirSync(m1); fs.mkdirSync(m2);
    fs.writeFileSync(path.join(m1, 'dragon.stl'), 'x');
    fs.writeFileSync(path.join(m2, 'knight.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(2);
    const names = results.map(r => r.name).sort();
    expect(names).toEqual(['Dragon', 'Knight']);
  });

  test('nested archive: recurses through category folders to find models', () => {
    // Wicked Archive / Star Wars / Vehicles / X-wing / x-wing.stl
    const xwing = path.join(tmpDir, 'Star Wars', 'Vehicles', 'X-wing');
    const luke = path.join(tmpDir, 'Star Wars', 'Characters', 'Luke');
    const dragon = path.join(tmpDir, 'Fantasy', 'Dragons');
    fs.mkdirSync(xwing, { recursive: true });
    fs.mkdirSync(luke, { recursive: true });
    fs.mkdirSync(dragon, { recursive: true });
    fs.writeFileSync(path.join(xwing, 'x-wing.stl'), 'x');
    fs.writeFileSync(path.join(luke, 'luke.stl'), 'x');
    fs.writeFileSync(path.join(dragon, 'dragon.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(3);
    const names = results.map(r => r.name).sort();
    expect(names).toEqual([
      'Fantasy / Dragons',
      'Star Wars / Characters / Luke',
      'Star Wars / Vehicles / X-wing',
    ]);
  });

  test('mixed: sibling model folder and category folder both discovered', () => {
    // Top level has one model folder with STLs and one category
    const directModel = path.join(tmpDir, 'Quick Print');
    const nested = path.join(tmpDir, 'Collection', 'SubModel');
    fs.mkdirSync(directModel);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(directModel, 'part.stl'), 'x');
    fs.writeFileSync(path.join(nested, 'model.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(2);
    const names = results.map(r => r.name).sort();
    expect(names).toEqual(['Collection / SubModel', 'Quick Print']);
  });

  test('mixed: folder with printable files AND subdirectories discovers both', () => {
    // Star Wars has ZIPs at its level AND sub-folders with their own models
    const starWars = path.join(tmpDir, 'Star Wars');
    const vehicles = path.join(starWars, 'Vehicles', 'X-wing');
    const chars = path.join(starWars, 'Characters', 'Luke');
    fs.mkdirSync(starWars, { recursive: true });
    fs.mkdirSync(vehicles, { recursive: true });
    fs.mkdirSync(chars, { recursive: true });
    // ZIPs directly in Star Wars
    fs.writeFileSync(path.join(starWars, 'bonus-pack.zip'), 'x');
    // STLs in nested model folders
    fs.writeFileSync(path.join(vehicles, 'x-wing.stl'), 'x');
    fs.writeFileSync(path.join(chars, 'luke.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(3);
    const names = results.map(r => r.name).sort();
    expect(names).toEqual([
      'Star Wars',
      'Star Wars / Characters / Luke',
      'Star Wars / Vehicles / X-wing',
    ]);
  });

  test('mixed: only parent has printable files, subdirs have images only', () => {
    // Parent has ZIPs, subdirs only have images — no double-counting
    const parent = path.join(tmpDir, 'MyModel');
    const sub = path.join(parent, 'Renders');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(parent, 'model.stl'), 'x');
    fs.writeFileSync(path.join(sub, 'render.jpg'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('MyModel');
  });

  test('skips @eaDir and junk files during discovery', () => {
    const real = path.join(tmpDir, 'Model');
    const junk = path.join(tmpDir, '@eaDir');
    fs.mkdirSync(real);
    fs.mkdirSync(junk);
    fs.writeFileSync(path.join(real, 'file.stl'), 'x');
    fs.writeFileSync(path.join(junk, 'data.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Model');
  });

  test('respects maxDepth limit', () => {
    // Create a structure deeper than maxDepth=2
    const deep = path.join(tmpDir, 'A', 'B', 'C', 'D');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'model.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 2);
    expect(results).toHaveLength(0); // Can't reach depth 4 with maxDepth 2
  });

  test('handles ZIP files as printable content', () => {
    const m = path.join(tmpDir, 'Pack');
    fs.mkdirSync(m);
    fs.writeFileSync(path.join(m, 'models.zip'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Pack');
  });

  test('empty folders and image-only folders are skipped', () => {
    const empty = path.join(tmpDir, 'Empty');
    const imgOnly = path.join(tmpDir, 'Images');
    fs.mkdirSync(empty);
    fs.mkdirSync(imgOnly);
    fs.writeFileSync(path.join(imgOnly, 'photo.jpg'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(0);
  });

  test('creator root with direct files uses basename as name', () => {
    // Files directly in the scanned dir (no subdirs)
    fs.writeFileSync(path.join(tmpDir, 'model.stl'), 'x');

    const results = discoverModelFolders(tmpDir, '', 5);
    expect(results).toHaveLength(1);
    expect(results[0].fullPath).toBe(tmpDir);
  });
});
