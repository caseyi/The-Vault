// Cross-platform backend scan smoke test (macOS + Windows + Linux).
//
// Default mode: boots the backend with the current Node (the version we
// bundle), runs a real scan against a tiny fixture library, and asserts models
// get indexed. Written in Node (not bash) so there's no Git-Bash/Windows path
// translation to break.
//
// Container mode (used by docker-publish.yml before pushing an image):
//   SMOKE_BASE_URL=http://127.0.0.1:8585   talk to an already-running backend
//   SMOKE_FIXTURE_DIR=/tmp/fixture         where to create the fixture library
//                                          (mounted into the container)
//   SMOKE_SCAN_PATH=/library               path to scan, as the backend sees it
//   SMOKE_EXPECT_SHA=1a2b3c4               optional: assert /api/health gitSha
//
// Other knobs: SMOKE_NODE (node binary to run the backend with, e.g. the
// bundled runtime), SMOKE_BACKEND_DIR (backend folder, e.g. the staged copy).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const external = process.env.SMOKE_BASE_URL || '';
const backendDir = process.env.SMOKE_BACKEND_DIR
  ? path.resolve(process.env.SMOKE_BACKEND_DIR)
  : path.join(ROOT, 'backend');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsmoke-'));
const lib = process.env.SMOKE_FIXTURE_DIR ? path.resolve(process.env.SMOKE_FIXTURE_DIR) : path.join(tmp, 'lib');

fs.mkdirSync(path.join(lib, 'Studio A', 'Dragon Bust'), { recursive: true });
fs.mkdirSync(path.join(lib, 'Studio A', 'Knight'), { recursive: true });
fs.writeFileSync(path.join(lib, 'Studio A', 'Dragon Bust', 'dragon.stl'), 'solid x\nendsolid x\n');
fs.writeFileSync(path.join(lib, 'Studio A', 'Knight', 'knight.stl'), 'solid x\nendsolid x\n');

const PORT = 8585;
const base = external || `http://127.0.0.1:${PORT}`;
const scanPath = process.env.SMOKE_SCAN_PATH || lib;

let child = null;
let logbuf = '';
if (!external) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DB_PATH: path.join(tmp, 'data', 'vault.db'),
    IMAGES_DIR: path.join(tmp, 'data', 'images'),
    BACKUP_DIR: path.join(tmp, 'data', 'backups'),
    LIBRARY_PATH: lib,
  };
  const nodeBin = process.env.SMOKE_NODE || process.execPath;
  child = spawn(nodeBin, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: backendDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { logbuf += d; });
  child.stderr.on('data', d => { logbuf += d; });
  child.on('exit', code => { logbuf += `\n[backend exited with code ${code}]\n`; });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function done(code, msg) {
  if (msg) console.error(msg);
  if (code !== 0 && child) console.error('--- backend log ---\n' + logbuf);
  try { if (child) child.kill(); } catch {}
  process.exit(code);
}

(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(1000);
  }
  if (!up) return done(1, 'SMOKE FAIL: backend did not come up');
  const health = await (await fetch(base + '/api/health')).json();
  console.log('health:', JSON.stringify(health));
  if (process.env.SMOKE_EXPECT_SHA && health.gitSha !== process.env.SMOKE_EXPECT_SHA) {
    return done(1, `SMOKE FAIL: gitSha is ${health.gitSha}, expected ${process.env.SMOKE_EXPECT_SHA}`);
  }

  const sr = await fetch(base + '/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: scanPath, force: true }),
  });
  if (!sr.ok) return done(1, 'SMOKE FAIL: scan request failed ' + sr.status + ' ' + (await sr.text()));

  let finished = false;
  for (let i = 0; i < 60; i++) {
    let p = {};
    try { p = await (await fetch(base + '/api/scan/progress')).json(); } catch {}
    console.log('progress:', JSON.stringify(p));
    if (p.inProgress === false) { finished = true; break; }
    await sleep(1000);
  }
  if (!finished) return done(1, 'SMOKE FAIL: scan did not finish within 60s');

  let stats = {};
  try { stats = await (await fetch(base + '/api/stats')).json(); } catch {}
  console.log('stats:', JSON.stringify(stats));
  if (!stats.total || stats.total < 1) return done(1, 'SMOKE FAIL: no models indexed');
  console.log('SMOKE PASS');
  done(0);
})();
