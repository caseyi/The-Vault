'use strict';
/**
 * lib/pictures.js: finding a picture for every card (docs/thumbnails.md §2).
 *
 * Steps, stopping at the first that yields images:
 *   a  render archives by name (scanner.workImages, as before)
 *   f  loose images among the card's files
 *   p  peek inside the card's other archives (central directory only) and extract the best 6 images
 *   r  render the model itself (lib/mesh-render.js) → stl-preview.png
 *
 * models.thumb_attempt = "<pipeline version>:<files signature>:<letters of the steps tried>", so a
 * rescan never repeats work for an unchanged card and a pipeline version bump retries every card once.
 * models.thumb_source: folder | archive | archive-peek | stl | web | user. A user-chosen thumbnail is
 * never replaced.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zipLib = require('./zip');
const meshRender = require('./mesh-render');

const PIPELINE_VERSION = '1';
const pipelineVersion = () => String(process.env.THUMB_PIPELINE_VERSION || PIPELINE_VERSION);

const PEEK_MAX_ARCHIVES = 16;
const PEEK_MIN_BYTES = 20 * 1024;
const PEEK_TAKE = 6;
const RENDER_MAX_BYTES = 300 * 1024 * 1024;
const RENDER_MAX_TRIANGLES = 4000000;
const RENDER_MAX_PARTS = 24;
const PREVIEW_NAME = 'stl-preview.png';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar']);
const MESH_EXTS = meshRender.MESH_EXTS;

const imagesDir = () => process.env.IMAGES_DIR || '/data/images';
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const scanner = () => require('../scanner'); // lazy: scanner requires the DB

// ── attempt signature ───────────────────────────────────────────────────────

/** Signature of a card's files: [{ path|filepath|abs, size|filesize }]. */
function filesSig(files) {
  const parts = files.map(f => `${f.filepath || f.abs || f.path}:${f.filesize ?? f.size ?? 0}`).sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}
function parseAttempt(a) {
  const m = /^([^:]+):([0-9a-f]+):([a-z]*)$/.exec(String(a || ''));
  return m ? { version: m[1], sig: m[2], steps: m[3] } : null;
}
/** true when every step letter in `steps` was already tried for these files with this pipeline version. */
function covered(attempt, sig, steps) {
  const a = parseAttempt(attempt);
  if (!a || a.version !== pipelineVersion() || a.sig !== sig) return false;
  return [...steps].every(s => a.steps.includes(s));
}
/** The attempt value after trying `steps` (merged with an earlier attempt for the same files). */
function nextAttempt(attempt, sig, steps) {
  const a = parseAttempt(attempt);
  const prev = a && a.version === pipelineVersion() && a.sig === sig ? a.steps : '';
  const letters = [...new Set([...prev, ...steps])].sort().join('');
  return `${pipelineVersion()}:${sig}:${letters}`;
}

// ── step p: peek inside archives ────────────────────────────────────────────

