const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/vault.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -32000;
  PRAGMA foreign_keys = ON;
  PRAGMA temp_store = MEMORY;

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

// Migrations for existing databases
try { db.exec(`ALTER TABLE models ADD COLUMN folder_hash TEXT`); } catch {}
try { db.exec(`ALTER TABLE model_files ADD COLUMN release_name TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_files_release ON model_files(release_name)`); } catch {}
try { db.exec(`ALTER TABLE models ADD COLUMN render_zip_hint TEXT`); } catch {}
try { db.exec(`ALTER TABLE creators ADD COLUMN render_zip_hint TEXT`); } catch {}
try { db.exec(`ALTER TABLE scan_log ADD COLUMN models_skipped INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE model_files ADD COLUMN filepath TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_models_folder_path_unique ON models(folder_path)`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_files_filepath_unique ON model_files(filepath)`); } catch {}
try { db.exec(`ALTER TABLE models ADD COLUMN hidden INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE models ADD COLUMN franchise TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_models_franchise ON models(franchise)`); } catch {}
try { db.exec(`ALTER TABLE models ADD COLUMN team TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_models_team ON models(team)`); } catch {}
try { db.exec(`ALTER TABLE model_files ADD COLUMN printed_at TEXT`); } catch {}

// Print queue
try { db.exec(`
  CREATE TABLE IF NOT EXISTS print_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL UNIQUE REFERENCES models(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_position ON print_queue(position)`); } catch {}

// Collections
try { db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#5b9bd5',
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS collection_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(collection_id, model_id)
  )
`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_coll_models_coll ON collection_models(collection_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_coll_models_model ON collection_models(model_id)`); } catch {}

// Status history log
try { db.exec(`
  CREATE TABLE IF NOT EXISTS status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT,
    changed_at TEXT DEFAULT (datetime('now'))
  )
`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_status_log_model ON status_log(model_id)`); } catch {}

module.exports = db;
