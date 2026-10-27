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
  // 3 — library layout, works and attribution (docs/library-metadata.md §6)
  () => {
    addColumn('models', 'work_key TEXT');
    addColumn('models', 'kind TEXT');
    addColumn('models', 'library TEXT');
    addColumn('models', 'libraries TEXT');
    addColumn('models', 'studio TEXT');
    addColumn('models', 'character TEXT');
    addColumn('models', 'group_name TEXT');
    addColumn('models', 'editions TEXT');
    addColumn('models', 'release_term TEXT');
    addColumn('models', 'release_label TEXT');
    addColumn('models', 'source TEXT');
    addColumn('models', 'products TEXT');
    addColumn('models', 'attribution TEXT');
    addColumn('models', 'confidence TEXT');
    addColumn('model_files', 'library TEXT');
    addColumn('model_files', 'variant TEXT');
    addColumn('model_files', 'edition TEXT');
    addColumn('model_files', 'product TEXT');
    addColumn('model_files', 'matched_by TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_work_key ON models(work_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_kind ON models(kind)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_studio ON models(studio)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_release_term ON models(release_term)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_library ON models(library)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_source ON models(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_confidence ON models(confidence)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_product ON model_files(product)`);
    // Small key/value store (e.g. "layout_regroup_done" after the first layout-aware scan)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
  // 4 — rows folded into a work by the regroup point at it (excluded from hidden lists,
  //     collections and counts; cannot be unhidden). Collections get a description
  //     ("Was: <old card>" collections keep the old card's tags/status/notes there).
  () => {
    addColumn('models', 'folded_into INTEGER');
    addColumn('collections', 'description TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_models_folded_into ON models(folded_into)`);
    try {
      db.exec(`UPDATE models SET folded_into = CAST(json_extract(attribution, '$.foldedInto') AS INTEGER)
               WHERE folded_into IS NULL AND attribution LIKE '%"foldedInto"%' AND json_valid(attribution)`);
    } catch { /* JSON1 missing: rows are re-marked by the next scan */ }
  },
  // 5 — AI enrichment (docs/ai-enrichment.md): runs, an undo log of automatic writes, the
  //     review list, and aliases the scanner applies when computing work_key
  () => {
    addColumn('models', 'enrichment TEXT'); // {sig, at, model, runId}
    db.exec(`
      CREATE TABLE IF NOT EXISTS enrich_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT,
        model TEXT,
        scope TEXT,
        params TEXT,
        status TEXT DEFAULT 'running',
        to_process INTEGER DEFAULT 0,
        applied INTEGER DEFAULT 0,
        suggested INTEGER DEFAULT 0,
        merges INTEGER DEFAULT 0,
        unchanged INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        vision_used INTEGER DEFAULT 0,
        in_tokens INTEGER DEFAULT 0,
        out_tokens INTEGER DEFAULT 0,
        undone_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS enrich_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        old_provenance TEXT,
        at TEXT DEFAULT (datetime('now')),
        reverted_at TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_enrich_log_run ON enrich_log(run_id)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('field','merge','rename')),
        field TEXT,
        current TEXT,
        proposed TEXT,
        target_id INTEGER,
        confidence REAL,
        reason TEXT,
        source TEXT DEFAULT 'text',
        run_id INTEGER,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, type, field)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_model ON suggestions(model_id)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator TEXT,
        kind TEXT,
        from_key TEXT NOT NULL UNIQUE,
        to_key TEXT NOT NULL,
        from_name TEXT,
        to_name TEXT,
        source TEXT DEFAULT 'merge' CHECK(source IN ('merge','rename','rules')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
  // 6 — what a run actually cost (USD at the model's rates)
  () => {
    addColumn('enrich_runs', 'usd REAL DEFAULT 0');
  },
  // 7: folder roles (docs/folder-roles.md): the roles table learns category / model and the
  //     category values; suggestions learn type 'role' and the folder they are about. Both CHECK
  //     constraints change, so the tables are rebuilt (rows and ids kept).
  () => {
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    const fo = cols('folder_overrides');
    db.exec(`
      CREATE TABLE folder_overrides_v7 (
        path TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('creator','passthrough','category','model','ignore')),
        genre TEXT,
        grp TEXT,
        tags TEXT,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`INSERT INTO folder_overrides_v7 (path, role, created_at, updated_at)
      SELECT path, role, ${fo.includes('created_at') ? 'created_at' : `datetime('now')`}, ${fo.includes('created_at') ? 'created_at' : `datetime('now')`} FROM folder_overrides`);
    db.exec('DROP TABLE folder_overrides');
    db.exec('ALTER TABLE folder_overrides_v7 RENAME TO folder_overrides');

    const sc = cols('suggestions');
    const keep = ['id', 'model_id', 'type', 'field', 'current', 'proposed', 'target_id', 'confidence', 'reason', 'source', 'run_id', 'status', 'created_at', 'decided_at'].filter(c => sc.includes(c));
    db.exec(`
      CREATE TABLE suggestions_v7 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('field','merge','rename','role')),
        field TEXT,
        current TEXT,
        proposed TEXT,
        target_id INTEGER,
        path TEXT,
        confidence REAL,
        reason TEXT,
        source TEXT DEFAULT 'text',
        run_id INTEGER,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT
      )
    `);
    db.exec(`INSERT INTO suggestions_v7 (${keep.join(',')}) SELECT ${keep.join(',')} FROM suggestions`);
    db.exec('DROP TABLE suggestions');
    db.exec('ALTER TABLE suggestions_v7 RENAME TO suggestions');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, type, field)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_model ON suggestions(model_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_path ON suggestions(path)`);
  },
  // 8: thumbnails (docs/thumbnails.md §2): where a card's picture came from, and the signature of
  //    the last attempt to find one (files + pipeline version + steps tried). Existing pictures get
  //    a best guess: scraped_N.* from the web, a loose image of the card from its folder, else an archive.
  () => {
    addColumn('models', 'thumb_source TEXT');
    addColumn('models', 'thumb_attempt TEXT');
    const rows = db.prepare(`SELECT id, thumbnail_path FROM models WHERE thumbnail_path IS NOT NULL AND thumbnail_path != ''`).all();
    const looseOf = db.prepare(`SELECT filename FROM model_files WHERE model_id = ? AND filetype = 'image'`);
    const set = db.prepare('UPDATE models SET thumb_source = ? WHERE id = ?');
    for (const r of rows) {
      const base = String(r.thumbnail_path).split('/').pop();
      let src = 'archive';
      if (/^scraped_\d+\./.test(base)) src = 'web';
      else if (looseOf.all(r.id).some(f => String(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_') === base)) src = 'folder';
      set.run(src, r.id);
    }
  },
  // 9: related cards and sets (docs/relations.md): relations between cards and sets of cards, keyed
  //    by work_key so they survive rescans; suggestions learn the types relation / set / set-member
  //    and the set they are about (CHECK changes, so the table is rebuilt: rows and ids kept).
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('features','release-of','accessory-of','related')),
        from_id INTEGER,
        to_id INTEGER,
        from_key TEXT NOT NULL,
        to_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','auto-reviewed','user')),
        confidence REAL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed','stale')),
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(type, from_key, to_key)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id, status)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('release','theme')),
        key TEXT NOT NULL UNIQUE,
        term TEXT,
        source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto','auto-reviewed','user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suggested','removed')),
        note TEXT,
        info TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sets_kind ON sets(kind, status)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS set_members (
        set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        model_id INTEGER,
        via TEXT NOT NULL DEFAULT 'auto' CHECK(via IN ('release','folder','auto','user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suggested','removed','stale')),
        confidence REAL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (set_id, model_key)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_set_members_model ON set_members(model_id, status)`);

    const cols = db.prepare('PRAGMA table_info(suggestions)').all().map(c => c.name);
    const keep = ['id', 'model_id', 'type', 'field', 'current', 'proposed', 'target_id', 'path', 'confidence', 'reason', 'source', 'run_id', 'status', 'created_at', 'decided_at'].filter(c => cols.includes(c));
    db.exec(`
      CREATE TABLE suggestions_v9 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('field','merge','rename','role','relation','set','set-member')),
        field TEXT,
        current TEXT,
        proposed TEXT,
        target_id INTEGER,
        path TEXT,
        set_id INTEGER,
        confidence REAL,
        reason TEXT,
        source TEXT DEFAULT 'text',
        run_id INTEGER,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT
      )
    `);
    db.exec(`INSERT INTO suggestions_v9 (${keep.join(',')}) SELECT ${keep.join(',')} FROM suggestions`);
    db.exec('DROP TABLE suggestions');
    db.exec('ALTER TABLE suggestions_v9 RENAME TO suggestions');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, type, field)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_model ON suggestions(model_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_path ON suggestions(path)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_set ON suggestions(set_id)`);
  },
];

db.getSetting = (key) => {
  try { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; } catch { return null; }
};
db.setSetting = (key, value) => {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value == null ? null : String(value));
};

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
