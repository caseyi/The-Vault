/**
 * Migration 9 (docs/relations.md): a database at user_version 8 gets the relations, sets and
 * set_members tables, and its suggestions table is rebuilt to allow the relation / set / set-member
 * types: every row and id is kept, the old types and statuses still work, unknown types still fail.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-relmig-')));
const DB_PATH = path.join(ROOT, 'vault.db');

beforeAll(() => {
  // a v8 database: the suggestions table as migration 7 left it, with a few rows
  const old = new DatabaseSync(DB_PATH);
  old.exec(`
    CREATE TABLE suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('field','merge','rename','role')),
      field TEXT, current TEXT, proposed TEXT, target_id INTEGER, path TEXT, confidence REAL, reason TEXT,
      source TEXT DEFAULT 'text', run_id INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','superseded')),
      created_at TEXT DEFAULT (datetime('now')), decided_at TEXT
    );
    INSERT INTO suggestions (id, model_id, type, field, proposed, confidence, status) VALUES (3, 1, 'field', 'franchise', '"Marvel"', 0.7, 'pending');
    INSERT INTO suggestions (id, model_id, type, target_id, confidence, status) VALUES (7, 2, 'merge', 1, 0.9, 'rejected');
    INSERT INTO suggestions (id, model_id, type, field, proposed, path, confidence, status) VALUES (12, 2, 'role', 'folder_role', '"category"', '/library/x', 0.8, 'pending');
    PRAGMA user_version = 8;
  `);
  old.close();
});

test('suggestions keep rows and ids; new tables and types', () => {
  let db;
  jest.isolateModules(() => {
    process.env.DB_PATH = DB_PATH;
    db = require('../db');
  });
  expect(db.prepare('PRAGMA user_version').get().user_version).toBe(db.SCHEMA_VERSION);
  expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
  const rows = db.prepare('SELECT id, model_id, type, field, proposed, target_id, path, confidence, status FROM suggestions ORDER BY id').all().map(r => ({ ...r }));
  expect(rows).toEqual([
    { id: 3, model_id: 1, type: 'field', field: 'franchise', proposed: '"Marvel"', target_id: null, path: null, confidence: 0.7, status: 'pending' },
    { id: 7, model_id: 2, type: 'merge', field: null, proposed: null, target_id: 1, path: null, confidence: 0.9, status: 'rejected' },
    { id: 12, model_id: 2, type: 'role', field: 'folder_role', proposed: '"category"', target_id: null, path: '/library/x', confidence: 0.8, status: 'pending' },
  ]);
  // ids keep counting from where they were
  const next = db.prepare(`INSERT INTO suggestions (model_id, type, field, set_id, status) VALUES (1, 'set', 'theme', 4, 'pending')`).run().lastInsertRowid;
  expect(Number(next)).toBe(13);
  for (const t of ['relation', 'set-member']) db.prepare(`INSERT INTO suggestions (model_id, type) VALUES (1, ?)`).run(t);
  expect(() => db.prepare(`INSERT INTO suggestions (model_id, type) VALUES (1, 'bogus')`).run()).toThrow(/CHECK/);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  expect(cols('suggestions')).toEqual(expect.arrayContaining(['set_id', 'path']));
  expect(cols('relations')).toEqual(expect.arrayContaining(['type', 'from_id', 'to_id', 'from_key', 'to_key', 'source', 'confidence', 'status', 'created_at', 'updated_at']));
  expect(cols('sets')).toEqual(expect.arrayContaining(['creator', 'name', 'kind', 'key', 'term', 'source', 'status', 'note', 'info']));
  expect(cols('set_members')).toEqual(expect.arrayContaining(['set_id', 'model_key', 'model_id', 'via', 'status', 'confidence']));
  // one row per (type, from_key, to_key)
  db.prepare(`INSERT INTO relations (type, from_key, to_key) VALUES ('features', 'a', 'b')`).run();
  expect(() => db.prepare(`INSERT INTO relations (type, from_key, to_key) VALUES ('features', 'a', 'b')`).run()).toThrow(/UNIQUE/);
  expect(() => db.prepare(`INSERT INTO relations (type, from_key, to_key) VALUES ('likes', 'a', 'c')`).run()).toThrow(/CHECK/);
  db.close();
});
