'use strict';
/**
 * lib/fold.js — fold one card into another, keeping every bit of user data. Same rules as the
 * regroup fold in scanner.js (scanLibraryLayout): tags are unioned, a favorite or a print status
 * carries over, notes are appended, collections and the print queue MOVE, a single custom name
 * wins when the target has none (several are listed in the notes), the folded row is hidden with
 * folded_into set and never deleted. Used by accepted merge suggestions (lib/enrich.js).
 *
 * Files move too (model_files.model_id), so the target shows them right away; the next scan keeps
 * them there because the source's work_key is aliased to the target's (aliases table, works.js).
 */
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const addLine = (text, line) => (text && text.includes(line) ? text : (text ? `${text}\n${line}` : line));

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sourceId card that disappears
 * @param {number} targetId card that stays
 * @param {{ reason?: string }} [opts]
 * @returns {{ moved: number }} files moved
 */
function foldInto(db, sourceId, targetId, { reason = 'merge', alias = null } = {}) {
  if (sourceId === targetId) throw new Error('A card cannot be merged into itself');
  const src = db.prepare('SELECT * FROM models WHERE id = ?').get(sourceId);
  const dst = db.prepare('SELECT * FROM models WHERE id = ?').get(targetId);
  if (!src || !dst) throw new Error('Card not found');
  if (src.folded_into != null) throw new Error(`Card #${sourceId} was already folded into #${src.folded_into}`);
  if (dst.folded_into != null) throw new Error(`Card #${targetId} was folded into #${dst.folded_into}; merge into that card instead`);

  const tags = parseJSON(dst.tags, []);
  for (const t of parseJSON(src.tags, [])) if (!tags.includes(t)) tags.push(t);
  let status = dst.print_status || 'unprinted';
  if (status === 'unprinted' && src.print_status && src.print_status !== 'unprinted') status = src.print_status;
  let notes = dst.notes || '';
  if (src.notes) notes = addLine(notes, src.notes);
  let name = dst.name, locked = dst.name_locked ? 1 : 0;
  if (src.name_locked) {
    if (!locked) { name = src.name; locked = 1; } else notes = addLine(notes, `Previous custom names: ${src.name}`);
  }
  const fav = dst.is_favorite || (!src.hidden && src.is_favorite) ? 1 : 0;
  if (src.hidden && !dst.hidden) notes = addLine(notes, `Hidden before merge: ${src.name}`);
  const images = parseJSON(dst.images, []);
  if (!src.hidden) for (const im of parseJSON(src.images, [])) if (!images.includes(im)) images.push(im);
  const thumb = dst.thumbnail_path || (!src.hidden && src.thumbnail_path) || null;

  const dAttr = parseJSON(dst.attribution, {});
  const from = Array.isArray(dAttr.foldedFrom) ? dAttr.foldedFrom : [];
  if (!from.some(e => e.id === src.id)) from.push({ id: src.id, name: src.name, by: reason, ...(src.hidden ? { hidden: true } : {}) });
  dAttr.foldedFrom = from;
  const sAttr = parseJSON(src.attribution, {});
  sAttr.foldedInto = dst.id;
  sAttr.foldedBy = reason;
  // what an unmerge needs to put back (POST /api/suggestions/:id/unmerge)
  sAttr.merge = {
    into: dst.id, at: new Date().toISOString(), hidden: !!src.hidden, workKey: src.work_key || null,
    aliasFrom: alias ? alias.from : null, aliasTo: alias ? alias.to : null,
    files: db.prepare('SELECT filepath FROM model_files WHERE model_id = ?').all(src.id).map(r => r.filepath),
    collections: db.prepare('SELECT collection_id FROM collection_models WHERE model_id = ?').all(src.id).map(r => r.collection_id),
    queued: !!db.prepare('SELECT 1 FROM print_queue WHERE model_id = ?').get(src.id),
  };

  let moved = 0;
  db.transaction(() => {
    db.prepare(`UPDATE models SET tags=?, is_favorite=?, print_status=?, notes=?, images=?, thumbnail_path=?, name=?, name_locked=?,
      attribution=?, source_url=COALESCE(NULLIF(source_url,''), ?), updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(tags), fav, status, notes || null, JSON.stringify(images), thumb, name, locked, JSON.stringify(dAttr), src.source_url || null, dst.id);
    db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id, sort_order) SELECT collection_id, ?, sort_order FROM collection_models WHERE model_id = ?').run(dst.id, src.id);
    db.prepare('DELETE FROM collection_models WHERE model_id = ?').run(src.id);
    db.prepare('UPDATE OR IGNORE print_queue SET model_id = ? WHERE model_id = ?').run(dst.id, src.id);
    db.prepare('DELETE FROM print_queue WHERE model_id = ?').run(src.id); // a duplicate queue entry
    moved = db.prepare('UPDATE model_files SET model_id = ? WHERE model_id = ?').run(dst.id, src.id).changes;
    const st = db.prepare('SELECT COUNT(*) n, GROUP_CONCAT(DISTINCT library) libs FROM model_files WHERE model_id = ?').get(dst.id);
    const libs = [...new Set([...parseJSON(dst.libraries, []), ...String(st.libs || '').split(',').filter(Boolean)])];
    const eds = [...new Set([...parseJSON(dst.editions, []), ...parseJSON(src.editions, [])])];
    db.prepare('UPDATE models SET file_count = ?, libraries = ?, editions = ? WHERE id = ?').run(st.n, JSON.stringify(libs), JSON.stringify(eds), dst.id);
    db.prepare(`UPDATE models SET hidden = 1, folder_hash = NULL, work_key = NULL, folded_into = ?, attribution = ?, file_count = 0, updated_at = datetime('now') WHERE id = ?`)
      .run(dst.id, JSON.stringify(sAttr), src.id);
  })();
  return { moved };
}

module.exports = { foldInto };