/** Score an image entry from a peeked archive: filename ranking plus a size bonus. */
function peekScore(name, size, archiveName) {
  const { imageScoreOf } = scanner();
  let s = imageScoreOf(name);
  s += Math.min(4, Math.log2(Math.max(1, size / PEEK_MIN_BYTES)) / 2); // bigger images are usually the renders
  if (scanner().isRenderArchive(archiveName)) s += 3;
  if (/(^|\/)(__macosx)\//i.test(name) || /(^|\/)\._/.test(name)) s -= 100;
  if (/(^|[^a-z])(icon|logo|favicon|avatar|thumbs\.db|watermark)([^a-z]|$)/i.test(name)) s -= 4;
  return s;
}

/** Archives worth peeking: render-named first, then smallest first; at most PEEK_MAX_ARCHIVES. */
function peekOrder(archives) {
  const { isRenderArchive } = scanner();
  return archives
    .map(a => ({ ...a, render: isRenderArchive(path.basename(a.path)) }))
    .sort((x, y) => (y.render - x.render) || (x.size - y.size))
    .slice(0, PEEK_MAX_ARCHIVES);
}

/**
 * Read only the central directories of a card's archives, rank image entries >= 20 KB across all
 * of them and extract the best PEEK_TAKE into IMAGES_DIR/<uuid>/. RAR is listed only within
 * ARCHIVE_MAX_MB (it is read into memory). Returns /images/... URLs.
 */
async function peekArchives(archives, uuid, log = () => {}) {
  const cands = [];
  for (const a of peekOrder(archives)) {
    const ext = path.extname(a.path).toLowerCase();
    try {
      if (ext === '.zip') {
        if (zipLib.zipTooBig(a.path)) continue;
        for (const e of await zipLib.listZip(a.path)) {
          if (e.isDirectory || !IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
          if (e.size < PEEK_MIN_BYTES || e.size > zipLib.imageMaxBytes()) continue;
          cands.push({ archive: a.path, ext, name: e.name, size: e.size, score: peekScore(e.name, e.size, path.basename(a.path)) });
        }
      } else if (ext === '.rar') {
        for (const e of await listRar(a.path)) {
          if (!IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
          if (e.size < PEEK_MIN_BYTES || e.size > zipLib.imageMaxBytes()) continue;
          cands.push({ archive: a.path, ext, name: e.name, size: e.size, score: peekScore(e.name, e.size, path.basename(a.path)) });
        }
      }
    } catch (e) { log('warn', `    could not read ${path.basename(a.path)}: ${e.message}`); }
  }
  if (!cands.length) return [];
  cands.sort((x, y) => (y.score - x.score) || (y.size - x.size));
  const picked = [];
  const names = new Set();
  for (const c of cands) {
    if (picked.length >= PEEK_TAKE) break;
    const safe = zipLib.safeName(c.name);
    if (!safe || names.has(safe)) continue;
    names.add(safe);
    picked.push(c);
  }
  const dest = path.join(imagesDir(), uuid);
  const byArchive = new Map();
  for (const c of picked) { if (!byArchive.has(c.archive)) byArchive.set(c.archive, []); byArchive.get(c.archive).push(c); }
  const saved = new Map(); // safe name → url, in pick order
  for (const [archive, list] of byArchive) {
    try {
      let names2;
      if (list[0].ext === '.zip') names2 = await zipLib.extractZipImages(archive, dest, { select: list.map(c => c.name) });
      else names2 = await extractRar(archive, dest, list.map(c => c.name));
      for (const n of names2) saved.set(n, `/images/${uuid}/${n}`);
    } catch (e) { log('warn', `    could not extract from ${path.basename(archive)}: ${e.message}`); }
  }
  return picked.map(c => saved.get(zipLib.safeName(c.name))).filter(Boolean);
}

function rarTooBig(p) {
  const mb = parseFloat(process.env.ARCHIVE_MAX_MB);
  const max = (Number.isFinite(mb) && mb > 0 ? mb : 500) * 1024 * 1024;
  try { return fs.statSync(p).size > max; } catch { return true; }
}
async function rarExtractor(p) {
  const { createExtractorFromData } = require('node-unrar-js');
  const data = fs.readFileSync(p);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return createExtractorFromData({ data: ab });
}
async function listRar(p) {
  if (rarTooBig(p)) return [];
  const ex = await rarExtractor(p);
  const list = ex.getFileList();
  return [...list.fileHeaders].filter(h => !h.flags.directory).map(h => ({ name: String(h.name).replace(/\\/g, '/'), size: h.unpSize }));
}
async function extractRar(p, dest, names) {
  const want = new Set(names);
  const ex = await rarExtractor(p);
  const out = [];
  fs.mkdirSync(dest, { recursive: true });
  const list = ex.extract({ files: (h) => want.has(String(h.name).replace(/\\/g, '/')) });
  for (const f of list.files) {
    const n = zipLib.safeName(f.fileHeader.name);
    if (!n || !f.extraction) continue;
    const file = path.join(dest, n);
    if (!fs.existsSync(file)) fs.writeFileSync(file, f.extraction);
    out.push(n);
  }
  return out;
}

// ── step r: which mesh to render ────────────────────────────────────────────

const SKIP_RE = /(^|[^a-z])(supports?|support[ _-]?only|test|tests|calibration|calib|tolerance|raft|sprue|cube)([^a-z]|$)/i;
const BASE_ONLY_RE = /^(base|bases|plinth|stand|pedestal|display[ _-]?base|round[ _-]?base|square[ _-]?base)([ _-]*\d+)?$/i;
const PRESUP_RE = /pre-?supported|(^|[^a-z])supported|(^|[^a-z])sup([^a-z]|$)|(^|[^a-z])presup/i;
const UNSUP_RE = /un-?supported|no[ _-]?supports?/i;

function meshKind(name) {
  const stem = path.basename(name, path.extname(name));
  if (SKIP_RE.test(stem) && !/supported/i.test(stem)) return 'skip';
  if (BASE_ONLY_RE.test(stem.trim())) return 'skip';
  return 'mesh';
}
const supPenalty = (p) => (UNSUP_RE.test(p) ? 0 : (PRESUP_RE.test(p) ? 1 : 0));

/**
 * Choose what to render from mesh candidates [{ id, name, dir, size, source }]:
 * the parts of one folder together when they look like one model, else the largest single mesh.
 * Returns { parts: [cand], mode: 'parts'|'single' } or null.
 */
function chooseMeshes(cands) {
  const ok = cands.filter(c => MESH_EXTS.has(path.extname(c.name).toLowerCase()) && meshKind(c.name) === 'mesh' && c.size > 84);
  if (!ok.length) return null;
  const groups = new Map();
  for (const c of ok) { if (!groups.has(c.dir)) groups.set(c.dir, []); groups.get(c.dir).push(c); }
  const scored = [...groups.values()].map(list => {
    const total = list.reduce((s, c) => s + c.size, 0);
    const pen = supPenalty(list[0].dir) + list.filter(c => supPenalty(c.name)).length / list.length;
    return { list, total, pen };
  }).sort((a, b) => (a.pen - b.pen) || (b.total - a.total));
  const best = scored[0];
  // drop exact duplicates (same size and extension: alternative exports of the same part)
  const seen = new Set();
  const parts = best.list.filter(c => { const k = `${c.size}:${path.extname(c.name).toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const estTris = parts.reduce((s, c) => s + meshRender.estimateTriangles(c.name, c.size), 0);
  if (parts.length >= 2 && parts.length <= RENDER_MAX_PARTS && best.total <= RENDER_MAX_BYTES && estTris <= RENDER_MAX_TRIANGLES) {
    return { parts: parts.sort((a, b) => b.size - a.size), mode: 'parts' };
  }
  // the largest single mesh that is not presupported if possible
  const single = ok.slice().sort((a, b) => (supPenalty(a.dir + '/' + a.name) - supPenalty(b.dir + '/' + b.name)) || (b.size - a.size))[0];
  return { parts: [single], mode: 'single' };
}

/** Mesh candidates of a card: loose files, else entries inside its zips (central directory only). */
async function meshCandidates(files, { includeZips = true, log = () => {} } = {}) {
  const loose = [];
  const zips = [];
  for (const f of files) {
    const p = f.filepath || f.abs || f.path;
    const name = f.filename || f.name || path.basename(p);
    const ext = path.extname(name).toLowerCase();
    const size = f.filesize ?? f.size ?? 0;
    if (MESH_EXTS.has(ext)) loose.push({ id: p, name, dir: path.dirname(p), size, label: name, source: { kind: 'file', path: p } });
    else if (ext === '.zip') zips.push({ path: p, size });
  }
  if (!includeZips) return { loose, inZip: [] };
  const inZip = [];
  for (const z of zips.sort((a, b) => a.size - b.size).slice(0, PEEK_MAX_ARCHIVES)) {
    if (zipLib.zipTooBig(z.path)) continue;
    try {
      for (const e of await zipLib.listZip(z.path)) {
        if (e.isDirectory || !MESH_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        inZip.push({
          id: `${z.path}::${e.name}`, name: path.basename(e.name), dir: `${z.path}::${path.posix.dirname(e.name)}`, size: e.size,
          label: `${path.basename(z.path)} › ${e.name}`, source: { kind: 'zip', zipPath: z.path, entry: e.name },
        });
      }
    } catch (e) { log('warn', `    could not list ${path.basename(z.path)}: ${e.message}`); }
  }
  return { loose, inZip };
}

/**
 * Render a card's model to IMAGES_DIR/<uuid>/stl-preview.png.
 * @param {object[]} files card files ({ filepath, filename, filesize })
 * @param {string} uuid
 * @param {{ file?: string, log?: Function, shouldStop?: Function }} [opts] file: a mesh path or "zip::entry"
 * @returns {Promise<{ url: string, triangles: number, ms: number, parts: string[] } | null>}
 */
async function renderPreview(files, uuid, opts = {}) {
  const log = opts.log || (() => {});
  let choice = null;
  if (opts.file) {
    const { loose, inZip } = await meshCandidates(files, { includeZips: String(opts.file).includes('::'), log });
    const hit = [...loose, ...inZip].find(c => c.id === opts.file);
    if (!hit) throw new Error('That file is not a mesh of this card');
    choice = { parts: [hit], mode: 'single' };
  } else {
    const { loose } = await meshCandidates(files, { includeZips: false });
    choice = chooseMeshes(loose);
    if (!choice) choice = chooseMeshes((await meshCandidates(files, { log })).inZip);
  }
  if (!choice) return null;
  const run = async (parts) => meshRender.renderMeshes(parts.map(p => p.source), {
    maxTriangles: parts.length > 1 ? RENDER_MAX_TRIANGLES : Infinity, shouldStop: opts.shouldStop,
  });
  let res;
  try {
    res = await run(choice.parts);
  } catch (e) {
    if (choice.parts.length < 2 || e.message === 'stopped') throw e;
    res = await run([choice.parts[0]]); // a broken part: try the largest one alone
  }
  const dir = path.join(imagesDir(), uuid);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, PREVIEW_NAME);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, res.png);
  fs.renameSync(tmp, dest);
  try { require('./thumbs').removeImageThumbs(`/images/${uuid}/${PREVIEW_NAME}`); } catch {}
  log('img', `    ◆ rendered ${choice.parts.map(p => p.label).join(', ')} (${res.triangles.toLocaleString('en-US')} triangles, ${res.ms.total} ms)`);
  return { url: `/images/${uuid}/${PREVIEW_NAME}`, triangles: res.triangles, ms: res.ms.total, parts: choice.parts.map(p => p.id) };
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/**
 * Steps f/a/p/r for one card. `steps` is a string of letters ('fap', 'fapr', 'r').
 * @returns {Promise<{ images: string[], source: string|null, tried: string }>}
 */
async function findPictures({ files, uuid, hint = null, steps = 'fap', log = () => {}, shouldStop }) {
  const sc = scanner();
  const tried = [];
  if (steps.includes('a') || steps.includes('f')) {
    const analysis = sc.analysisFromFiles(files);
    if (steps.includes('a')) {
      tried.push('a');
      const archives = sc.pickRenderArchives(analysis, hint).slice(0, sc.MAX_RENDER_ARCHIVES);
      const out = [];
      for (const a of archives) {
        log('zip', `    📦 ${path.basename(a)}`);
        out.push(...await sc.extractImagesFromArchive(a, uuid, { limit: sc.MAX_ARCHIVE_IMAGES }));
      }
      if (out.length) return { images: [...new Set(out)], source: 'archive', tried: tried.join('') };
    }
    if (steps.includes('f')) {
      tried.push('f');
      if (analysis.images.length) {
        const out = sc.copyImageFiles(sc.rankImages(analysis.images).slice(0, sc.MAX_LOOSE_IMAGES), uuid);
        if (out.length) return { images: out, source: 'folder', tried: tried.join('') };
      }
    }
  }
  if (steps.includes('p')) {
    tried.push('p');
    const archives = files.map(f => ({ path: f.filepath || f.abs || f.path, size: f.filesize ?? f.size ?? 0 }))
      .filter(a => ARCHIVE_EXTS.has(path.extname(a.path).toLowerCase()));
    if (archives.length) {
      const out = await peekArchives(archives, uuid, log);
      if (out.length) { log('img', `    🔍 ${out.length} image(s) from inside the archives`); return { images: out, source: 'archive-peek', tried: tried.join('') }; }
    }
  }
  if (steps.includes('r')) {
    tried.push('r');
    try {
      const r = await renderPreview(files, uuid, { log, shouldStop });
      if (r) return { images: [r.url], source: 'stl', tried: tried.join('') };
    } catch (e) {
      if (e.message === 'stopped') throw e;
      log('warn', `    could not render the model: ${e.message}`);
    }
  }
  return { images: [], source: null, tried: tried.join('') };
}

/**
 * New images for a card: the user's thumbnail stays; new pictures replace a mesh render as the
 * thumbnail (the render moves to the end); otherwise the card keeps its thumbnail.
 * @returns {{ images: string[], thumbnail_path: string|null, thumb_source: string|null }}
 */
function mergeImages(model, fresh, source, { replaceThumb = false } = {}) {
  const prev = parseJSON(model.images, []);
  let images = [...new Set([...fresh, ...prev])];
  const userThumb = model.thumb_source === 'user' && model.thumbnail_path && images.includes(model.thumbnail_path);
  if (userThumb) return { images, thumbnail_path: model.thumbnail_path, thumb_source: 'user' };
  if (!fresh.length) return { images, thumbnail_path: model.thumbnail_path && images.includes(model.thumbnail_path) ? model.thumbnail_path : (images[0] || null), thumb_source: images.length ? (model.thumb_source || null) : null };
  const wasRender = model.thumb_source === 'stl' && source !== 'stl';
  if (wasRender) {
    const renders = images.filter(i => i.endsWith(`/${PREVIEW_NAME}`));
    images = [...images.filter(i => !renders.includes(i)), ...renders];
  }
  if (replaceThumb || wasRender || !prev.length || !model.thumbnail_path || !images.includes(model.thumbnail_path)) {
    return { images, thumbnail_path: fresh[0], thumb_source: source };
  }
  return { images, thumbnail_path: model.thumbnail_path, thumb_source: model.thumb_source || source };
}

// ── fill job (runs in thumb-worker.js) ──────────────────────────────────────

/**
 * Work through cards without images (scope 'missing': attempts not yet covered; 'all': every card
 * without a picture or with only a mesh render, attempts ignored). steps: ['peek','render'].
 */
async function fillJob(db, { scope = 'missing', steps = ['peek', 'render'], renderOnly = false, ids = null, post = () => {}, shouldStop = () => false } = {}) {
  const { tryConfine } = require('./paths');
  // the cheap steps (render archives, loose images) always run, except for the render queued after a scan
  const want = renderOnly ? 'r' : 'af' + (steps.includes('peek') ? 'p' : '') + (steps.includes('render') ? 'r' : '');
  const log = (level, msg) => post({ type: 'log', level, msg });
  const where = scope === 'all'
    ? `(images IS NULL OR images IN ('', '[]') OR thumb_source = 'stl')`
    : `(images IS NULL OR images IN ('', '[]'))`;
  let rows = db.prepare(`SELECT m.id, m.uuid, m.name, m.images, m.thumbnail_path, m.thumb_source, m.thumb_attempt, m.render_zip_hint, c.render_zip_hint AS creator_hint
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE m.folded_into IS NULL AND (m.hidden IS NULL OR m.hidden = 0) AND COALESCE(m.thumb_source, '') != 'user' AND ${where} ORDER BY m.id`).all();
  if (Array.isArray(ids)) { const s = new Set(ids); rows = rows.filter(r => s.has(r.id)); }
  const filesOf = db.prepare('SELECT filename, filepath, filesize, variant FROM model_files WHERE model_id = ?');
  const setPics = db.prepare(`UPDATE models SET images = ?, thumbnail_path = ?, thumb_source = ?, thumb_attempt = ?, updated_at = datetime('now') WHERE id = ?`);
  const setAttempt = db.prepare('UPDATE models SET thumb_attempt = ? WHERE id = ?');
  const work = [];
  for (const r of rows) {
    const files = filesOf.all(r.id).filter(f => tryConfine(f.filepath));
    if (!files.length) continue;
    const sig = filesSig(files);
    if (scope !== 'all' && covered(r.thumb_attempt, sig, want)) continue;
    work.push({ r, files, sig });
  }
  const found = { folder: 0, archive: 0, peek: 0, stl: 0 };
  let done = 0, failed = 0;
  const total = work.length;
  log('info', `${total} card(s) to look at (${scope}, steps: ${renderOnly ? 'render' : steps.join(', ')})`);
  post({ type: 'progress', done, total, found: { ...found }, failed });
  let lastPost = 0;
  for (const { r, files, sig } of work) {
    if (shouldStop()) break;
    const hasStl = r.thumb_source === 'stl';
    // scope=all on a rendered card: only look for real pictures
    const stepsHere = hasStl ? want.replace('r', '') : want;
    let res;
    try {
      res = await findPictures({ files, uuid: r.uuid, hint: r.render_zip_hint || r.creator_hint || null, steps: stepsHere, log, shouldStop });
    } catch (e) {
      if (e.message === 'stopped') break;
      log('warn', `  ${r.name}: ${e.message}`);
      res = { images: [], source: null, tried: stepsHere };
    }
    const attempt = nextAttempt(r.thumb_attempt, sig, stepsHere || want);
    if (res.images.length) {
      const m = mergeImages(r, res.images, res.source);
      setPics.run(JSON.stringify(m.images), m.thumbnail_path, m.thumb_source, attempt, r.id);
      const key = res.source === 'archive-peek' ? 'peek' : res.source;
      if (found[key] !== undefined) found[key]++;
      log('img', `  ✓ ${r.name}: ${res.images.length} picture(s) (${res.source})`);
    } else {
      setAttempt.run(attempt, r.id);
      if (!hasStl) failed++;
    }
    done++;
    if (Date.now() - lastPost > 250 || done === total) { post({ type: 'progress', done, total, found: { ...found }, failed }); lastPost = Date.now(); }
    await new Promise(res2 => setImmediate(res2));
  }
  return { done, total, found, failed };
}

module.exports = {
  PIPELINE_VERSION, pipelineVersion, filesSig, parseAttempt, covered, nextAttempt,
  peekArchives, peekScore, chooseMeshes, meshCandidates, meshKind, renderPreview, findPictures, mergeImages, fillJob,
  PREVIEW_NAME, PEEK_MIN_BYTES, PEEK_TAKE,
};
