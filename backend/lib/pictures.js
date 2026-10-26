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
const rarLib = require('./rar');
/** Inner zips (and RAR mesh entries) we open: 64 MB uncompressed (INNER_ZIP_MAX_MB overrides). */
function innerMax() {
  const mb = parseFloat(process.env.INNER_ZIP_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 64) * 1024 * 1024;
}
const INNER_ZIP_TAKE = 3;

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

/** A temp file path under IMAGES_DIR/.tmp (deleted by the caller). */
function tempFile(ext = '') {
  const dir = path.join(imagesDir(), '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}${ext}`);
}
/** Temp files left by a worker that was stopped mid-way (older than an hour). */
function cleanStaleTemps() {
  const dir = path.join(imagesDir(), '.tmp');
  let list; try { list = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 3600 * 1000;
  for (const n of list) { try { const p = path.join(dir, n); if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}
const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

/** Files of a .zip (central directory) or .rar (headers, read from disk): [{ name, size }]. */
async function listArchive(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') {
    if (zipLib.zipTooBig(file)) return [];
    return (await zipLib.listZip(file)).filter(e => !e.isDirectory).map(e => ({ name: e.name, size: e.size }));
  }
  if (ext === '.rar') return rarLib.listRar(file);
  return [];
}

const isImageName = (n) => IMAGE_EXTS.has(path.extname(n).toLowerCase());
const isZipName = (n) => path.extname(n).toLowerCase() === '.zip';

/**
 * Inner zips of the card's zips (Google Drive exports wrap the original zips), at most
 * innerMax() each: [{ outer, name, size, render }], render-named first, then smallest.
 */
function rankInnerZips(list) {
  const { isRenderArchive } = scanner();
  return list.map(z => ({ ...z, render: isRenderArchive(path.basename(z.name)) }))
    .sort((a, b) => (b.render - a.render) || (a.size - b.size));
}

/** Stream an inner zip to a temp file. Returns the temp path (caller deletes it). */
async function innerZipToTemp(outer, name) {
  const tmp = tempFile('.zip');
  try { await zipLib.extractEntryToFile(outer, name, tmp, innerMax()); return tmp; } catch (e) { rmQuiet(tmp); throw e; }
}

/**
 * Read only the directories of a card's archives (zip central directory, RAR headers from disk),
 * rank image entries >= 20 KB across all of them and extract the best PEEK_TAKE into
 * IMAGES_DIR/<uuid>/. Inner zips of up to 64 MB (Drive exports) are streamed to a temp file and
 * peeked the same way: up to 3, render-named first, then smallest (others only while nothing was
 * found). Returns /images/... URLs.
 */
async function peekArchives(archives, uuid, log = () => {}) {
  const cands = [];
  const inner = [];
  const temps = [];
  const addImages = (entries, archive, archiveName) => {
    for (const e of entries) {
      if (!isImageName(e.name) || e.size < PEEK_MIN_BYTES || e.size > zipLib.imageMaxBytes()) continue;
      cands.push({ archive, ext: path.extname(archive).toLowerCase(), name: e.name, size: e.size, score: peekScore(e.name, e.size, archiveName) });
    }
  };
  try {
    for (const a of peekOrder(archives)) {
      let entries;
      try { entries = await listArchive(a.path); } catch (e) { log('warn', `    could not read ${path.basename(a.path)}: ${e.message}`); continue; }
      addImages(entries, a.path, path.basename(a.path));
      if (isZipName(a.path)) {
        for (const e of entries) if (isZipName(e.name) && e.size <= innerMax()) inner.push({ outer: a.path, name: e.name, size: e.size });
      }
    }
    let opened = 0;
    for (const z of rankInnerZips(inner)) {
      if (opened >= INNER_ZIP_TAKE) break;
      if (!z.render && cands.length) break;
      let tmp;
      try { tmp = await innerZipToTemp(z.outer, z.name); } catch (e) { log('warn', `    could not open ${path.basename(z.name)}: ${e.message}`); continue; }
      temps.push(tmp);
      opened++;
      try { addImages(await listArchive(tmp), tmp, path.basename(z.name)); } catch (e) { log('warn', `    could not read ${path.basename(z.name)}: ${e.message}`); }
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
    const saved = new Map(); // safe name → url
    for (const [archive, list] of byArchive) {
      try {
        const got = list[0].ext === '.rar'
          ? await rarLib.extractRar(archive, dest, list.map(c => c.name), { maxBytes: zipLib.imageMaxBytes() })
          : await zipLib.extractZipImages(archive, dest, { select: list.map(c => c.name) });
        for (const n of got) saved.set(n, `/images/${uuid}/${n}`);
      } catch (e) { log('warn', `    could not extract from ${path.basename(archive)}: ${e.message}`); }
    }
    return picked.map(c => saved.get(zipLib.safeName(c.name))).filter(Boolean);
  } finally {
    temps.forEach(rmQuiet);
  }
}

// ── step r: which mesh to render ────────────────────────────────────────────

const SKIP_RE = /(^|[^a-z])(supports?|support[ _-]?only|test|tests|calibration|calib|tolerance|raft|sprue|cube)([^a-z]|$)/i;
const BASE_ONLY_RE = /^(base|bases|plinth|stand|pedestal|display[ _-]?base|round[ _-]?base|square[ _-]?base)([ _-]*\d+)?$/i;
const PRESUP_RE = /pre[ _-]?supp?orted|pre[ _-]?supports?|presup|(^|[^a-z])supported|(^|[^a-z])sup([^a-z]|$)|with[ _-]?supports?/i;
const UNSUP_RE = /un[ _-]?supported|no[ _-]?supports?|without[ _-]?supports?|unsup/i;

function meshKind(name) {
  const stem = path.basename(name, path.extname(name));
  if (SKIP_RE.test(stem) && !/supported/i.test(stem)) return 'skip';
  if (BASE_ONLY_RE.test(stem.trim())) return 'skip';
  return 'mesh';
}
const supPenalty = (p) => (UNSUP_RE.test(p) ? 0 : (PRESUP_RE.test(p) ? 1 : 0));

/** The longest common folder prefix of candidate ids (so the card's own path never counts). */
function commonPrefix(ids) {
  if (!ids.length) return '';
  let pre = ids[0];
  for (const id of ids) { let k = 0; while (k < pre.length && k < id.length && pre[k] === id[k]) k++; pre = pre.slice(0, k); }
  const cut = Math.max(pre.lastIndexOf('/'), pre.lastIndexOf('::'));
  return cut >= 0 ? pre.slice(0, cut + 1) : '';
}

/**
 * Choose what to render from mesh candidates [{ id, name, dir, size, source, packed? }]:
 * the parts of one folder together when they look like one model, else the largest single mesh.
 * Unsupported geometry wins over presupported (wherever it is); then loose files over files
 * inside archives; then the most data.
 * @returns {{ parts: object[], mode: 'parts'|'single', presupported: boolean } | null}
 */
function chooseMeshes(cands) {
  const ok = cands.filter(c => MESH_EXTS.has(path.extname(c.name).toLowerCase()) && meshKind(c.name) === 'mesh' && c.size > 84);
  if (!ok.length) return null;
  const pre = commonPrefix(ok.map(c => c.id));
  const rel = (s) => (s.startsWith(pre) ? s.slice(pre.length) : s);
  const groups = new Map();
  for (const c of ok) { if (!groups.has(c.dir)) groups.set(c.dir, []); groups.get(c.dir).push(c); }
  const scored = [...groups.values()].map(list => {
    const total = list.reduce((sum, c) => sum + c.size, 0);
    const pen = supPenalty(rel(list[0].dir + '/')) + list.filter(c => supPenalty(c.name)).length / list.length;
    return { list, total, pen, packed: list[0].packed ? 1 : 0 };
  }).sort((a, b) => (a.pen - b.pen) || (a.packed - b.packed) || (b.total - a.total));
  const best = scored[0];
  // drop exact duplicates (same size and extension: alternative exports of the same part)
  const seen = new Set();
  const parts = best.list.filter(c => { const k = `${c.size}:${path.extname(c.name).toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const estTris = parts.reduce((sum, c) => sum + meshRender.estimateTriangles(c.name, c.size), 0);
  if (parts.length >= 2 && parts.length <= RENDER_MAX_PARTS && best.total <= RENDER_MAX_BYTES && estTris <= RENDER_MAX_TRIANGLES) {
    return { parts: parts.sort((a, b) => b.size - a.size), mode: 'parts', presupported: best.pen > 0 };
  }
  // the largest single mesh, unsupported first
  const pen1 = (c) => supPenalty(rel(c.id));
  const single = ok.slice().sort((a, b) => (pen1(a) - pen1(b)) || ((a.packed ? 1 : 0) - (b.packed ? 1 : 0)) || (b.size - a.size))[0];
  return { parts: [single], mode: 'single', presupported: pen1(single) > 0 };
}

/**
 * Mesh candidates of a card: loose files, and entries inside its zips (central directory) and
 * RARs (headers read from disk; entries up to 64 MB, extracted to a temp file when chosen).
 */
async function meshCandidates(files, { includeZips = true, log = () => {} } = {}) {
  const loose = [];
  const archives = [];
  for (const f of files) {
    const p = f.filepath || f.abs || f.path;
    const name = f.filename || f.name || path.basename(p);
    const ext = path.extname(name).toLowerCase();
    const size = f.filesize ?? f.size ?? 0;
    if (MESH_EXTS.has(ext)) loose.push({ id: p, name, dir: path.dirname(p), size, label: name, source: { kind: 'file', path: p } });
    else if (ARCHIVE_EXTS.has(ext)) archives.push({ path: p, size });
  }
  if (!includeZips) return { loose, inZip: [] };
  const inZip = [];
  for (const a of archives.sort((x, y) => x.size - y.size).slice(0, PEEK_MAX_ARCHIVES)) {
    const isRar = path.extname(a.path).toLowerCase() === '.rar';
    try {
      for (const e of await listArchive(a.path)) {
        if (!MESH_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        if (isRar && e.size > innerMax()) continue;
        inZip.push({
          id: `${a.path}::${e.name}`, name: path.basename(e.name), dir: `${a.path}::${path.posix.dirname(e.name)}`, size: e.size, packed: true,
          label: `${path.basename(a.path)} › ${e.name}`,
          source: isRar ? { kind: 'rar', rarPath: a.path, entry: e.name } : { kind: 'zip', zipPath: a.path, entry: e.name },
        });
      }
    } catch (e) { log('warn', `    could not list ${path.basename(a.path)}: ${e.message}`); }
  }
  return { loose, inZip };
}

/**
 * Meshes inside inner zips (<= 64 MB) of the card's zips. Each inner zip is streamed to a temp
 * file (pushed to `temps`, deleted by the caller). Unsupported-named first, then smallest; up to 3.
 */
async function nestedMeshCandidates(files, temps, { log = () => {}, only = null } = {}) {
  const inner = [];
  for (const f of files) {
    const p = f.filepath || f.abs || f.path;
    if (!isZipName(p) || (only && only.outer !== p)) continue;
    try {
      for (const e of await listArchive(p)) if (isZipName(e.name) && e.size <= innerMax() && (!only || only.name === e.name)) inner.push({ outer: p, name: e.name, size: e.size });
    } catch (e) { log('warn', `    could not list ${path.basename(p)}: ${e.message}`); }
  }
  inner.sort((a, b) => (supPenalty(a.name) - supPenalty(b.name)) || (a.size - b.size));
  const out = [];
  for (const z of inner.slice(0, INNER_ZIP_TAKE)) {
    let tmp;
    try { tmp = await innerZipToTemp(z.outer, z.name); } catch (e) { log('warn', `    could not open ${path.basename(z.name)}: ${e.message}`); continue; }
    temps.push(tmp);
    try {
      for (const e of await listArchive(tmp)) {
        if (!MESH_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        const id = `${z.outer}::${z.name}::${e.name}`;
        out.push({ id, name: path.basename(e.name), dir: `${z.outer}::${z.name}::${path.posix.dirname(e.name)}`, size: e.size, packed: true,
          label: `${path.basename(z.outer)} › ${z.name} › ${e.name}`, source: { kind: 'zip', zipPath: tmp, entry: e.name } });
      }
    } catch (e) { log('warn', `    could not read ${path.basename(z.name)}: ${e.message}`); }
  }
  return out;
}

/** RAR entries become temp files before rendering (the renderer streams files and zip entries). */
async function materialize(parts, temps) {
  const out = [];
  for (const p of parts) {
    if (p.source.kind !== 'rar') { out.push(p.source); continue; }
    const dir = rarLib.tempDir('mesh');
    temps.push(dir);
    const ext = path.extname(p.source.entry).toLowerCase();
    const got = await rarLib.extractRar(p.source.rarPath, dir, [p.source.entry], { maxBytes: innerMax(), rename: () => `mesh${ext}` });
    if (!got.length) throw new Error(`could not extract ${p.source.entry}`);
    out.push({ kind: 'file', path: path.join(dir, got[0]) });
  }
  return out;
}

/**
 * Render a card's model to IMAGES_DIR/<uuid>/stl-preview.png.
 * @param {object[]} files card files ({ filepath, filename, filesize })
 * @param {string} uuid
 * @param {{ file?: string, log?: Function, shouldStop?: Function }} [opts] file: a mesh path,
 *   "archive::entry" or "zip::inner.zip::entry"
 * @returns {Promise<{ url: string, triangles: number, ms: number, parts: string[] } | null>}
 */
async function renderPreview(files, uuid, opts = {}) {
  const log = opts.log || (() => {});
  const temps = [];
  try {
    let choice = null;
    if (opts.file) {
      const segs = String(opts.file).split('::');
      let pool;
      if (segs.length >= 3) pool = await nestedMeshCandidates(files, temps, { log, only: { outer: segs[0], name: segs[1] } });
      else { const { loose, inZip } = await meshCandidates(files, { includeZips: segs.length === 2, log }); pool = [...loose, ...inZip]; }
      const hit = pool.find(c => c.id === opts.file);
      if (!hit) throw new Error('That file is not a mesh of this card');
      choice = { parts: [hit], mode: 'single', presupported: false };
    } else {
      const { loose, inZip } = await meshCandidates(files, { log });
      choice = chooseMeshes([...loose, ...inZip]);
      // nothing renderable, or only presupported geometry: look inside small inner zips too
      if (!choice || choice.presupported) {
        const nested = await nestedMeshCandidates(files, temps, { log });
        const alt = nested.length ? chooseMeshes([...loose, ...inZip, ...nested]) : null;
        if (alt && (!choice || !alt.presupported)) choice = alt;
      }
    }
    if (!choice) return null;
    const run = async (parts) => meshRender.renderMeshes(await materialize(parts, temps), {
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
    const drawn = (res.parts && res.parts.length && res.parts.length <= choice.parts.length && res.parts.every(i => i >= 0))
      ? res.parts.map(i => choice.parts[i]) : choice.parts;
    log('img', `    ◆ rendered ${drawn.map(p => p.label).join(', ')}${res.assembly === false ? ' (parts are laid out apart: largest part only)' : ''} (${res.triangles.toLocaleString('en-US')} triangles, ${res.ms.total} ms)`);
    return { url: `/images/${uuid}/${PREVIEW_NAME}`, triangles: res.triangles, ms: res.ms.total, parts: drawn.map(p => p.id), upAxis: res.upAxis, assembly: res.assembly };
  } finally {
    temps.forEach(rmQuiet);
  }
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
  cleanStaleTemps();
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
  peekArchives, peekScore, chooseMeshes, meshCandidates, nestedMeshCandidates, meshKind, supPenalty, renderPreview, findPictures, mergeImages, fillJob,
  PREVIEW_NAME, PEEK_MIN_BYTES, PEEK_TAKE,
};
