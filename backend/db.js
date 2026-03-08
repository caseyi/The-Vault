const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/vault.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    folder_path TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
    folder_path TEXT NOT NULL,
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
    last_scanned TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS model_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filetype TEXT,
    filesize INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_path TEXT,
    status TEXT,
    models_found INTEGER DEFAULT 0,
    models_added INTEGER DEFAULT 0,
    models_updated INTEGER DEFAULT 0,
    error TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_models_creator ON models(creator_id);
  CREATE INDEX IF NOT EXISTS idx_models_status ON models(print_status);
  CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
  CREATE INDEX IF NOT EXISTS idx_files_model ON model_files(model_id);
`);

module.exports = db;
