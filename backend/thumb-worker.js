'use strict';
/**
 * thumb-worker.js: picture finding and mesh rendering off the main thread (docs/thumbnails.md §3).
 *
 *   { mode: 'fill', scope, steps, renderOnly }  → log / progress messages, then done
 *   { mode: 'render', id, file }                → renders one card, then done with the result
 *
 * The main thread stops a job by terminating the worker. node:sqlite opens its own connection
 * here (WAL mode lets the worker write while the server reads).
 */
const { parentPort, workerData } = require('worker_threads');
const db = require('./db');
const pictures = require('./lib/pictures');
const { tryConfine } = require('./lib/paths');

const post = (msg) => parentPort.postMessage(msg);
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

async function renderOne({ id, file }) {
  const m = db.prepare('SELECT id, uuid, images, thumbnail_path, thumb_source, thumb_attempt FROM models WHERE id = ?').get(id);
  if (!m) return { ok: false, status: 404, error: 'Not found' };
  const files = db.prepare('SELECT filename, filepath, filesize FROM model_files WHERE model_id = ?').all(id).filter(f => tryConfine(f.filepath));
  let r;
  try {
    r = await pictures.renderPreview(files, m.uuid, { file: file || null, log: (level, msg) => post({ type: 'log', level, msg }) });
  } catch (e) {
    return { ok: false, status: /not a mesh of this card/.test(e.message) ? 400 : 422, error: `Could not render: ${e.message}` };
  }
  if (!r) return { ok: false, status: 422, error: 'This card has no STL, OBJ or 3MF file to render' };
  const prev = parseJSON(m.images, []).filter(i => i !== r.url);
  const images = [r.url, ...prev];
  const attempt = pictures.nextAttempt(m.thumb_attempt, pictures.filesSig(files), 'r');
  db.prepare(`UPDATE models SET images = ?, thumbnail_path = ?, thumb_source = 'stl', thumb_attempt = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(images), r.url, attempt, id);
  return { ok: true, images, thumbnail_path: r.url, triangles: r.triangles, ms: r.ms };
}

(async () => {
  try {
    if (workerData.mode === 'render') {
      post({ type: 'done', success: true, result: await renderOne(workerData) });
      return;
    }
    const result = await pictures.fillJob(db, {
      scope: workerData.scope, steps: workerData.steps, renderOnly: !!workerData.renderOnly, post,
    });
    post({ type: 'done', success: true, result });
  } catch (err) {
    post({ type: 'done', success: false, error: err.message });
  }
})();
