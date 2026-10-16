'use strict';
/**
 * lib/backup.js — SQLite snapshots with `VACUUM INTO`.
 *
 *   vault-YYYYMMDD.db                    daily (kept: BACKUP_KEEP, default 7)
 *   vault-pre-forcescan-<stamp>.db       before a forced rescan (newest 10 kept)
 *   vault-pre-update-<stamp>.db          written by update.sh (newest 10 kept)
 *
 * snapshot() never throws — a failed backup is logged, not fatal.
 */
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000; // check hourly whether today's snapshot exists
const KEEP_EVENT = 10;

function dbPath() { return process.env.DB_PATH || '/data/vault.db'; }
function backupDir() { return process.env.BACKUP_DIR || path.join(path.dirname(dbPath()), 'backups'); }
function keepDaily() {
  const n = parseInt(process.env.BACKUP_KEEP, 10);
  return Number.isFinite(n) && n >= 1 ? n : 7;
}

const pad = (n) => String(n).padStart(2, '0');
function dayStamp(d = new Date()) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function timeStamp(d = new Date()) { return `${dayStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

function dailyFile(d = new Date()) { return path.join(backupDir(), `vault-${dayStamp(d)}.db`); }

/**
 * Write a snapshot. label 'daily' → vault-YYYYMMDD.db (skipped if it already
 * exists); any other label → vault-<label>-<timestamp>.db.
 * @returns {string|null} the file written, or null on failure/skip.
 */
function snapshot(label = 'daily', { db, log = console } = {}) {
  try {
    const conn = db || require('../db');
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = String(label).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'manual';
    let file = safeLabel === 'daily' ? dailyFile() : path.join(dir, `vault-${safeLabel}-${timeStamp()}.db`);
    if (safeLabel === 'daily' && fs.existsSync(file)) return null;
    if (fs.existsSync(file)) file = file.replace(/\.db$/, `-${process.pid}-${Date.now()}.db`);
    conn.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    log.log?.(`[backup] wrote ${file}`);
    prune({ log });
    return file;
  } catch (e) {
    (log.error || console.error)(`[backup] snapshot "${label}" failed: ${e.message}`);
    return null;
  }
}

/** Keep BACKUP_KEEP daily files and the newest 10 of each event type. Never throws. */
function prune({ log = console } = {}) {
  try {
    const dir = backupDir();
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const remove = (n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { (log.error || console.error)(`[backup] could not delete ${n}: ${e.message}`); } };

    const daily = names.filter(n => /^vault-\d{8}\.db$/.test(n)).sort().reverse();
    daily.slice(keepDaily()).forEach(remove);

    const groups = new Map();
    for (const n of names) {
      const m = n.match(/^vault-(pre-[a-z-]+?)-\d.*\.db$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch {}
      groups.get(key).push({ n, mtime });
    }
    for (const list of groups.values()) {
      list.sort((a, b) => b.mtime - a.mtime || b.n.localeCompare(a.n));
      list.slice(KEEP_EVENT).forEach(x => remove(x.n));
    }
  } catch (e) {
    (log.error || console.error)(`[backup] prune failed: ${e.message}`);
  }
}

let timer = null;
/** Take today's snapshot if missing, then re-check hourly (so a daily file appears every day). */
let firstTick = null;
function startDailyBackups({ db, log = console, delayMs = 0 } = {}) {
  const tick = () => { if (!fs.existsSync(dailyFile())) snapshot('daily', { db, log }); };
  // The server passes a delay so the first VACUUM INTO never runs before it is
  // listening (a big DB on NAS disks would otherwise delay the healthcheck).
  if (firstTick) clearTimeout(firstTick);
  if (delayMs > 0) { firstTick = setTimeout(tick, delayMs); if (firstTick.unref) firstTick.unref(); }
  else tick();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, CHECK_MS);
  if (timer.unref) timer.unref();
  return timer;
}
function stopDailyBackups() { if (timer) clearInterval(timer); if (firstTick) clearTimeout(firstTick); timer = null; firstTick = null; }

module.exports = { snapshot, prune, startDailyBackups, stopDailyBackups, backupDir, dailyFile, DAY_MS };
