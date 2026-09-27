/**
 * Variant-folder merge must never swallow folders that hold SEPARATE models.
 * Regression tests for layouts like Patreon releases:
 *   Studio/2024-05 Release/Pre-Supported/<Model A>/a.stl
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-vc-')));
process.env.DB_PATH = path.join(ROOT, 'data', 'vault.db');
process.env.IMAGES_DIR = path.join(ROOT, 'data', 'images');
process.env.LIBRARY_PATH = path.join(ROOT, 'lib');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const { discoverModelFolders } = require('../scanner');

function mk(rel) {
  const full = path.join(ROOT, 'lib', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'solid x\nendsolid x\n');
}
const rel = (r) => path.relative(path.join(ROOT, 'lib', 'Creator'), r.fullPath);
const discover = () => discoverModelFolders(path.join(ROOT, 'lib', 'Creator'), '', 5).map(rel).sort();

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(ROOT, 'lib'), { recursive: true, force: true }));

test('category with Resin/FDM folders full of models keeps every model', () => {
  mk('Creator/Busts/Resin/ModelA/a.stl');
  mk('Creator/Busts/Resin/ModelB/b.stl');
  mk('Creator/Busts/FDM/ModelA/a.stl');
  mk('Creator/Busts/FDM/ModelB/b.stl');
  expect(discover()).toEqual(['Busts/FDM/ModelA', 'Busts/FDM/ModelB', 'Busts/Resin/ModelA', 'Busts/Resin/ModelB'].map(p => p.split('/').join(path.sep)));
});

test('release folder with loose file and Supported/<models> keeps nested models', () => {
  mk('Creator/Rel/bonus.stl');
  mk('Creator/Rel/Supported/X/a.stl');
  mk('Creator/Rel/Supported/Y/a.stl');
  expect(discover()).toEqual(['Rel', 'Rel/Supported/X', 'Rel/Supported/Y'].map(p => p.split('/').join(path.sep)));
});

test('Patreon-style release: Pre-Supported/<Model> folders stay separate', () => {
  mk('Creator/2024-05 Release/Pre-Supported/Knight/knight.stl');
  mk('Creator/2024-05 Release/Pre-Supported/Dragon/dragon.stl');
  mk('Creator/2024-05 Release/Unsupported/Knight/knight.stl');
  const found = discover();
  expect(found).toHaveLength(3);
  expect(found.every(f => /Knight|Dragon/.test(f))).toBe(true);
});

test('real variant layout still merges into one model', () => {
  mk('Creator/Mandalorian Bust/FDM/bust.stl');
  mk('Creator/Mandalorian Bust/Resin/bust.stl');
  mk('Creator/Mandalorian Bust/Supported/STL/bust.stl');
  const r = discoverModelFolders(path.join(ROOT, 'lib', 'Creator'), '', 5);
  expect(r).toHaveLength(1);
  expect(rel(r[0])).toBe('Mandalorian Bust');
  expect(r[0].variantDirs.sort()).toEqual(['FDM', 'Resin', 'Supported']);
});
