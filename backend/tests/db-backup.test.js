/**
 * B12: migrations (user_version, strict ALTER handling) and DB snapshots.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dbb-'));
const DB_FILE = path.join(ROOT, 'vault.db');

// Build a "pre-versioning" database: user_version 0, old models table without
// name_locked, some data — like an existing NAS install.
{
  const old = new DatabaseSync(DB_FILE);
  old.exec(`
    CREATE TABLE creators (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, folder_path TEXT, notes TEXT, created_at TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      creator_id INTEGER, folder_path TEXT NOT NULL UNIQUE, source_site TEXT, source_url TEXT, description TEXT,
      tags TEXT DEFAULT '[]', print_status TEXT DEFAULT 'unprinted',
      notes TEXT, file_count INTEGER DEFAULT 0, has_stl INTEGER DEFAULT 0, has_chitubox INTEGER DEFAULT 0,
      has_lychee INTEGER DEFAULT 0, has_plate INTEGER DEFAULT 0, thumbnail_path TEXT, images TEXT DEFAULT '[]',
      folder_hash TEXT, last_scanned TEXT, created_at TEXT, updated_at TEXT, hidden INTEGER DEFAULT 0, franchise TEXT);
    INSERT INTO models (uuid, name, folder_path) VALUES ('u1', 'Old Model', '/library/x');
  `);
  old.close();
}

process.env.DB_PATH = DB_FILE;
process.env.BACKUP_DIR = path.join(ROOT, 'backups');
process.env.BACKUP_KEEP = '3';

const db = require('../db');
const backup = require('../lib/backup');

afterAll(() => { try { db.close(); } catch {} fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('migrations', () => {
  test('an existing user_version=0 DB is migrated in place, data intact', () => {
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(db.SCHEMA_VERSION);
    const cols = db.prepare('PRAGMA table_info(models)').all().map(c => c.name);
    for (const c of ['name_locked', 'team', 'is_favorite', 'render_zip_hint']) expect(cols).toContain(c);
    expect(db.prepare('SELECT name FROM models WHERE uuid = ?').get('u1').name).toBe('Old Model');
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wishlist'`).get()).toBeTruthy();
  });

  test('re-opening is a no-op (idempotent)', () => {
    const again = new DatabaseSync(DB_FILE);
    expect(again.prepare('PRAGMA user_version').get().user_version).toBe(db.SCHEMA_VERSION);
    again.close();
    jest.isolateModules(() => { expect(() => require('../db')).not.toThrow(); });
  });

  test('db.js no longer swallows every ALTER error', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
    expect(src).not.toMatch(/try \{ db\.exec\(`ALTER TABLE[^}]*\} catch \{\}/);
    expect(src).toMatch(/duplicate column name/);
  });
});

describe('lib/backup', () => {
  test('snapshot() writes a valid SQLite copy via VACUUM INTO; daily is written once per day', () => {
    const f = backup.snapshot('daily', { db, log: { log() {}, error() {} } });
    expect(f).toBe(backup.dailyFile());
    const copy = new DatabaseSync(f);
    expect(copy.prepare('SELECT COUNT(*) n FROM models').get().n).toBe(1);
    copy.close();
    expect(backup.snapshot('daily', { db, log: { log() {}, error() {} } })).toBeNull(); // already exists
    const pre = backup.snapshot('pre-forcescan', { db, log: { log() {}, error() {} } });
    expect(path.basename(pre)).toMatch(/^vault-pre-forcescan-\d{8}-\d{6}.*\.db$/);
  });

  test('prune keeps BACKUP_KEEP dailies and the newest 10 of each event type', () => {
    const dir = backup.backupDir();
    for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `vault-202001${String(d).padStart(2, '0')}.db`), 'x');
    for (let i = 0; i < 14; i++) {
      const f = path.join(dir, `vault-pre-update-20200101-0000${String(i).padStart(2, '0')}.db`);
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, new Date(2020, 0, 1, 0, 0, i), new Date(2020, 0, 1, 0, 0, i));
    }
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    backup.prune({ log: { error() {} } });
    const names = fs.readdirSync(dir);
    expect(names.filter(n => /^vault-\d{8}\.db$/.test(n)).length).toBe(3);
    expect(names).toContain(path.basename(backup.dailyFile())); // today's is the newest
    const updates = names.filter(n => n.startsWith('vault-pre-update-')).sort();
    expect(updates.length).toBe(10);
    expect(updates[0]).toBe('vault-pre-update-20200101-000004.db');
    expect(names.filter(n => n.startsWith('vault-pre-forcescan-')).length).toBe(1);
    expect(names).toContain('unrelated.txt');
  });

  test('a failing snapshot logs and returns null instead of throwing', () => {
    const saved = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = path.join(ROOT, 'vault.db', 'nope'); // parent is a file → mkdir fails
    const errors = [];
    try {
      expect(backup.snapshot('pre-forcescan', { db, log: { log() {}, error: (m) => errors.push(m) } })).toBeNull();
      expect(errors.join()).toMatch(/snapshot "pre-forcescan" failed/);
    } finally { process.env.BACKUP_DIR = saved; }
  });

  test('startDailyBackups writes today\'s file if missing and schedules an unref\'d timer', () => {
    fs.rmSync(backup.dailyFile(), { force: true });
    const timer = backup.startDailyBackups({ db, log: { log() {}, error() {} } });
    expect(fs.existsSync(backup.dailyFile())).toBe(true);
    expect(timer.hasRef()).toBe(false);
    backup.stopDailyBackups();
  });
});
