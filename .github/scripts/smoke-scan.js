// Cross-platform backend scan smoke test (macOS + Windows + Linux).
// Boots the backend with the runner's Node (the version we bundle), runs a real
// scan against a tiny fixture library, and asserts models get indexed. Written
// in Node (not bash) so there's no Git-Bash/Windows path translation to break.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const backendDir = path.join(ROOT, 'backend');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultsmoke-'));
const lib = path.join(tmp, 'lib');

fs.mkdirSync(path.join(lib, 'Studio A', 'Dragon Bust'), { recursive: true });
fs.mkdirSync(path.join(lib, 'Studio A', 'Knight'), { recursive: true });
fs.writeFileSync(path.join(lib, 'Studio A', 'Dragon Bust', 'dragon.stl'), 'solid x\nendsolid x\n');
fs.writeFileSync(path.join(lib, 'Studio A', 'Knight', 'knight.stl'), 'solid x\nendsolid x\n');

const PORT = 8585;
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  PORT: String(PORT),
  DB_PATH: path.join(tmp, 'data', 'vault.db'),
  IMAGES_DIR: path.join(tmp, 'data', 'images'),
  LIBRARY_PATH: lib,
};

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: backendDir, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let logbuf = '';
child.stdout.on('data', d => { logbuf += d; });
child.stderr.on('data', d => { logbuf += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function done(code, msg) {
  if (msg) console.error(msg);
  if (code !== 0) console.error('--- backend log ---\n' + logbuf);
  try { child.kill(); } catch {}
  process.exit(code);
}

(async () => {
  let up = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(1000);
  }
  if (!up) return done(1, 'SMOKE FAIL: backend did not come up');
  console.log('health:', await (await fetch(base + '/api/health')).text());

  const sr = await fetch(base + '/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: lib, force: true }),
  });
  if (!sr.ok) return done(1, 'SMOKE FAIL: scan request failed ' + sr.status);

  for (let i = 0; i < 30; i++) {
    let p = {};
    try { p = await (await fetch(base + '/api/scan/progress')).json(); } catch {}
    console.log('progress:', JSON.stringify(p));
    if (p.inProgress === false) break;
    await sleep(1000);
  }

  let stats = {};
  try { stats = await (await fetch(base + '/api/stats')).json(); } catch {}
  console.log('stats:', JSON.stringify(stats));
  if (!stats.total || stats.total < 1) return done(1, 'SMOKE FAIL: no models indexed');
  console.log('SMOKE PASS');
  done(0);
})();
