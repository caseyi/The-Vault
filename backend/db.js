const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/vault.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// node:sqlite gives us prepare()/exec()/run/get/all just like better-sqlite3,
// but has no db.transaction(fn) helper. Shim one with the same contract
// (returns a callable that runs fn inside BEGIN/COMMIT, ROLLBACK on throw).
// Nested calls reuse the outer transaction so we never double-BEGIN.
let _txDepth = 0;
db.transaction = (fn) => (...args) => {
  if (_txDepth > 0) return fn(...args);
  _txDepth++;
  db.exec('BEGIN');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    _txDepth--;
  }
};

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -32000;
  PRAGMA foreign_keys = ON;
  PRAGMA temp_store = MEMORY;
  -- Wait instead of erroring if the scan worker and main thread touch the DB at once
  PRAGMA busy_timeout = 15000;

  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    folder_path TEXT,
    notes TEXT,
    render_zip_hint TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
    folder_path TEXT NOT NULL UNIQUE,
    source_site TEXT,
    source_url TEXT,
    description TEXT,
    tags TEXT DEFAULT '[]',
    print_status TEXT DEFAULT 'unprinted' CHECK(print_status IN ('unprinted','sliced','printing','printed','painted','failed')),
    notes TEXT,
    file_count INTEGER DEFAULT 0,
    has_stl INTEGER DEFAULT 0,
    has_chitubox INTEGER DEFAULT 0,
    has_lychee INTEGER DEFAULT 0,
    has_plate INTEGER DEFAULT 0,
    thumbnail_path TEXT,
    images TEXT DEFAULT '[]',
    folder_hash TEXT,
    render_zip_hint TEXT,
    last_scanned TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS model_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL UNIQUE,
    filetype TEXT,
    filesize INTEGER,
    release_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_path TEXT,
    status TEXT,
    models_found INTEGER DEFAULT 0,
    models_added INTEGER DEFAULT 0,
    models_updated INTEGER DEFAULT 0,
    models_skipped INTEGER DEFAULT 0,
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT
  );

  -- Core lookup indexes
  CREATE INDEX IF NOT EXISTS idx_models_folder_path ON models(folder_path);
  CREATE INDEX IF NOT EXISTS idx_models_creator     ON models(creator_id);
  CREATE INDEX IF NOT EXISTS idx_models_status      ON models(print_status);
  CREATE INDEX IF NOT EXISTS idx_models_name        ON models(name);
  CREATE INDEX IF NOT EXISTS idx_models_source_site ON models(source_site);
  CREATE INDEX IF NOT EXISTS idx_files_model        ON model_files(model_id);
  CREATE INDEX IF NOT EXISTS idx_files_filepath     ON model_files(filepath);
  CREATE INDEX IF NOT EXISTS idx_creators_name      ON creators(name);
`);

// ── Migrations ────────────────────────────────────────────────────────────────
// Only "duplicate column name" is expected (the column already exists) — any
// other error is real and must surface instead of being silently swallowed.
function addColumn(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
// Unique indexes can fail on an old DB that already holds duplicates; that must
// not stop the app from starting, so log it and carry on (as before, but loudly).
function tolerantIndex(sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/UNIQUE constraint failed|not unique/i.test(e.message)) throw e;
    console.warn(`[db] could not create index (existing duplicates): ${e.message}`);
  }
}

// PRAGMA user_version tracks which steps ran. Existing databases report 0 and
// already have most columns, so every step must stay idempotent (IF NOT EXISTS
// / addColumn). Append new steps; never reorder or edit shipped ones.
const MIGRATIONS = [
  // 1 — everything that existed before versioning (the old try/catch ALTER list)
  () => {
    addColumn('models', 'folder_hash TEXT');
    addColumn('model_files', 'release_name TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_release ON model_files(release_name)`);
    addColumn('models', 'render_zip_hint TEXT');
    addColumn('creators', 'render_zip_hint TEXT');
    addColumn('scan_log', 'models_skipped INTEGER DEFAULT 0');
    addColumn('model_files', `filepath TEXT NOT NULL DEFAULT ''`);
    tolerantIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_models_folder_path_unique ON models(folder_path)`);
    tolerantIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_files_filepath_unique ON model_files(filepath)`);
    addColumn('models', 'hidden INTEGER DEFAULT 0');
    addColumn('models', 'franchise TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_franchise ON models(franchise)`);
    addColumn('models', 'team TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_team ON models(team)`);
    addColumn('models', 'is_favorite INTEGER DEFAULT 0');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_favorite ON models(is_favorite)`);
    addColumn('model_files', 'printed_at TEXT');

    // Per-folder role overrides for the scanner (creator | passthrough | ignore)
    db.exec(`
      CREATE TABLE IF NOT EXISTS folder_overrides (
        path TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('creator','passthrough','ignore')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Print queue
    db.exec(`
      CREATE TABLE IF NOT EXISTS print_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL UNIQUE REFERENCES models(id) ON DELETE CASCADE,
        position REAL NOT NULL DEFAULT 0,
        added_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_position ON print_queue(position)`);
    addColumn('print_queue', 'note TEXT');

    // Collections
    db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#5b9bd5',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        sort_order INTEGER DEFAULT 0,
        added_at TEXT DEFAULT (datetime('now')),
        UNIQUE(collection_id, model_id)
      )
    `);
    addColumn('collections', 'pinned INTEGER DEFAULT 0');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_coll_models_coll ON collection_models(collection_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_coll_models_model ON collection_models(model_id)`);

    // Status history log
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        note TEXT,
        changed_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_status_log_model ON status_log(model_id)`);

    // Wishlist — models you want to acquire (not yet in library)
    db.exec(`
      CREATE TABLE IF NOT EXISTS wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        name TEXT,
        source_site TEXT,
        notes TEXT,
        status TEXT DEFAULT 'want' CHECK(status IN ('want','scraping','got','failed')),
        added_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wishlist_status ON wishlist(status)`);
  },
  // 2 — user-renamed models keep their name across rescans
  () => {
    addColumn('models', 'name_locked INTEGER DEFAULT 0');
  },
];

function runMigrations() {
  const current = db.prepare('PRAGMA user_version').get().user_version || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(MIGRATIONS[v])();
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
}
runMigrations();

db.SCHEMA_VERSION = MIGRATIONS.length;
db.DB_PATH = DB_PATH;

module.exports = db;
