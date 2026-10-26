'use strict';
/**
 * folder-roles-routes.js: /api/folder-roles (docs/folder-roles.md §6).
 *
 *   GET  /                    effective marks (file + app) and the _Meta files they came from
 *   POST /                    set or clear an app mark { path, role|null, genre?, group?, tags?, note? }
 *   GET  /suspects            folders that probably need a role (?dismissed=1 includes dismissed)
 *   POST /suspects/dismiss    { path, undo? }
 *
 * The app never writes to the library: app marks live in the DB and are exported in the file
 * format by /api/organizer/export/folder_roles.csv.
 */
const express = require('express');
const path = require('path');
const folderRoles = require('./lib/folder-roles');
const suspectsLib = require('./lib/suspects');
const { confinePath, sendPathError } = require('./lib/paths');
const { wrapAsyncRoutes } = require('./lib/middleware');

/**
 * @param {{ db: object, root: string, getLibraries: () => Promise<object[]> }} deps
 */
function folderRolesRouter({ db, root, getLibraries }) {
  const router = wrapAsyncRoutes(express.Router());

  const shapeEntry = (e, libs) => {
    const lr = folderRoles.libRel(e.path, libs);
    return {
      path: e.path, library: lr.library, rel: lr.rel, role: e.role, genre: e.genre || null, group: e.group || null,
      tags: e.tags || [], note: e.note || '', source: e.source, conflict: e.conflict || null,
    };
  };

  router.get('/', async (req, res) => {
    const libs = await getLibraries();
    const { merged, files } = folderRoles.effectiveRoles(db, root, libs);
    const roles = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path)).map(e => shapeEntry(e, libs));
    res.json({
      roles,
      files: files.map(f => ({ library: folderRoles.libRel(f.root, libs).library || path.basename(f.root), path: f.path, rows: f.rows, errors: f.errors })),
    });
  });

  router.post('/', async (req, res) => {
    const b = req.body || {};
    if (typeof b.path !== 'string' || !b.path.trim()) return res.status(400).json({ error: 'path required' });
    const role = folderRoles.normalizeRole(b.role);
    if (role === undefined) return res.status(400).json({ error: `invalid role (one of ${folderRoles.ROLES.join(', ')}, or null to clear)` });
    const libs = await getLibraries();
    const fileHas = (p) => folderRoles.loadFileRoles(folderRoles.metaDirsFor(root, libs)).entries.some(e => e.path === p);
    if (role === null) {
      // clearing is always allowed (even for a stale path outside the library)
      const p = path.resolve(String(b.path));
      db.prepare('DELETE FROM folder_overrides WHERE path = ?').run(p);
      return res.json({ ok: true, rescan: true, fileOverrides: fileHas(p) });
    }
    let p;
    try { p = confinePath(String(b.path)); } catch (e) { if (sendPathError(res, e)) return; throw e; }
    const isCat = role === 'category';
    const genre = isCat ? folderRoles.cleanValue(b.genre) : null;
    const group = isCat ? folderRoles.cleanValue(b.group) : null;
    const tags = isCat ? folderRoles.parseTags(b.tags) : [];
    const note = folderRoles.cleanValue(b.note, 200);
    db.prepare(`INSERT INTO folder_overrides (path, role, genre, grp, tags, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET role = excluded.role, genre = excluded.genre, grp = excluded.grp, tags = excluded.tags,
        note = COALESCE(excluded.note, folder_overrides.note), updated_at = excluded.updated_at`)
      .run(p, role, genre, group, tags.length ? JSON.stringify(tags) : null, note);
    res.json({ ok: true, rescan: true, fileOverrides: fileHas(p) });
  });

  router.get('/suspects', async (req, res) => {
    const libs = await getLibraries();
    const { merged } = folderRoles.effectiveRoles(db, root, libs);
    const withDismissed = req.query.dismissed === '1' || req.query.dismissed === 'true';
    res.json({ items: suspectsLib.computeSuspects(db, { libs, roles: merged, dismissed: withDismissed }) });
  });

  router.post('/suspects/dismiss', (req, res) => {
    const p = req.body && typeof req.body.path === 'string' ? path.resolve(req.body.path) : null;
    if (!p) return res.status(400).json({ error: 'path required' });
    suspectsLib.dismiss(db, p, !!req.body.undo);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { folderRolesRouter };
