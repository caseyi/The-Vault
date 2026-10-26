const express = require('express');
const path = require('path');
const fs = require('fs');

// Move to a stable, simple working directory before anything spawns a worker.
// When launched from a macOS .app bundle the inherited cwd can make
// worker_threads fail with "uv_cwd ENOENT"; chdir to the data dir (or temp)
// avoids it. chdir takes an absolute path, so it works even if the current cwd
// is already broken.
try {
  const cwdTarget = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : require('os').tmpdir();
  fs.mkdirSync(cwdTarget, { recursive: true });
  process.chdir(cwdTarget);
} catch {}

const db = require('./db');
const { LIBRARY_PATH, pickRenderArchives, analyzeFolder, extractImagesFromArchive, analysisFromFiles, realFolder } = require('./scanner');
const metaSummaryLib = require('./lib/meta-summary');
const metaLib = require('./lib/meta');
const librariesLib = require('./lib/libraries');
const zipLib = require('./lib/zip');
const { scrapeImagesFromUrl, detectUrlFromFolderName } = require('./scraper');
const organizeRouter = require('./organize');
const { wrapAsyncRoutes, originPolicy, spendGuard, errorHandler } = require('./lib/middleware');
const guardSpend = spendGuard();
const { confinePath, tryConfine, sendPathError, imageUrlToFile, isSafeImageUrl } = require('./lib/paths');
const { openSSE } = require('./lib/sse');
const { acquireOr409 } = require('./lib/jobs');
const { callClaudeAPI } = require('./lib/claude');
const enrich = require('./lib/enrich');
const organizerExport = require('./lib/organizer-export');
const folderRolesLib = require('./lib/folder-roles');
const { folderRolesRouter } = require('./folder-roles-routes');
const thumbs = require('./lib/thumbs');
const pictures = require('./lib/pictures');

const app = wrapAsyncRoutes(express());
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';

/** Escape LIKE wildcards so user text matches literally (use with ESCAPE '\\'). */
const likeEscape = (s) => String(s).replace(/[\\%_]/g, '\\$&');
/** Parse a positive integer query param, clamped to [min, max]. */
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Version info — auto-incremented by pre-commit hook
let APP_VERSION = { version: '0.0.0', build: 0 };
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch {}

app.disable('x-powered-by');
app.use(originPolicy());
app.use(express.json({ limit: '10mb' }));
// names can be reused (re-extract), so a week + ETag rather than immutable; /thumbs URLs carry a version
app.use('/images', express.static(IMAGES_DIR, { maxAge: 7 * 24 * 3600 * 1000, etag: true }));
app.get('/thumbs/*', thumbs.serveThumb);
app.use('/api/organize', organizeRouter);
// folder roles (docs/folder-roles.md): marks from _Meta/folder_roles.csv and the app
app.use('/api/folder-roles', folderRolesRouter({ db, root: LIBRARY_PATH, getLibraries: () => librariesFor() }));

// ── Library metadata (_Meta) cache ────────────────────────────────────────────
// /api/meta/* and /api/attribution/* use a plain summary of _Meta (lib/meta-summary.js).
// Every scan sends a fresh one; otherwise meta-worker.js builds it off the main thread.
const META_LOAD_TIMEOUT_MS = 60000;
let metaSummary = null;
let metaLoading = null;
function loadMetaSummary() {
  if (metaLoading) return metaLoading;
  metaLoading = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let w;
    try {
      w = new Worker(path.join(__dirname, 'meta-worker.js'), { workerData: { root: LIBRARY_PATH }, env: { ...process.env } });
    } catch (e) { done(metaSummaryLib.failed(`_Meta could not be loaded: ${e.message}`)); return; }
    const timer = setTimeout(() => { done(metaSummaryLib.failed(`_Meta took longer than ${META_LOAD_TIMEOUT_MS / 1000}s to load`)); w.terminate(); }, META_LOAD_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    w.once('message', done);
    w.once('error', (e) => done(metaSummaryLib.failed(`_Meta could not be loaded: ${e.message}`)));
    w.once('exit', (code) => done(metaSummaryLib.failed(`_Meta loader exited (${code})`)));
  }).then((sum) => { metaSummary = sum; metaLoading = null; return sum; });
  return metaLoading;
}
async function getMetaSummary({ reload = false } = {}) {
  if (metaSummary && !reload) return metaSummary;
  return loadMetaSummary();
}
const parseJSON = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

/**
 * New pictures appended after a card's existing ones (scrape, zip picker). The thumbnail stays
 * unless the card had none or only a mesh render; a user-chosen thumbnail always stays.
 */
function appendPictures(model, saved, source) {
  const prev = parseJSON(model.images || '[]', []);
  const m = pictures.mergeImages(model, saved, source);
  // keep the old order (existing first), except that a mesh render goes last
  const renders = prev.filter(i => m.images.indexOf(i) >= 0 && model.thumb_source === 'stl' && i.endsWith('/' + pictures.PREVIEW_NAME));
  const images = [...new Set([...prev.filter(i => !renders.includes(i)), ...saved, ...renders])];
  return { images, thumbnail_path: m.thumbnail_path || images[0] || null, thumb_source: m.thumb_source };
}

/** Libraries (top-level folders) with their labels: the health cache, else read now. */
function librariesSync() {
  if (healthCache.libraries && healthCache.libraries.length) return healthCache.libraries;
  return librariesLib.listLibraries(LIBRARY_PATH, metaSummary?.libraryLabels);
}
async function librariesFor() {
  try { await getMetaSummary(); } catch { /* labels from LIBRARY_LABELS only */ }
  return librariesSync();
}

/**
 * The card's folders from the library root down to its real folder, each with its effective role
 * (breadcrumb with roles on the card detail).
 */
function folderRolesFor(model) {
  const real = require('./lib/works').realFolder(model.folder_path || '');
  if (!real) return [];
  const libs = librariesSync();
  const lr = folderRolesLib.libRel(real, libs);
  const top = lr.root || (real === LIBRARY_PATH || real.startsWith(LIBRARY_PATH + path.sep) ? LIBRARY_PATH : null);
  if (!top) return [];
  let merged;
  try { merged = folderRolesLib.effectiveRoles(db, LIBRARY_PATH, libs).merged; } catch { merged = new Map(); }
  const chain = [];
  for (let d = real; ; d = path.dirname(d)) {
    chain.unshift(d);
    if (d === top || d.length <= top.length || d === path.dirname(d)) break;
  }
  return chain.map(d => {
    const e = merged.get(d);
    return { path: d, rel: path.relative(top, d).split(path.sep).join('/'), name: path.basename(d), role: e ? e.role : null, source: e ? e.source : null };
  });
}

// ── Scan ──────────────────────────────────────────────────────────────────────

let scanInProgress = false;
let scanLog = [];       // running log lines — ring buffer of the last SCAN_LOG_MAX
let scanLogDropped = 0; // lines shifted out of the ring (absolute index = dropped + i)
let scanSummary = null; // final result
const SCAN_LOG_MAX = 2000;
const SCAN_STATUS_LINES = 500;

function pushLog(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg };
  scanLog.push(line);
  if (scanLog.length > SCAN_LOG_MAX) {
    const drop = scanLog.length - SCAN_LOG_MAX;
    scanLog.splice(0, drop);
    scanLogDropped += drop;
  }
  return line;
}

// A scan that never reported back (cancelled / crashed worker) must not leave
// its scan_log row stuck at 'running'.
function markRunningScans(status, error) {
  try {
    db.prepare(`UPDATE scan_log SET status = ?, error = COALESCE(error, ?), finished_at = datetime('now') WHERE status = 'running'`)
      .run(status, error || null);
  } catch (e) {
    console.error('[scan] could not update scan_log:', e.message);
  }
}

// Scans run in a worker thread so heavy/synchronous filesystem work never blocks
// the main server. The main thread owns scan state and relays worker messages.
const { Worker } = require('worker_threads');
let scanWorker = null;
let scanProgress = { count: 0, last: '' }; // lightweight live progress for the global indicator

function startScanWorker(workerData, startLogLines) {
  scanInProgress = true;
  scanLog = [];
  scanLogDropped = 0;
  scanSummary = null;
  scanProgress = { count: 0, last: '' };
  for (const [level, msg] of startLogLines) pushLog(level, msg);

  // env passed explicitly: jest sandboxes process.env, and a worker would otherwise see the real one
  scanWorker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData, env: { ...process.env } });

  scanWorker.on('message', (m) => {
    if (m.type === 'log') {
      pushLog(m.level, m.msg);
      if (m.level === 'scan') scanProgress.count++;
      if (m.msg) scanProgress.last = String(m.msg).trim();
    } else if (m.type === 'done') {
      if (m.success) {
        const { metaSummary: freshMeta, ...r } = m.result || {};
        pushLog('success', `✓ Scan complete — ${r.modelsFound ?? 0} found · ${r.modelsAdded ?? 0} added · ${r.modelsUpdated ?? 0} updated · ${r.modelsSkipped ?? 0} skipped`);
        scanSummary = { type: 'done', success: true, ...r };
        metaSummary = freshMeta || null; // the scan's own _Meta; null → reloaded off-thread on demand
        gapsCache = null;
        refreshHealthCache();
        afterScanPictures();
      } else {
        pushLog('error', `✗ Error: ${m.error}`);
        scanSummary = { type: 'done', success: false, error: m.error };
      }
      scanInProgress = false;
    }
  });

  scanWorker.on('error', (err) => {
    pushLog('error', `✗ Worker error: ${err.message}`);
    scanSummary = { type: 'done', success: false, error: err.message };
    markRunningScans('error', err.message);
    scanInProgress = false;
    scanWorker = null;
  });

  scanWorker.on('exit', () => {
    // Finalize state if the worker died without sending a 'done' message
    if (scanInProgress && !scanSummary) {
      scanSummary = { type: 'done', success: false, error: 'Scan ended unexpectedly' };
      pushLog('error', scanSummary.error);
      markRunningScans('error', scanSummary.error);
    }
    scanInProgress = false;
    scanWorker = null;
  });
}

// SSE stream — client connects and receives log lines in real time
app.get('/api/scan/stream', (req, res) => {
  const sse = openSSE(req, res);
  const send = (data) => sse.send(data);

  // Replay existing log lines for late-joiners
  scanLog.forEach(line => send(line));
  if (scanSummary) { sse.end({ type: 'done', ...scanSummary }); return; }
  if (!scanInProgress) { sse.end({ type: 'idle' }); return; }

  // Subscribe to new log lines by polling the ring buffer's absolute position
  let lastAbs = scanLogDropped + scanLog.length;
  const interval = setInterval(() => {
    const endAbs = scanLogDropped + scanLog.length;
    if (lastAbs < scanLogDropped) lastAbs = scanLogDropped; // fell behind the ring; skip dropped lines
    while (lastAbs < endAbs) send(scanLog[lastAbs++ - scanLogDropped]);
    if (!scanInProgress) {
      clearInterval(interval);
      sse.end(scanSummary ? { type: 'done', ...scanSummary } : undefined);
    }
  }, 150);

  sse.onAbort(() => clearInterval(interval));
});

app.post('/api/scan', (req, res) => {
  if (scanInProgress) return res.status(409).json({ error: 'Scan already in progress' });
  let libPath;
  try { libPath = confinePath(req.body?.path || LIBRARY_PATH); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  const force = req.body?.force === true;
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: `Path not found: ${libPath}` });

  res.json({ message: 'Scan started', path: libPath, force });

  startScanWorker({ mode: 'full', libPath, force }, [
    ['info', `Starting ${force ? 'FULL ' : ''}scan: ${libPath}`],
    ['info', 'Discovering creators and models…'],
  ]);
});

// Legacy status endpoint (still used by anything polling)
app.get('/api/scan/status', (req, res) => {
  const log = scanLog.length > SCAN_STATUS_LINES ? scanLog.slice(-SCAN_STATUS_LINES) : scanLog;
  const body = { inProgress: scanInProgress, log, summary: scanSummary };
  if (scanLogDropped > 0 || scanLog.length > SCAN_STATUS_LINES) body.truncated = true;
  res.json(body);
});

// Lightweight progress — for the app-wide background scan indicator (no full log)
app.get('/api/scan/progress', (req, res) => {
  res.json({
    inProgress: scanInProgress,
    count: scanProgress.count,
    last: scanProgress.last,
    summary: scanSummary
      ? { success: scanSummary.success, modelsFound: scanSummary.modelsFound, modelsAdded: scanSummary.modelsAdded, error: scanSummary.error }
      : null,
  });
});

// Cancel a running scan (terminates the worker thread)
app.post('/api/scan/cancel', async (req, res) => {
  if (!scanInProgress || !scanWorker) return res.json({ cancelled: false, message: 'No scan running' });
  pushLog('warn', 'Scan cancelled by user');
  scanSummary = { type: 'done', success: false, error: 'Scan cancelled' };
  try { await scanWorker.terminate(); } catch {}
  markRunningScans('cancelled', 'Scan cancelled by user');
  scanInProgress = false;
  scanWorker = null;
  res.json({ cancelled: true });
});

// Per-creator rescan — scans a single creator's folder using the shared SSE machinery
app.post('/api/scan/creator/:id', async (req, res) => {
  if (scanInProgress) return res.status(409).json({ error: 'Scan already in progress' });
  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Creator not found' });
  if (!creator.folder_path) return res.status(400).json({ error: 'Creator has no folder path' });
  try { confinePath(creator.folder_path); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  if (!fs.existsSync(creator.folder_path)) return res.status(400).json({ error: `Folder not found: ${creator.folder_path}` });

  res.json({ message: 'Creator scan started', creator: creator.name, path: creator.folder_path });

  startScanWorker(
    { mode: 'creator', folderPath: creator.folder_path, creatorId: creator.id, creatorName: creator.name },
    [
      ['info', `Scanning creator: ${creator.name}`],
      ['info', `Path: ${creator.folder_path}`],
    ]
  );
});

// ── Models ─────────────────────────────────────────────────────────────────────

const SORT_MAP = {
  name:       'm.name ASC',
  creator:    'c.name ASC, m.name ASC',
  date_added: 'm.created_at DESC',
  updated:    'm.updated_at DESC',
  status:     'm.print_status ASC, m.name ASC',
};

/**
 * Filters shared by /api/models and /api/export for the library-metadata fields:
 * library, studio, genre (= franchise), term, kind, attributed, source, confidence.
 * Tools (kind = 'tool') are hidden unless kind=tool or includeTools=1.
 */
function addLayoutFilters(q, where, params) {
  const kinds = q.kind ? String(q.kind).split(',').map(k => k.trim()).filter(Boolean) : [];
  if (kinds.length) {
    where.push(`COALESCE(m.kind, 'model') IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  } else if (q.includeTools !== '1' && q.includeTools !== 'true' && q.favorite !== '1') {
    // a favorite tool stays reachable: the favorites filter lists it
    where.push(`COALESCE(m.kind, 'model') != 'tool'`);
  }
  if (q.library) {
    where.push(`(m.library = ? OR m.libraries LIKE ? ESCAPE '\\')`);
    params.push(String(q.library), `%"${likeEscape(q.library)}"%`);
  }
  if (q.studio) { where.push('m.studio = ?'); params.push(String(q.studio)); }
  if (q.genre) { where.push('m.franchise = ?'); params.push(String(q.genre)); }
  if (q.term) {
    const t = String(q.term);
    if (/^\d{4}$/.test(t)) { where.push('m.release_term LIKE ?'); params.push(`${t}-%`); }
    else { where.push('m.release_term = ?'); params.push(t); }
  }
  if (q.source) { where.push('m.source = ?'); params.push(String(q.source)); }
  if (q.confidence) { where.push(`COALESCE(m.confidence, 'none') = ?`); params.push(String(q.confidence)); }
  if (q.attributed === 'yes') where.push(`m.confidence IN ('sidecar','exact','name')`);
  else if (q.attributed === 'no') where.push(`(m.confidence IS NULL OR m.confidence IN ('none','path'))`);
}

/** List item: existing fields + parsed layout fields; heavy JSON (products) only on the detail route. */
function shapeModel(m) {
  const { products, attribution, enrichment, thumb_attempt, ...rest } = m;
  const images = parseJSON(m.images || '[]', []);
  const cardImgs = thumbs.cardImages(images, m.thumbnail_path);
  const thumbUrls = cardImgs.map(i => thumbs.thumbUrl(i, 480)).filter(Boolean);
  return {
    ...rest,
    tags: parseJSON(m.tags || '[]', []),
    images,
    thumb_url: m.thumbnail_path ? thumbs.thumbUrl(m.thumbnail_path, 480) : (thumbUrls[0] || null),
    thumb_urls: thumbUrls,
    thumb_source: m.thumb_source || null,
    kind: m.kind || 'model',
    libraries: parseJSON(m.libraries, m.library ? [m.library] : []),
    editions: parseJSON(m.editions, []),
    confidence: m.confidence || null,
  };
}

app.get('/api/models', (req, res) => {
  const { search, creator, status, tags, franchise, collection, folder, favorite, show_hidden, has_thumbnail, recently_added, sort } = req.query;
  const page = clampInt(req.query.page, 1, 1, 1e6);
  const limit = clampInt(req.query.limit, 48, 1, 500);
  const offset = (page - 1) * limit;

  let where = ['1=1'];
  const params = [];

  // Hide hidden models by default; show_hidden=1 to include them. Rows folded into a work by the
  // regroup are never listed (show_folded=1 for diagnostics): their files and data live on the work.
  if (!show_hidden || show_hidden === '0') {
    where.push('(m.hidden IS NULL OR m.hidden = 0)');
  }
  if (req.query.show_folded !== '1') where.push('m.folded_into IS NULL');

  // Thumbnail filter
  if (has_thumbnail === '1') {
    where.push('m.thumbnail_path IS NOT NULL');
  }

  // Favorites filter (favorite tools are listed too: see addLayoutFilters)
  if (favorite === '1') {
    where.push('m.is_favorite = 1');
  }

  // Recently added: models created since the last scan started
  if (recently_added === '1') {
    const lastScan = db.prepare('SELECT started_at FROM scan_log ORDER BY id DESC LIMIT 1').get();
    if (lastScan?.started_at) {
      where.push('m.created_at >= ?');
      params.push(lastScan.started_at);
    }
  }

  // Franchise filter
  if (franchise) {
    where.push('m.franchise = ?');
    params.push(franchise);
  }

  // Collection filter — join collection_models
  if (collection) {
    where.push('m.id IN (SELECT model_id FROM collection_models WHERE collection_id = ?)');
    params.push(collection);
  }

  // Folder filter — models whose folder_path is at or beneath the given prefix.
  // `folder` is an absolute container path (e.g. /library/STL Archive/SomeCreator)
  // as supplied by /api/library/tree.
  if (folder) {
    // works sharing a folder carry a virtual "<folder>#<slug>" path
    where.push("(m.folder_path = ? OR m.folder_path LIKE ? ESCAPE '\\' OR m.folder_path LIKE ? ESCAPE '\\')");
    const f = likeEscape(String(folder).replace(/\/+$/, ''));
    params.push(folder, f + '/%', f + '#%');
  }
  addLayoutFilters(req.query, where, params);

  if (search) {
    where.push("(m.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.notes LIKE ? ESCAPE '\\' OR m.character LIKE ? ESCAPE '\\' OR m.group_name LIKE ? ESCAPE '\\')");
    const s = `%${likeEscape(search)}%`;
    params.push(s, s, s, s, s, s);
  }
  if (creator) { where.push('c.name = ?'); params.push(creator); }
  if (status) { where.push('m.print_status = ?'); params.push(status); }
  if (tags) {
    const tagList = String(tags).split(',');
    tagList.forEach(t => { where.push("m.tags LIKE ? ESCAPE '\\'"); params.push(`%"${likeEscape(t.trim())}"%`); });
  }

  const whereStr = where.join(' AND ');
  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM models m LEFT JOIN creators c ON m.creator_id = c.id WHERE ${whereStr}
  `).get(...params).cnt;

  const orderBy = SORT_MAP[sort] || 'c.name ASC, m.name ASC';
  const models = db.prepare(`
    SELECT m.*, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE ${whereStr}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    models: models.map(shapeModel),
    total,
    page,
    pages: Math.ceil(total / limit)
  });
});

// Common tags across a set of models (for bulk tag editor)
app.get('/api/models/common-tags', (req, res) => {
  const raw = req.query.ids || '';
  const ids = raw.split(',').map(Number).filter(Boolean);
  if (!ids.length) return res.json({ allTags: [], commonTags: [] });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT tags FROM models WHERE id IN (${placeholders})`).all(...ids);
  const tagSets = rows.map(r => { try { return new Set(JSON.parse(r.tags || '[]')); } catch { return new Set(); } });
  if (!tagSets.length) return res.json({ allTags: [], commonTags: [] });

  // allTags: union; commonTags: intersection (present in every selected model)
  const allTags = [...new Set(tagSets.flatMap(s => [...s]))].sort();
  const commonTags = allTags.filter(t => tagSets.every(s => s.has(t)));
  res.json({ allTags, commonTags });
});

app.get('/api/models/:id(\\d+)', (req, res) => {
  const model = db.prepare(`
    SELECT m.*, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE m.id = ?
  `).get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const files = db.prepare('SELECT * FROM model_files WHERE model_id = ? ORDER BY release_name NULLS LAST, filetype, filename').all(model.id);
  const attribution = parseJSON(model.attribution, null);
  if (attribution) { delete attribution.sig; delete attribution.autoFranchise; delete attribution.sourceUrl; delete attribution.foldedInto; }
  const en = parseJSON(model.enrichment, null);
  // other releases of the same creator + character ("Daredevil (2025)" next to "Daredevil (Netflix)")
  const relBase = model.work_key && model.work_key.includes('|r:') ? model.work_key.slice(0, model.work_key.indexOf('|r:')) : null;
  const siblings = relBase ? db.prepare(`SELECT id, name, release_term, release_label, editions FROM models
      WHERE work_key LIKE ? ESCAPE '\\' AND id != ? AND folded_into IS NULL ORDER BY release_term, name`)
    .all(`${likeEscape(relBase)}|r:%`, model.id).map(r => ({ ...r, editions: parseJSON(r.editions, []) })) : [];
  const shaped = shapeModel(model);
  res.json({
    ...shaped,
    thumb_urls: shaped.images.map(i => thumbs.thumbUrl(i, 1280)),
    siblings,
    enrichment: en && en.at ? { at: en.at, model: en.model || null, runId: en.runId || null } : null,
    suggestions: enrich.suggestionsFor(db, model.id),
    folderRoles: folderRolesFor(model),
    products: parseJSON(model.products, []).map(({ matchedBy, genre, creator, ...p }) => p),
    attribution: attribution || { confidence: model.confidence || 'none', fields: {}, matchedFiles: 0, totalFiles: files.length },
    files
  });
});

app.patch('/api/models/:id(\\d+)', (req, res) => {
  const { print_status, tags, notes, source_url, name, thumbnail_path, hidden, franchise, team, is_favorite, name_locked, character, group_name, editions } = req.body || {};
  if (editions !== undefined && editions !== null && !(Array.isArray(editions) && editions.every(e => ['Sculpture', 'Bust', 'Accessory', 'Diorama'].includes(e)))) {
    return res.status(400).json({ error: 'editions must be an array of Sculpture, Bust, Accessory, Diorama' });
  }
  // thumbnail_path must point at an extracted image under /images/ (or be cleared)
  if (thumbnail_path !== undefined && thumbnail_path !== null && thumbnail_path !== '' && !isSafeImageUrl(thumbnail_path)) {
    return res.status(400).json({ error: 'thumbnail_path must be an /images/... path' });
  }
  const model = db.prepare('SELECT id, print_status, folded_into, attribution FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });
  if (hidden !== undefined && !hidden && model.folded_into != null) {
    return res.status(409).json({
      error: `This card was folded into card #${model.folded_into} when the library was regrouped into works; its files and your tags, notes and collections are on that card now. Open it instead of unhiding this one.`,
      folded_into: model.folded_into,
    });
  }

  const updates = [];
  const params = [];
  if (print_status !== undefined) {
    // Log the status transition if it actually changed
    if (print_status !== model.print_status) {
      db.prepare(`INSERT INTO status_log (model_id, from_status, to_status) VALUES (?, ?, ?)`).run(
        req.params.id, model.print_status, print_status
      );
    }
    updates.push('print_status = ?'); params.push(print_status);
  }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (source_url !== undefined) { updates.push('source_url = ?'); params.push(source_url); }
  if (name !== undefined) {
    // A user rename is sticky: rescans must not overwrite it (name_locked)
    updates.push('name = ?'); params.push(name);
    if (name_locked === undefined) updates.push('name_locked = 1');
  }
  if (name_locked !== undefined) { updates.push('name_locked = ?'); params.push(name_locked ? 1 : 0); }
  if (thumbnail_path !== undefined) {
    // a thumbnail the user picked is theirs: scans and picture finding never replace it
    updates.push('thumbnail_path = ?'); params.push(thumbnail_path || null);
    updates.push('thumb_source = ?'); params.push(thumbnail_path ? 'user' : null);
  }
  if (hidden !== undefined) { updates.push('hidden = ?'); params.push(hidden ? 1 : 0); }
  if (franchise !== undefined) { updates.push('franchise = ?'); params.push(franchise || null); }
  if (team !== undefined) { updates.push('team = ?'); params.push(team || null); }
  if (is_favorite !== undefined) { updates.push('is_favorite = ?'); params.push(is_favorite ? 1 : 0); }
  if (character !== undefined) { updates.push('character = ?'); params.push(character || null); }
  if (group_name !== undefined) { updates.push('group_name = ?'); params.push(group_name || null); }
  if (editions !== undefined) { updates.push('editions = ?'); params.push(JSON.stringify(editions || [])); }
  // Fields the user set are theirs: rescans and AI enrichment never overwrite them (attribution.userFields)
  const userSet = Object.entries({ character, franchise, group_name, editions, tags, name }).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (userSet.length) {
    const attr = parseJSON(model.attribution, {});
    attr.userFields = [...new Set([...(Array.isArray(attr.userFields) ? attr.userFields : []), ...userSet])];
    attr.fields = { ...(attr.fields || {}) };
    for (const f of userSet) { attr.fields[f] = 'user'; if (attr.ai) delete attr.ai[f]; }
    if (tags !== undefined) {
      // tags the user took off are never proposed again; re-adding one lifts that
      const prevTags = parseJSON(db.prepare('SELECT tags FROM models WHERE id = ?').get(req.params.id).tags, []);
      const nowTags = new Set((tags || []).map(t => String(t).toLowerCase()));
      const removed = new Set([...(Array.isArray(attr.removedTags) ? attr.removedTags : []), ...prevTags.filter(t => !nowTags.has(String(t).toLowerCase()))]);
      attr.removedTags = [...removed].filter(t => !nowTags.has(String(t).toLowerCase())).slice(-200);
      if (!attr.removedTags.length) delete attr.removedTags;
    }
    updates.push('attribution = ?'); params.push(JSON.stringify(attr));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (userSet.length) {
    // the user decided these fields: pending proposals for them are moot
    db.prepare(`UPDATE suggestions SET status = 'superseded', decided_at = datetime('now') WHERE model_id = ? AND status = 'pending'
      AND ((type = 'field' AND field IN (${userSet.map(() => '?').join(',')})) ${userSet.includes('name') ? "OR type = 'rename'" : ''})`).run(req.params.id, ...userSet);
  }
  res.json({ success: true });
});

// Status history for a model
app.get('/api/models/:id(\\d+)/status-log', (req, res) => {
  const log = db.prepare(
    `SELECT id, from_status, to_status, note, changed_at FROM status_log WHERE model_id = ? ORDER BY id DESC`
  ).all(req.params.id);
  res.json(log);
});

// Toggle a single file as printed/unprinted
app.patch('/api/files/:fileId/printed', (req, res) => {
  const file = db.prepare('SELECT id, printed_at FROM model_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const newVal = file.printed_at ? null : new Date().toISOString();
  db.prepare('UPDATE model_files SET printed_at = ? WHERE id = ?').run(newVal, file.id);
  res.json({ printed_at: newVal });
});

// ── Creators ──────────────────────────────────────────────────────────────────

app.get('/api/creators', (req, res) => {
  const creators = db.prepare(`
    SELECT c.*, COUNT(m.id) as model_count
    FROM creators c LEFT JOIN models m ON m.creator_id = c.id
    GROUP BY c.id ORDER BY c.name ASC
  `).all();
  res.json(creators);
});

// Get/set the render ZIP hint for a creator (applies to all its models unless overridden)
app.get('/api/creators/:id/render-hint', (req, res) => {
  const creator = db.prepare('SELECT id, name, render_zip_hint FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });
  // Also return sample zip filenames from this creator's models so the UI can suggest them
  const zips = db.prepare(`
    SELECT DISTINCT mf.filename
    FROM model_files mf
    JOIN models m ON mf.model_id = m.id
    WHERE m.creator_id = ? AND mf.filetype = 'zip'
    ORDER BY mf.filename
  `).all(req.params.id).map(r => r.filename);
  res.json({ ...creator, available_zips: zips });
});

app.patch('/api/creators/:id/render-hint', (req, res) => {
  const { render_zip_hint } = req.body;
  db.prepare('UPDATE creators SET render_zip_hint = ? WHERE id = ?').run(render_zip_hint || null, req.params.id);
  res.json({ success: true });
});

// Merge one creator into another (moves all models, deletes source)
app.post('/api/creators/:id/merge', (req, res) => {
  const sourceId = parseInt(req.params.id);
  const targetId = parseInt(req.body?.targetCreatorId);
  if (!targetId || isNaN(targetId) || sourceId === targetId)
    return res.status(400).json({ error: 'Invalid targetCreatorId' });
  const source = db.prepare('SELECT id, name FROM creators WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id, name FROM creators WHERE id = ?').get(targetId);
  if (!source || !target) return res.status(404).json({ error: 'Creator not found' });
  const moved = db.transaction(() => {
    const n = db.prepare('UPDATE models SET creator_id = ? WHERE creator_id = ?').run(targetId, sourceId).changes;
    db.prepare('DELETE FROM creators WHERE id = ?').run(sourceId);
    return n;
  })();
  res.json({ moved, sourceCreator: source.name, targetCreator: target.name });
});

// Re-extract renders for all models belonging to a creator, using the current hint.
// Served for GET (the UI uses EventSource) and POST (older clients).
async function reextractCreator(req, res) {
  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });

  const sse = openSSE(req, res);
  const send = (level, msg) => sse.send({ level, msg, ts: new Date().toISOString() });

  const hint = creator.render_zip_hint || null;
  send('info', `Creator: ${creator.name}`);
  send('info', `Render ZIP hint: ${hint || '(auto-detect by keyword)'}`);

  const models = db.prepare('SELECT * FROM models WHERE creator_id = ?').all(creator.id);
  send('info', `Processing ${models.length} model(s)…`);

  let updated = 0, skipped = 0;
  for (const model of models) {
    if (sse.aborted) return;
    // Yield between models so a big creator doesn't monopolise the event loop
    await new Promise(r => setImmediate(r));
    const folder = realFolder(model.folder_path);
    if (!tryConfine(folder)) {
      send('warn', `  ⚠ ${model.name}: folder is outside the library, skipped`);
      skipped++;
      continue;
    }
    // Model-level hint overrides creator hint
    const effectiveHint = model.render_zip_hint || hint;
    // Works (layout scanner) own a file list — they may share a folder or span libraries
    const dbFiles = model.work_key ? db.prepare('SELECT filename, filepath, filesize, variant FROM model_files WHERE model_id = ?').all(model.id).filter(f => tryConfine(f.filepath)) : [];
    const analysis = dbFiles.length ? analysisFromFiles(dbFiles) : analyzeFolder(folder, creator.name);
    const renderArchives = pickRenderArchives(analysis, effectiveHint);

    if (renderArchives.length === 0) {
      send('warn', `  ⚠ ${model.name}: no matching ZIP found`);
      skipped++;
      continue;
    }

    send('zip', `  📦 ${model.name}: extracting from ${renderArchives.map(z => path.basename(z)).join(', ')}`);

    const freshImages = [];
    for (const archivePath of renderArchives) {
      try {
        freshImages.push(...await extractImagesFromArchive(archivePath, model.uuid));
      } catch (e) {
        send('error', `    ✗ Failed: ${e.message}`);
      }
    }

    if (freshImages.length > 0) {
      thumbs.removeThumbs(model.uuid);
      const m = pictures.mergeImages(model, [...new Set(freshImages)], 'archive', { replaceThumb: true });
      db.prepare(`UPDATE models SET images=?, thumbnail_path=?, thumb_source=?, folder_hash=NULL, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(m.images), m.thumbnail_path, m.thumb_source, model.id);
      send('img', `     → ${freshImages.length} image(s) saved`);
      updated++;
    } else {
      send('warn', `     ⚠ No images found inside ZIP(s)`);
      skipped++;
    }
  }

  sse.end({ type: 'done', success: true, updated, skipped });
}
app.get('/api/creators/:id(\\d+)/reextract', reextractCreator);
app.post('/api/creators/:id(\\d+)/reextract', reextractCreator);

// Per-model render ZIP hint override
app.patch('/api/models/:id(\\d+)/render-hint', (req, res) => {
  const { render_zip_hint } = req.body;
  db.prepare('UPDATE models SET render_zip_hint = ?, folder_hash = NULL WHERE id = ?').run(render_zip_hint || null, req.params.id);
  res.json({ success: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  // Tools (_Tools: slicer projects, printer files…) are not models: left out of the stats
  const VIS = `(hidden IS NULL OR hidden = 0) AND COALESCE(kind, 'model') != 'tool'`;
  const total = db.prepare(`SELECT COUNT(*) as n FROM models WHERE ${VIS}`).get().n;
  // hidden by the user; rows folded into works by the regroup are not "hidden models"
  const totalHidden = db.prepare('SELECT COUNT(*) as n FROM models WHERE hidden = 1 AND folded_into IS NULL').get().n;
  const byStatus = db.prepare(`
    SELECT print_status, COUNT(*) as n FROM models WHERE ${VIS} GROUP BY print_status
  `).all();
  const creators = db.prepare(`SELECT COUNT(*) as n FROM creators WHERE name != '_Tools'`).get().n;
  const withImages = db.prepare(`SELECT COUNT(*) as n FROM models WHERE thumbnail_path IS NOT NULL AND ${VIS}`).get().n;
  const favorites = db.prepare(`SELECT COUNT(*) as n FROM models WHERE is_favorite = 1 AND ${VIS}`).get().n;
  const lastScan = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();

  // Count models added since the last scan started
  let recentlyAdded = 0;
  if (lastScan?.started_at) {
    recentlyAdded = db.prepare(`SELECT COUNT(*) as n FROM models WHERE ${VIS} AND created_at >= ?`).get(lastScan.started_at).n;
  }

  // Franchise list with counts
  const franchises = db.prepare(`
    SELECT franchise, COUNT(*) as count FROM models
    WHERE franchise IS NOT NULL AND franchise != '' AND ${VIS}
    GROUP BY franchise ORDER BY count DESC, franchise
  `).all();

  res.json({ total, totalHidden, byStatus, creators, withImages, favorites, lastScan, recentlyAdded, franchises });
});

// General creator update (notes, name)
app.patch('/api/creators/:id', (req, res) => {
  const { notes, name } = req.body;
  const creator = db.prepare('SELECT id FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });
  const updates = [];
  const params = [];
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes || null); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE creators SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// ── Tags ──────────────────────────────────────────────────────────────────────

app.get('/api/tags', (req, res) => {
  const models = db.prepare('SELECT tags FROM models WHERE tags IS NOT NULL AND tags != \'[]\' AND tags != \'null\' AND tags != \'\'').all();
  const tagCount = {};
  for (const m of models) {
    try {
      const tags = JSON.parse(m.tags);
      for (const t of tags) tagCount[t] = (tagCount[t] || 0) + 1;
    } catch {}
  }
  const sorted = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  res.json(sorted);
});

// ── Tag management (rename / merge / delete across the whole library) ─────────

// Apply a transform fn to every model's tag array; returns how many changed.
function rewriteAllTags(transform) {
  const rows = db.prepare("SELECT id, tags FROM models WHERE tags IS NOT NULL AND tags != ''").all();
  const upd = db.prepare("UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?");
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      let tags;
      try { tags = JSON.parse(r.tags || '[]'); } catch { continue; }
      if (!Array.isArray(tags)) continue;
      const next = transform(tags);
      if (next && JSON.stringify(next) !== JSON.stringify(tags)) {
        upd.run(JSON.stringify(next), r.id);
        changed++;
      }
    }
  })();
  return changed;
}

// Rename a tag everywhere (merges into target if it already exists)
app.post('/api/tags/rename', (req, res) => {
  const from = (req.body.from || '').trim();
  const to = (req.body.to || '').trim().toLowerCase();
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const changed = rewriteAllTags(tags =>
    tags.includes(from) ? [...new Set(tags.map(t => (t === from ? to : t)))] : tags
  );
  res.json({ success: true, changed });
});

// Merge several tags into one target tag
app.post('/api/tags/merge', (req, res) => {
  const sources = (req.body.sources || []).map(s => String(s).trim()).filter(Boolean);
  const target = (req.body.target || '').trim().toLowerCase();
  if (!sources.length || !target) return res.status(400).json({ error: 'sources[] and target required' });
  const set = new Set(sources);
  const changed = rewriteAllTags(tags =>
    tags.some(t => set.has(t)) ? [...new Set(tags.map(t => (set.has(t) ? target : t)))] : tags
  );
  res.json({ success: true, changed });
});

// Remove a tag from every model
app.post('/api/tags/delete', (req, res) => {
  const tag = (req.body.tag || '').trim();
  if (!tag) return res.status(400).json({ error: 'tag required' });
  const changed = rewriteAllTags(tags => tags.filter(t => t !== tag));
  res.json({ success: true, changed });
});

// ── Bulk Actions ──────────────────────────────────────────────────────────────

app.post('/api/models/bulk', (req, res) => {
  const { ids, print_status, tags_add, tags_remove, hidden } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }

  const placeholders = ids.map(() => '?').join(',');
  let updated = 0;

  if (print_status) {
    const result = db.prepare(
      `UPDATE models SET print_status = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(print_status, ...ids);
    updated = result.changes;
  }

  let skippedFolded = 0;
  if (hidden !== undefined) {
    // rows folded into a work stay hidden (PATCH answers 409 for them)
    const result = db.prepare(
      `UPDATE models SET hidden = ?, updated_at = datetime('now') WHERE id IN (${placeholders}) AND folded_into IS NULL`
    ).run(hidden ? 1 : 0, ...ids);
    updated = result.changes;
    if (!hidden) skippedFolded = ids.length - result.changes;
  }

  if (tags_add && tags_add.length > 0) {
    const models = db.prepare(`SELECT id, tags FROM models WHERE id IN (${placeholders})`).all(...ids);
    const updateTag = db.prepare(`UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const m of models) {
      const existing = JSON.parse(m.tags || '[]');
      const merged = [...new Set([...existing, ...tags_add])];
      updateTag.run(JSON.stringify(merged), m.id);
    }
    updated = models.length;
  }

  if (tags_remove && tags_remove.length > 0) {
    const models = db.prepare(`SELECT id, tags FROM models WHERE id IN (${placeholders})`).all(...ids);
    const updateTag = db.prepare(`UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const m of models) {
      const existing = JSON.parse(m.tags || '[]');
      const filtered = existing.filter(t => !tags_remove.includes(t));
      updateTag.run(JSON.stringify(filtered), m.id);
    }
    updated = models.length;
  }

  res.json({ success: true, updated, ...(skippedFolded > 0 ? { skippedFolded } : {}) });
});

// ── Export ────────────────────────────────────────────────────────────────────

// CSV export — supports same filters as GET /api/models (no pagination, returns all rows)
app.get('/api/export', (req, res) => {
  const { search, creator, status, tags, franchise, collection, show_hidden, has_thumbnail } = req.query;

  let where = ['1=1'];
  const params = [];

  if (!show_hidden || show_hidden === '0') {
    where.push('(m.hidden IS NULL OR m.hidden = 0)');
  }
  where.push('m.folded_into IS NULL');
  if (has_thumbnail === '1') {
    where.push('m.thumbnail_path IS NOT NULL');
  }
  if (franchise) { where.push('m.franchise = ?'); params.push(franchise); }
  addLayoutFilters(req.query, where, params);
  if (collection) {
    where.push('m.id IN (SELECT model_id FROM collection_models WHERE collection_id = ?)');
    params.push(collection);
  }
  if (search) {
    where.push("(m.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.notes LIKE ? ESCAPE '\\')");
    const s = `%${likeEscape(search)}%`;
    params.push(s, s, s, s);
  }
  if (creator) { where.push('c.name = ?'); params.push(creator); }
  if (status) { where.push('m.print_status = ?'); params.push(status); }
  if (tags) {
    String(tags).split(',').forEach(t => { where.push("m.tags LIKE ? ESCAPE '\\'"); params.push(`%"${likeEscape(t.trim())}"%`); });
  }

  const rows = db.prepare(`
    SELECT m.id, m.name, c.name as creator_name, m.print_status, m.franchise, m.team,
           m.tags, m.source_site, m.source_url, m.notes, m.file_count,
           m.has_stl, m.has_chitubox, m.has_lychee, m.has_plate,
           m.created_at, m.updated_at
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.name ASC, m.name ASC
  `).all(...params);

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = ['id','name','creator','status','franchise','team','tags','source_site','source_url','notes','file_count','has_stl','has_chitubox','has_lychee','has_plate','created_at','updated_at'];
  const lines = [headers.join(',')];

  for (const r of rows) {
    const tags = (() => { try { return JSON.parse(r.tags || '[]').join(';'); } catch { return ''; } })();
    lines.push([
      r.id, r.name, r.creator_name, r.print_status, r.franchise, r.team,
      tags, r.source_site, r.source_url, r.notes,
      r.file_count, r.has_stl ? 1 : 0, r.has_chitubox ? 1 : 0, r.has_lychee ? 1 : 0, r.has_plate ? 1 : 0,
      r.created_at, r.updated_at,
    ].map(escape).join(','));
  }

  const filename = `vault-export-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// SSE stream version of scrape (GET so EventSource can use it)
app.get('/api/models/:id(\\d+)/scrape-stream', async (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).end();

  const sse = openSSE(req, res);
  const send = (level, msg) => sse.send({ level, msg, ts: new Date().toISOString() });
  const done = (data) => sse.end({ type: 'done', ...data });

  let sourceUrl = req.query.url || model.source_url;
  if (!sourceUrl) {
    const folderName = path.basename(realFolder(model.folder_path));
    const detected = detectUrlFromFolderName(folderName);
    if (detected) { sourceUrl = detected.url; send('info', `Auto-detected URL: ${sourceUrl}`); }
  }

  if (!sourceUrl) return done({ success: false, error: 'No source URL — paste one manually.' });

  send('info', `Fetching: ${sourceUrl}`);

  try {
    const { savedPaths, sourceSite, sourceUrl: finalUrl } = await scrapeImagesFromUrl(sourceUrl, model.uuid, send, { signal: sse.signal });
    if (sse.aborted) return;
    if (savedPaths.length === 0) return done({ success: false, error: 'No images could be downloaded.' });

    send('success', `✓ Downloaded ${savedPaths.length} image(s)`);

    const pm = appendPictures(model, savedPaths, 'web');
    db.prepare(`UPDATE models SET images=?, thumbnail_path=?, thumb_source=?, source_url=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(pm.images), pm.thumbnail_path, pm.thumb_source, finalUrl, model.id);
    if (sourceSite && sourceSite !== 'unknown') {
      db.prepare(`UPDATE models SET source_site=? WHERE id=?`).run(sourceSite, model.id);
    }
    done({ success: true, images: savedPaths, total: allImages.length });
  } catch (err) {
    done({ success: false, error: err.message });
  }
});

app.post('/api/models/:id(\\d+)/scrape', async (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  // SSE mode if client requests it
  const useStream = req.headers.accept === 'text/event-stream';
  const sse = useStream ? openSSE(req, res) : null;

  const sendLog = (level, msg) => {
    if (sse) sse.send({ level, msg, ts: new Date().toISOString() });
  };
  const sendDone = (data) => {
    if (sse) sse.end({ type: 'done', ...data });
    else res.json(data);
  };
  const sendError = (msg) => {
    if (sse) sse.end({ type: 'done', success: false, error: msg });
    else res.status(500).json({ error: msg });
  };

  let sourceUrl = req.body?.url || model.source_url;
  if (!sourceUrl) {
    const folderName = path.basename(realFolder(model.folder_path));
    const detected = detectUrlFromFolderName(folderName);
    if (detected) { sourceUrl = detected.url; sendLog('info', `Auto-detected URL from folder name: ${sourceUrl}`); }
  }

  if (!sourceUrl) return sendError('No source URL provided and none could be auto-detected from the folder name.');

  sendLog('info', `Fetching page: ${sourceUrl}`);

  try {
    const { savedPaths, sourceSite, sourceUrl: finalUrl } = await scrapeImagesFromUrl(sourceUrl, model.uuid, sendLog, { signal: sse?.signal });
    if (sse?.aborted) return;

    if (savedPaths.length === 0) return sendError('Found the page but could not download any images.');

    sendLog('success', `✓ Downloaded ${savedPaths.length} image(s)`);

    const pm = appendPictures(model, savedPaths, 'web');
    db.prepare(`UPDATE models SET images = ?, thumbnail_path = ?, thumb_source = ?, source_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(pm.images), pm.thumbnail_path, pm.thumb_source, finalUrl, model.id);
    if (sourceSite && sourceSite !== 'unknown') {
      db.prepare(`UPDATE models SET source_site = ? WHERE id = ?`).run(sourceSite, model.id);
    }

    sendDone({ success: true, images: savedPaths, total: allImages.length });
  } catch (err) {
    sendError(err.message);
  }
});

// Auto-detect source URL from folder name
app.get('/api/models/:id(\\d+)/detect-url', (req, res) => {
  const model = db.prepare('SELECT folder_path, source_url FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  if (model.source_url) return res.json({ url: model.source_url, source: 'saved' });

  const folderName = path.basename(realFolder(model.folder_path));
  const detected = detectUrlFromFolderName(folderName);
  if (detected) return res.json({ url: detected.url, site: detected.site, source: 'folder_name' });

  res.json({ url: null });
});

// ── ZIP Image Picker ──────────────────────────────────────────────────────────

// List all ZIP files for a model
app.get('/api/models/:id(\\d+)/zips', (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const zips = db.prepare(
    "SELECT * FROM model_files WHERE model_id = ? AND (filetype = 'zip' OR filename LIKE '%.zip')"
  ).all(model.id);

  res.json(zips);
});

// Preview images inside a ZIP without extracting
app.get('/api/files/:fileId/zip-contents', async (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  try { confinePath(file.filepath); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  if (!fs.existsSync(file.filepath)) return res.status(404).json({ error: 'File not found on disk' });
  if (zipLib.zipTooBig(file.filepath)) return res.status(413).json({ error: 'Archive is larger than ZIP_MAX_MB/ARCHIVE_MAX_MB' });

  try {
    // yauzl reads the central directory only — fine for multi-GB archives
    const entries = (await zipLib.listZip(file.filepath))
      .filter(e => !e.isDirectory)
      .map(e => {
        const ext = path.extname(e.name).toLowerCase();
        return { name: e.name, basename: path.basename(e.name), size: e.size, isImage: zipLib.IMAGE_EXTS.has(ext), ext };
      });
    res.json({
      filename: file.filename,
      totalEntries: entries.length,
      images: entries.filter(e => e.isImage),
      all: entries
    });
  } catch (e) {
    res.status(500).json({ error: `Could not read ZIP: ${e.message}` });
  }
});

// Extract images from a specific ZIP and save them
app.post('/api/files/:fileId/extract-images', async (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(file.model_id);
  if (!model) return res.status(404).json({ error: 'Model not found' });

  const { selectedFiles } = req.body || {}; // optional: array of entry names to extract, or extract all images
  try { confinePath(file.filepath); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  if (!fs.existsSync(file.filepath)) return res.status(404).json({ error: 'File not found on disk' });
  if (zipLib.zipTooBig(file.filepath)) return res.status(413).json({ error: 'Archive is larger than ZIP_MAX_MB/ARCHIVE_MAX_MB' });

  try {
    const modelImgDir = path.join(IMAGES_DIR, model.uuid);
    const names = await zipLib.extractZipImages(file.filepath, modelImgDir, {
      select: Array.isArray(selectedFiles) && selectedFiles.length ? selectedFiles : null,
    });
    if (!names.length) return res.status(422).json({ error: 'No image files found in this ZIP' });
    const savedPaths = [...new Set(names)].map(n => `/images/${model.uuid}/${n}`);

    // Merge with existing images (the user's thumbnail stays; new pictures replace a mesh render)
    const pm = appendPictures(model, savedPaths, 'archive');
    const allImages = pm.images;
    db.prepare(`
      UPDATE models SET images = ?, thumbnail_path = ?, thumb_source = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(allImages), pm.thumbnail_path, pm.thumb_source, model.id);

    res.json({ success: true, extracted: savedPaths.length, images: savedPaths, total: allImages.length });
  } catch (e) {
    res.status(500).json({ error: `Extraction failed: ${e.message}` });
  }
});

// ── Thumbnails and pictures (docs/thumbnails.md) ─────────────────────────────

// Off-main-thread jobs (thumb-worker.js). One fill job at a time; a background fill (queued after
// a scan) gives way to one the user starts.
let fillJob = null; // { worker, background, startedAt, scope, steps, listeners:Set, last }
const thumbsAutomatic = () => process.env.THUMBS_AUTO === '1' || (process.env.THUMBS_AUTO !== '0' && !process.env.JEST_WORKER_ID);

function startFillJob({ scope = 'missing', steps = ['peek', 'render'], renderOnly = false, background = false }) {
  const worker = new Worker(path.join(__dirname, 'thumb-worker.js'), { workerData: { mode: 'fill', scope, steps, renderOnly }, env: { ...process.env } });
  const job = { worker, background, scope, steps: renderOnly ? ['render'] : steps, startedAt: new Date().toISOString(), listeners: new Set(), last: null, finished: false };
  const emit = (m) => { for (const fn of job.listeners) { try { fn(m); } catch {} } };
  const finish = (m) => {
    if (job.finished) return;
    job.finished = true;
    if (fillJob === job) fillJob = null;
    emit(m);
    if (thumbsAutomatic()) { try { thumbs.fillMissing(db); } catch {} }
  };
  worker.on('message', (m) => {
    if (m.type === 'done') {
      const r = m.result || {};
      return finish(m.success ? { type: 'done', success: true, done: r.done || 0, total: r.total || 0, found: r.found || {}, failed: r.failed || 0 } : { type: 'done', success: false, error: m.error });
    }
    if (m.type === 'progress') job.last = m;
    emit(m.type === 'log' ? { level: m.level, msg: m.msg, ts: new Date().toISOString() } : m);
  });
  worker.on('error', (e) => finish({ type: 'done', success: false, error: e.message }));
  worker.on('exit', () => finish({ type: 'done', success: false, error: 'Stopped' }));
  fillJob = job;
  return job;
}
function stopFillJob() {
  const job = fillJob;
  if (!job) return Promise.resolve();
  fillJob = null;
  return job.worker.terminate().catch(() => {});
}

/** After a scan: card-size thumbs for new pictures, and a mesh render for cards still without one. */
function afterScanPictures() {
  if (!thumbsAutomatic()) return;
  try { thumbs.fillMissing(db); } catch (e) { console.warn('[thumbs]', e.message); }
  if (fillJob || process.env.THUMBS_RENDER_AFTER_SCAN === '0') return;
  try { startFillJob({ scope: 'missing', renderOnly: true, background: true }); } catch (e) { console.warn('[thumbs] render job:', e.message); }
}

app.get('/api/thumbs/status', (req, res) => {
  const st = thumbs.status(db);
  st.job = fillJob ? { scope: fillJob.scope, steps: fillJob.steps, background: fillJob.background, startedAt: fillJob.startedAt, progress: fillJob.last } : null;
  res.json(st);
});

app.post('/api/thumbs/rebuild', (req, res) => {
  res.json({ ok: true, queued: thumbs.rebuild(db) });
});

app.get('/api/thumbs/fill', async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'missing';
  const steps = String(req.query.steps || 'peek,render').split(',').map(x => x.trim()).filter(x => x === 'peek' || x === 'render');
  if (fillJob && !fillJob.background) {
    return res.status(409).json({ error: `Finding pictures is already running (started ${fillJob.startedAt}).`, running: { scope: fillJob.scope, steps: fillJob.steps, startedAt: fillJob.startedAt } });
  }
  if (fillJob) await stopFillJob(); // the background render after a scan gives way
  const sse = openSSE(req, res);
  let job;
  try { job = startFillJob({ scope, steps }); } catch (e) { return sse.end({ type: 'done', success: false, error: e.message }); }
  sse.send({ level: 'info', msg: `Finding pictures for ${scope === 'all' ? 'all cards without a real picture' : 'cards without a picture'}…`, ts: new Date().toISOString() });
  job.listeners.add((m) => { if (m.type === 'done') sse.end(m); else sse.send(m); });
  sse.onAbort(() => { if (fillJob === job) stopFillJob(); });
});

/** A card's files, confined to the library. */
function cardFiles(id) {
  return db.prepare('SELECT filename, filepath, filesize FROM model_files WHERE model_id = ?').all(id).filter(f => tryConfine(f.filepath));
}

app.get('/api/models/:id(\\d+)/meshes', async (req, res) => {
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });
  const { loose, inZip } = await pictures.meshCandidates(cardFiles(model.id));
  const files = [...loose, ...inZip].map(c => ({ path: c.id, label: c.label, size: c.size, triangles: null, kind: pictures.meshKind(c.name) }));
  res.json({ files });
});

app.post('/api/models/:id(\\d+)/thumbnail/render', async (req, res) => {
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });
  const file = req.body && req.body.file;
  if (file !== undefined && file !== null && (typeof file !== 'string' || !file.trim() || file.includes('\0'))) return res.status(400).json({ error: 'file must be a path' });
  if (file) {
    const fsPath = file.split('::')[0];
    try { confinePath(fsPath); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  }
  const result = await new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'thumb-worker.js'), { workerData: { mode: 'render', id: model.id, file: file || null }, env: { ...process.env } });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    w.on('message', (m) => { if (m.type === 'done') done(m.success ? m.result : { ok: false, status: 500, error: m.error }); });
    w.on('error', (e) => done({ ok: false, status: 500, error: e.message }));
    w.on('exit', () => done({ ok: false, status: 500, error: 'Render stopped' }));
  });
  if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
  res.json({ ok: true, images: result.images, thumbnail_path: result.thumbnail_path, thumb_url: thumbs.thumbUrl(result.thumbnail_path, 480), thumb_source: 'stl', triangles: result.triangles, ms: result.ms });
});

// ── Claude AI Assistant ───────────────────────────────────────────────────────

app.post('/api/ai/assist', async (req, res) => {
  const { modelId, action, context, userMessage, history } = req.body;

  let model = null;
  if (modelId) {
    model = db.prepare(`
      SELECT m.*, c.name as creator_name FROM models m
      LEFT JOIN creators c ON m.creator_id = c.id WHERE m.id = ?
    `).get(modelId);
  }

  const systemPrompt = `You are a helpful assistant for "The Vault", a 3D printing model library manager.
You help users organize their 3D print collection. You can suggest:
- Tags to apply to models (keep tags short, 1-3 words, lowercase, useful for filtering)
- Print status (unprinted, sliced, printing, printed, painted, failed)
- Notes about print settings, recommended resin/filament, scale, supports
- Organization tips

When suggesting tags, return them as a JSON array in your response wrapped in <tags>["tag1","tag2"]</tags> tags.
When suggesting a status, wrap it in <status>printed</status> tags.
When suggesting notes, wrap them in <notes>your notes here</notes> tags.

Keep responses concise and practical. You're talking to a 3D printing enthusiast who collects miniatures, terrain, and props.`;

  let userContent = userMessage || '';

  if (model && !userMessage) {
    // Auto-generate context message based on action
    const tags = JSON.parse(model.tags || '[]');
    const modelContext = `Model: "${model.name}" by ${model.creator_name || 'unknown'}
Current status: ${model.print_status}
Current tags: ${tags.length > 0 ? tags.join(', ') : 'none'}
Has STL: ${model.has_stl ? 'yes' : 'no'}, Chitubox: ${model.has_chitubox ? 'yes' : 'no'}, Lychee: ${model.has_lychee ? 'yes' : 'no'}
Notes: ${model.notes || 'none'}
${context || ''}`;

    if (action === 'suggest_tags') {
      userContent = `${modelContext}\n\nPlease suggest 5-10 relevant tags for this model. Consider: scale, type (miniature/terrain/prop/bust), faction/theme, game system, difficulty, style.`;
    } else if (action === 'suggest_organization') {
      userContent = `${modelContext}\n\nSuggest how to organize this model — recommended tags, any notes about printing it, and whether the status seems right.`;
    } else if (action === 'suggest_notes') {
      userContent = `${modelContext}\n\nSuggest useful print notes for this model (resin vs FDM, recommended scale, support strategy, painting tips if it's a miniature).`;
    } else {
      userContent = modelContext;
    }
  }

  const messages = [
    ...(history || []),
    { role: 'user', content: userContent }
  ];

  try {
    const apiKey = req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
    const parsed = await callClaudeAPI(apiKey, {
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    const text = parsed.content?.[0]?.text || '';

    // Parse structured suggestions out of the response
    const tagsMatch = text.match(/<tags>([\s\S]*?)<\/tags>/);
    const statusMatch = text.match(/<status>([\s\S]*?)<\/status>/);
    const notesMatch = text.match(/<notes>([\s\S]*?)<\/notes>/);

    let suggestedTags = null, suggestedStatus = null, suggestedNotes = null;
    if (tagsMatch) { try { suggestedTags = JSON.parse(tagsMatch[1]); } catch {} }
    if (statusMatch) suggestedStatus = statusMatch[1].trim();
    if (notesMatch) suggestedNotes = notesMatch[1].trim();

    // Clean display text
    const displayText = text
      .replace(/<tags>[\s\S]*?<\/tags>/g, '')
      .replace(/<status>[\s\S]*?<\/status>/g, '')
      .replace(/<notes>[\s\S]*?<\/notes>/g, '')
      .trim();

    res.json({ text: displayText, suggestedTags, suggestedStatus, suggestedNotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude Web Search for Model Matching ──────────────────────────────────────

app.post('/api/ai/search', async (req, res) => {
  const { modelId, query } = req.body;
  const apiKey = req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) return res.status(401).json({ error: 'API key required' });

  let model = null;
  if (modelId) {
    model = db.prepare(`
      SELECT m.*, c.name as creator_name FROM models m
      LEFT JOIN creators c ON m.creator_id = c.id WHERE m.id = ?
    `).get(modelId);
  }

  const modelName = model?.name || query || 'unknown model';
  const creatorName = model?.creator_name || '';

  const searchQuery = query || `${modelName} ${creatorName} 3D print STL miniature`.trim();

  const systemPrompt = `You are a web research assistant for "The Vault", a 3D print library manager.
Your job is to search the web and find links where the user can download or purchase this 3D model.

Prioritize results from these sites:
- Printables (printables.com)
- MyMiniFactory (myminifactory.com)
- Thingiverse (thingiverse.com)
- Cults3D (cults3d.com)
- Patreon (patreon.com) — for creator pages
- Gumroad (gumroad.com) — for creator shops

For each result, provide:
- The URL
- The site name
- A brief description of what's available there
- Whether it appears to be free or paid

Format your results as JSON wrapped in <results>[...]</results> tags. Each result should have: url, site, title, description, free (boolean).

Also include a brief conversational summary outside the tags.`;

  const userContent = `Find where I can get this 3D model online:
Model name: "${modelName}"
${creatorName ? `Creator/artist: ${creatorName}` : ''}
${model?.source_url ? `Known source URL: ${model.source_url}` : ''}
${query ? `Additional search context: ${query}` : ''}

Search for this model and provide download/purchase links.`;

  try {
    const parsed = await callClaudeAPI(apiKey, {
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
      }],
      messages: [{ role: 'user', content: userContent }]
    }, { timeoutMs: 60000 });

    // Extract text from response content blocks
    const textBlocks = (parsed.content || []).filter(b => b.type === 'text');
    const fullText = textBlocks.map(b => b.text).join('\n');

    // Parse structured results
    const resultsMatch = fullText.match(/<results>([\s\S]*?)<\/results>/);
    let searchResults = [];
    if (resultsMatch) {
      try { searchResults = JSON.parse(resultsMatch[1]); } catch {}
    }

    // Clean display text
    const displayText = fullText
      .replace(/<results>[\s\S]*?<\/results>/g, '')
      .trim();

    // Also extract any web search citations from the response
    const citations = [];
    for (const block of (parsed.content || [])) {
      if (block.type === 'text' && block.citations) {
        for (const cite of block.citations) {
          if (cite.url && !citations.find(c => c.url === cite.url)) {
            citations.push({ url: cite.url, title: cite.title || '' });
          }
        }
      }
    }

    res.json({ text: displayText, results: searchResults, citations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude API Helper ─ lives in lib/claude.js (shared with organize.js) ─────

// ── AI Key Test ──────────────────────────────────────────────────────────────

app.post('/api/ai/test-key', async (req, res) => {
  const apiKey = req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) return res.status(401).json({ ok: false, error: 'No API key provided' });
  if (!apiKey.startsWith('sk-ant-')) return res.status(400).json({ ok: false, error: 'Key should start with sk-ant- — this doesn\'t look like an Anthropic API key' });

  try {
    const parsed = await callClaudeAPI(apiKey, {
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with just the word "ok".' }]
    }, { timeoutMs: 15000 });

    const text = parsed.content?.[0]?.text || '';
    res.json({
      ok: true,
      model: parsed.model,
      usage: parsed.usage,
      message: `Key works! (model: ${parsed.model}, used ${parsed.usage?.input_tokens || '?'} input tokens)`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── AI model selection + cost estimate ───────────────────────────────────────

// Models offered for tagging. Rates are approximate USD per million tokens —
// adjust if Anthropic pricing changes; they only drive the rough cost preview.
const TAG_MODELS = {
  'claude-haiku-4-5-20251001': { label: 'Haiku 4.5 — fast & cheap', inRate: 1, outRate: 5 },
  'claude-sonnet-4-6':         { label: 'Sonnet 4.6 — best quality', inRate: 3, outRate: 15 },
};
const DEFAULT_TAG_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
// a model without a price list is costed like Sonnet (the dearer one): estimates err high
const UNKNOWN_MODEL_RATES = { inRate: 3, outRate: 15 };
function resolveTagModel(requested) {
  return TAG_MODELS[requested] ? requested : DEFAULT_TAG_MODEL;
}

app.get('/api/ai/models', (req, res) => {
  res.json({
    default: DEFAULT_TAG_MODEL,
    models: Object.entries(TAG_MODELS).map(([id, m]) => ({ id, label: m.label })),
  });
});

// Rough cost preview before running a tagging job
app.get('/api/ai/tag-estimate', (req, res) => {
  const model = resolveTagModel(req.query.model);
  const vision = req.query.vision === '1';
  const rates = TAG_MODELS[model] || { inRate: 1, outRate: 5 };
  const n = vision
    ? db.prepare("SELECT COUNT(*) AS n FROM models WHERE thumbnail_path IS NOT NULL AND (hidden IS NULL OR hidden = 0)").get().n
    : db.prepare("SELECT COUNT(*) AS n FROM models WHERE (hidden IS NULL OR hidden = 0)").get().n;
  // Heuristic per-model token usage (vision adds ~1.5k tokens for the image)
  const perIn = vision ? 1700 : 90;
  const perOut = 45;
  const estIn = n * perIn;
  const estOut = n * perOut;
  const estCost = (estIn / 1e6) * rates.inRate + (estOut / 1e6) * rates.outRate;
  res.json({
    model, vision, models: n,
    estInputTokens: estIn, estOutputTokens: estOut,
    estCostUsd: Math.round(estCost * 100) / 100,
  });
});

// ── AI Vision Tagging (SSE) — uses the extracted render image ────────────────

const VISION_MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

app.get('/api/ai/vision-tags', guardSpend, async (req, res) => {
  const apiKey = req.query.key || req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }
  const model = resolveTagModel(req.query.model);
  const trial = req.query.trial !== '0';
  const TRIAL_LIMIT = 10;

  const release = acquireOr409(res, 'vision-tags');
  if (!release) return;
  const sse = openSSE(req, res);
  sse.onAbort(release);
  const send = (data) => sse.send(data);
  const log = (level, msg) => send({ level, msg, ts: new Date().toISOString() });
  const finish = (data) => { release(); sse.end({ type: 'done', ...data }); };
  try {

  const all = db.prepare(`
    SELECT m.id, m.name, m.tags, m.thumbnail_path, m.folder_path, c.name AS creator_name
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE m.thumbnail_path IS NOT NULL AND (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY c.name, m.name
  `).all();

  if (all.length === 0) { log('info', 'No models with images to analyse.'); return finish({ success: true, tagged: 0, total: 0 }); }

  const batch = trial ? all.slice(0, TRIAL_LIMIT) : all;
  const remaining = trial ? all.length - batch.length : 0;
  log('info', `Vision tagging ${batch.length} model(s) with ${model}${trial && remaining > 0 ? ` (trial — ${remaining} more after)` : ''}`);

  const systemPrompt = `You are a 3D-print cataloguing assistant. You are shown a render/photo of a 3D model plus its file metadata. Identify what it is and return up to 7 short lowercase tags describing franchise, character, type (bust/miniature/terrain/prop/vehicle), and theme. You may prefix a tag with a facet when useful: "type:", "franchise:", "scale:", "tech:". Always include the creator name as a tag. Respond with ONLY JSON: {"tags":["..."],"name":"a cleaner display name or null"}`;

  let tagged = 0, errors = 0;
  for (let i = 0; i < batch.length; i++) {
    if (sse.aborted) { log('warn', 'Client disconnected — stopping'); return release(); }
    const m = batch[i];
    // Only ever read images from IMAGES_DIR (thumbnail_path is user-editable)
    const file = imageUrlToFile(m.thumbnail_path || '');
    const ext = file ? path.extname(file).toLowerCase() : '';
    const media = VISION_MEDIA[ext];
    const label = `[${i + 1}/${batch.length}] ${m.creator_name || '?'} / ${m.name}`;

    if (!file || !media || !fs.existsSync(file)) { log('warn', `${label} — image missing/unsupported, skipping`); continue; }
    let b64;
    try {
      const buf = fs.readFileSync(file);
      if (buf.length > 4_500_000) { log('warn', `${label} — image too large, skipping`); continue; }
      b64 = buf.toString('base64');
    } catch { log('warn', `${label} — could not read image`); continue; }

    const meta = `File metadata:\n- name: ${m.name}\n- creator: ${m.creator_name || 'unknown'}\n- folder: ${realFolder(m.folder_path).replace(/^\/library\/?/, '')}`;
    try {
      const parsed = await callClaudeAPI(apiKey, {
        model, max_tokens: 400, system: systemPrompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
          { type: 'text', text: `${meta}\n\nTag this model.` },
        ] }],
      }, { timeoutMs: 60000, signal: sse.signal });

      const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { log('error', `${label} — no JSON in response`); errors++; continue; }
      const result = JSON.parse(jsonMatch[0]);
      const newTags = Array.isArray(result.tags) ? result.tags.map(t => String(t).toLowerCase().trim()).filter(Boolean) : [];
      if (!newTags.length) { log('warn', `${label} — no tags returned`); continue; }

      const existing = (() => { try { return JSON.parse(m.tags || '[]'); } catch { return []; } })();
      const merged = [...new Set([...existing, ...newTags])].slice(0, 7);
      db.prepare("UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), m.id);
      tagged++;
      log('tag', `  ${m.name}: [${newTags.join(', ')}]`);
    } catch (e) {
      errors++;
      log('error', `${label} — ${e.message}`);
      if (e.message.includes('Invalid API key') || e.message.includes('lacks permission')) {
        return finish({ success: false, error: e.message, tagged, total: batch.length });
      }
      if (e.message.includes('Rate limited')) { log('warn', 'Waiting 30s…'); await sse.sleep(30000); i--; continue; }
    }
  }

  log(errors ? 'warn' : 'success', `Vision tagging done — ${tagged} tagged, ${errors} error(s)`);
  finish({ success: true, tagged, total: batch.length, remaining, errors });
  } finally { release(); }
});

// ── AI enrichment (docs/ai-enrichment.md) ────────────────────────────────────
// Fills character/genre/group/editions/tags, proposes renames and merges, keeps a review list
// and an undo log. /api/ai/generate-tags is an alias that runs it with tags only (old clients).

function enrichParams(q) {
  const scope = ['all', 'unattributed', 'creator', 'ids'].includes(q.scope) ? q.scope : (q.ids ? 'ids' : (q.creator ? 'creator' : 'all'));
  return { scope, creator: q.creator || null, ids: q.ids || null, vision: q.vision === '1' || q.vision === 'true', force: q.force === '1' };
}
async function enrichContext() {
  let sum = null;
  try { sum = await getMetaSummary(); } catch { sum = null; }
  let roles = new Map();
  try { roles = folderRolesLib.effectiveRoles(db, LIBRARY_PATH, librariesSync()).merged; } catch { roles = new Map(); }
  const roleOf = (p) => { const e = roles.get(p); return e ? e.role : null; };
  return { promptCtx: enrich.promptContext(db, sum || {}), evCtx: { libraryRoot: LIBRARY_PATH, roleOf } };
}
function loadRender(card) {
  const file = imageUrlToFile(card.thumbnail_path || '');
  const media = file ? VISION_MEDIA[path.extname(file).toLowerCase()] : null;
  if (!file || !media) return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 3_500_000) return null; // base64 adds a third: stays under the API's 5 MB image limit
    return { media, data: buf.toString('base64') };
  } catch { return null; }
}

app.get('/api/ai/enrich/estimate', async (req, res) => {
  const model = resolveTagModel(req.query.model);
  const params = enrichParams(req.query);
  const { promptCtx, evCtx } = await enrichContext();
  const out = enrich.estimate(db, params, { promptCtx, rates: TAG_MODELS[model] || UNKNOWN_MODEL_RATES, model, ctx: evCtx });
  if (!TAG_MODELS[model]) out.warning = `No price list for model "${model}" (CLAUDE_MODEL); the estimate uses Sonnet-level rates`;
  else if (req.query.model && req.query.model !== model) out.warning = `Unknown model "${req.query.model}"; estimated for ${model}`;
  res.json(out);
});

/** One enrichment run streamed over SSE. tagsOnly: the generate-tags alias. */
async function streamEnrich(req, res, { tagsOnly = false, jobName = 'enrich' } = {}) {
  const fake = enrich.fakeEnabled();
  const apiKey = req.query.key || req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || (fake ? 'fake' : '');
  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }
  const model = resolveTagModel(req.query.model);
  const params = tagsOnly ? { scope: 'all', tagsOnly: true } : enrichParams(req.query);
  const release = acquireOr409(res, jobName);
  if (!release) return;
  const sse = openSSE(req, res);
  sse.onAbort(release);
  const log = (level, msg) => sse.send({ level, msg, ts: new Date().toISOString() });
  let runId = null;
  try {
    if (fake) console.warn('[enrich] ENRICH_FAKE=1: using the dev fake model, not Claude');
    const { promptCtx, evCtx } = await enrichContext();
    const sel = enrich.selectCards(db, params, evCtx);
    runId = enrich.createRun(db, { model: fake ? `${model} (fake)` : model, scope: tagsOnly ? 'tags' : params.scope, params: { ...params, tagsOnly } });
    log('info', `Enrich run #${runId}: ${sel.cards.length} card(s) to process, ${sel.skipped} unchanged since the last run`);
    if (!sel.cards.length) {
      enrich.finishRun(db, runId, { total: 0, unchanged: sel.skipped }, 'complete');
      release();
      sse.end({ type: 'done', success: true, runId, applied: 0, suggested: 0, merges: 0, unchanged: sel.skipped, errors: 0, visionUsed: 0, actualInTokens: 0, actualOutTokens: 0, actualUsd: 0, tagged: 0, total: 0 });
      return;
    }
    const counts = await enrich.runEnrich({
      db, cards: sel.cards, runId, model, apiKey, promptCtx, ctxOpts: evCtx, vision: params.vision, tagsOnly,
      client: enrich.getClient(log), log, progress: (p) => sse.send(p), aborted: () => sse.aborted, sleep: (ms) => sse.sleep(ms),
      signal: sse.signal, loadImage: loadRender,
    });
    counts.unchanged = sel.skipped;
    const status = counts.fatal ? 'error' : (counts.cancelled ? 'cancelled' : (counts.stopped ? 'stopped' : 'complete'));
    const actualUsd = enrich.finishRun(db, runId, counts, status, TAG_MODELS[model] || UNKNOWN_MODEL_RATES);
    if (counts.cancelled && sse.aborted) { console.log(`[enrich] run #${runId} stopped: client disconnected`); return; }
    const ok = !counts.fatal && !counts.stopped;
    log(ok ? (counts.errors ? 'warn' : 'success') : 'error', ok
      ? `Done: ${counts.applied} applied, ${counts.suggested} suggestion(s), ${counts.merges} merge proposal(s), ${counts.errors} error(s)`
      : `Stopped: ${counts.fatal || counts.stopped}`);
    release();
    sse.end({
      type: 'done', success: ok, runId, applied: counts.applied, suggested: counts.suggested, merges: counts.merges,
      unchanged: sel.skipped, errors: counts.errors, visionUsed: counts.visionUsed,
      actualInTokens: counts.inTokens, actualOutTokens: counts.outTokens, actualUsd, ...(counts.stopped ? { stopped: counts.stopped } : {}),
      // generate-tags clients read these
      tagged: counts.applied, total: sel.cards.length, ...(counts.fatal || counts.stopped ? { error: counts.fatal || counts.stopped } : {}),
    });
  } catch (e) {
    if (runId) enrich.finishRun(db, runId, {}, 'error');
    log('error', e.message);
    release();
    sse.end({ type: 'done', success: false, error: e.message, runId });
  } finally { release(); }
}

app.get('/api/ai/enrich', guardSpend, (req, res) => streamEnrich(req, res));
// Old clients: "Generate tags" is Enrich with tags only (additive, never removes a tag, cap 12)
app.get('/api/ai/generate-tags', guardSpend, (req, res) => streamEnrich(req, res, { tagsOnly: true, jobName: 'generate-tags' }));

app.get('/api/ai/enrich/runs', (req, res) => res.json({ runs: enrich.listRuns(db, clampInt(req.query.limit, 50, 1, 500)) }));
app.post('/api/ai/enrich/runs/:id(\\d+)/undo', (req, res) => {
  try { res.json(enrich.undoRun(db, Number(req.params.id))); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/suggestions', (req, res) => res.json(enrich.listSuggestions(db, req.query)));
app.get('/api/suggestions/summary', (req, res) => res.json(enrich.summary(db)));
app.post('/api/suggestions/:id(\\d+)/unmerge', (req, res) => {
  try { res.json(enrich.unmerge(db, Number(req.params.id))); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/suggestions/decide', (req, res) => {
  const { ids, decision } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "accept" or "reject"' });
  res.json(enrich.decide(db, ids.map(Number).filter(Number.isInteger), decision));
});
app.post('/api/suggestions/decide-filter', (req, res) => {
  const { filter, decision } = req.body || {};
  if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "accept" or "reject"' });
  res.json(enrich.decideFilter(db, filter || {}, decision));
});

// ── Organizer export (docs/ai-enrichment.md §7) ──────────────────────────────

async function exportCtx(req) {
  let sum = null;
  try { sum = await getMetaSummary(); } catch { sum = null; }
  const libs = healthCache.libraries && healthCache.libraries.length ? healthCache.libraries : librariesLib.listLibraries(LIBRARY_PATH, sum?.libraryLabels);
  return { since: req.query.since || null, metaSummary: sum || {}, libraries: libs };
}
app.get('/api/organizer/export', async (req, res) => {
  const ctx = await exportCtx(req);
  const generatedAt = new Date().toISOString();
  const files = Object.entries(organizerExport.FILES).map(([name, f]) => ({
    name, url: `/api/organizer/export/${name}${ctx.since ? `?since=${encodeURIComponent(ctx.since)}` : ''}`, rows: f.fn(db, ctx).rows.length,
  }));
  res.json({ generatedAt, since: ctx.since, cursor: generatedAt, files });
});
app.get('/api/organizer/export/:file', async (req, res) => {
  const f = organizerExport.FILES[req.params.file];
  if (!f) return res.status(404).json({ error: 'Unknown export file' });
  const out = f.fn(db, await exportCtx(req));
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`);
  res.send(out.text);
});


// ── AI Image Finder (SSE) ────────────────────────────────────────────────────

// Score how likely we are to find a match for this model online.
// Higher = better chance. Models with no useful info get skipped.
function scoreMatchability(model) {
  let score = 0;
  let reasons = [];

  // Already has a source URL — best case, just scrape it
  if (model.source_url) { score += 50; reasons.push('has source URL'); }

  // Folder name matches a known site pattern (thingiverse ID, printables slug, etc.)
  const folderName = path.basename(realFolder(model.folder_path));
  if (detectUrlFromFolderName(folderName)) { score += 40; reasons.push('folder has site ID'); }

  // Has a real creator name (not just a generic folder name)
  if (model.creator_name && model.creator_name.length > 1) { score += 15; reasons.push('has creator'); }

  // Model name is descriptive enough to search (not just IDs/hashes)
  const name = model.name || '';
  const isGenericName = /^[0-9a-f]{8,}$/i.test(name) || /^(files?|model|thing|download|print)/i.test(name) || name.length < 3;
  if (!isGenericName && name.length >= 4) { score += 15; reasons.push('descriptive name'); }
  else { reasons.push('generic/short name'); }

  // Name contains recognizable keywords
  if (/[A-Z][a-z]+/.test(name)) { score += 5; reasons.push('proper noun'); }

  return { score, reasons };
}

app.get('/api/ai/find-images', guardSpend, async (req, res) => {
  const apiKey = req.headers['x-claude-key'] || req.query.key || process.env.CLAUDE_API_KEY || '';
  const trialMode = req.query.trial !== '0'; // trial mode ON by default
  const TRIAL_LIMIT = 10;

  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }

  const release = acquireOr409(res, 'find-images');
  if (!release) return;
  const sse = openSSE(req, res);
  sse.onAbort(release);
  const send = (data) => sse.send(data);
  const log = (level, msg) => send({ level, msg, ts: new Date().toISOString() });
  const done = (data) => { release(); sse.end({ type: 'done', ...data }); };
  try {

  // Get models without thumbnails
  const allModels = db.prepare(`
    SELECT m.id, m.uuid, m.name, m.folder_path, m.source_url, m.images, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE m.thumbnail_path IS NULL AND (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY c.name, m.name
  `).all();

  if (allModels.length === 0) {
    log('info', 'All models already have thumbnails!');
    return done({ success: true, found: 0, scraped: 0, total: 0 });
  }

  // Score and sort by matchability — best candidates first
  const scored = allModels.map(m => ({ ...m, ...scoreMatchability(m) }));
  scored.sort((a, b) => b.score - a.score);

  // Partition into tiers
  const easy = scored.filter(m => m.score >= 40);   // has URL or site ID
  const good = scored.filter(m => m.score >= 20 && m.score < 40); // has creator + name
  const poor = scored.filter(m => m.score < 20);     // generic names, no creator

  log('info', `Found ${allModels.length} model(s) without thumbnails`);
  log('info', `Matchability: ${easy.length} easy (have URL/ID) · ${good.length} good (name+creator) · ${poor.length} poor (generic/unknown)`);

  if (poor.length > 0) {
    const examples = poor.slice(0, 3).map(m => `"${m.name}" by ${m.creator_name || '?'}`).join(', ');
    log('warn', `Skipping ${poor.length} low-confidence model(s) — e.g. ${examples}`);
  }

  // Only process easy + good candidates
  const models = scored.filter(m => m.score >= 20);

  if (models.length === 0) {
    log('warn', 'No models with enough info to search. Try adding creator names or source URLs first.');
    return done({ success: true, found: 0, scraped: 0, total: 0, skippedPoor: poor.length });
  }

  // In trial mode, only do the first 10
  const batch = trialMode ? models.slice(0, TRIAL_LIMIT) : models;
  const remaining = trialMode ? models.length - batch.length : 0;

  if (trialMode && models.length > TRIAL_LIMIT) {
    log('info', `Trial mode: processing ${batch.length} of ${models.length} eligible models`);
    log('info', 'Run again with trial=0 to process all');
  } else {
    log('info', `Processing ${batch.length} model(s)`);
  }

  let scraped = 0, failed = 0, apiCalls = 0;

  for (let i = 0; i < batch.length; i++) {
    if (sse.aborted) { log('warn', 'Client disconnected — stopping'); return release(); }
    const model = batch[i];
    const label = `[${i + 1}/${batch.length}] ${model.creator_name || '?'} / ${model.name}`;
    const confidence = model.score >= 40 ? '●' : model.score >= 20 ? '◐' : '○';

    // Step 1: Try to get a source URL
    let sourceUrl = model.source_url;

    // Try folder name detection first (free, no API call)
    if (!sourceUrl) {
      const folderName = path.basename(realFolder(model.folder_path));
      const detected = detectUrlFromFolderName(folderName);
      if (detected) {
        sourceUrl = detected.url;
        log('info', `${confidence} ${label} — auto-detected URL: ${sourceUrl}`);
      }
    }

    // If still no URL, ask Claude to search
    if (!sourceUrl) {
      log('search', `${confidence} ${label} — searching online…`);
      apiCalls++;
      try {
        const searchPrompt = `Find the download page for this 3D printable model:
Model: "${model.name}"
${model.creator_name ? `Creator: "${model.creator_name}"` : ''}

Search Printables, MyMiniFactory, Thingiverse, Cults3D, Patreon, and Gumroad.
Return ONLY the most likely URL. No explanation, just the URL. If you cannot find it, reply with "NONE".`;

        const parsed = await callClaudeAPI(apiKey, {
          model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
          messages: [{ role: 'user', content: searchPrompt }]
        }, { timeoutMs: 60000, signal: sse.signal });

        const textBlocks = (parsed.content || []).filter(b => b.type === 'text');
        const text = textBlocks.map(b => b.text).join('\n').trim();
        const urlMatch = text.match(/https?:\/\/[^\s"<>]+/);
        const searchResult = (urlMatch && !text.includes('NONE')) ? urlMatch[0] : null;

        if (searchResult) {
          sourceUrl = searchResult;
          log('info', `${confidence} ${label} — found: ${sourceUrl}`);
          db.prepare('UPDATE models SET source_url = ? WHERE id = ?').run(sourceUrl, model.id);
        } else {
          log('warn', `${confidence} ${label} — no URL found, skipping`);
          failed++;
          continue;
        }
      } catch (e) {
        log('error', `${confidence} ${label} — search failed: ${e.message}`);
        if (e.message.includes('Invalid API key') || e.message.includes('lacks permission')) {
          log('error', 'Stopping — fix your API key and try again.');
          return done({ success: false, error: e.message, found: batch.length, scraped, failed, apiCalls });
        }
        if (e.message.includes('Rate limited')) {
          log('warn', 'Rate limited — waiting 30s before retrying…');
          await sse.sleep(30000);
          i--; // retry
          continue;
        }
        failed++;
        continue;
      }
    }

    // Step 2: Scrape images from the URL
    try {
      log('img', `${confidence} ${label} — scraping ${sourceUrl}`);
      const { savedPaths, sourceSite } = await scrapeImagesFromUrl(sourceUrl, model.uuid, (level, msg) => {
        log(level, `  ${msg}`);
      }, { signal: sse.signal });

      if (savedPaths.length > 0) {
        const pm = appendPictures(model, savedPaths, 'web');
        db.prepare(`UPDATE models SET images=?, thumbnail_path=?, thumb_source=?, source_url=?, updated_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(pm.images), pm.thumbnail_path, pm.thumb_source, sourceUrl, model.id);
        if (sourceSite && sourceSite !== 'unknown') {
          db.prepare(`UPDATE models SET source_site=? WHERE id=?`).run(sourceSite, model.id);
        }
        log('success', `${confidence} ${label} — ✓ ${savedPaths.length} image(s) saved`);
        scraped++;
      } else {
        log('warn', `${confidence} ${label} — no images downloaded`);
        failed++;
      }
    } catch (e) {
      log('error', `${confidence} ${label} — scrape failed: ${e.message}`);
      failed++;
    }
  }

  // Summary
  const hitRate = batch.length > 0 ? Math.round((scraped / batch.length) * 100) : 0;
  log('success', `✓ Done — ${scraped}/${batch.length} succeeded (${hitRate}% hit rate) · ${apiCalls} API call(s) used`);
  if (remaining > 0) {
    log('info', `${remaining} more eligible model(s) remaining — run Find Images again with trial=0 to process all`);
  }
  if (poor.length > 0) {
    log('info', `${poor.length} model(s) skipped (too little info to search)`);
  }
  done({ success: true, found: batch.length, scraped, failed, apiCalls, remaining, skippedPoor: poor.length, hitRate });
  } finally { release(); }
});

// ── STL File Serving ──────────────────────────────────────────────────────────

// Serve individual STL files for the 3D viewer (by model_file id)
app.get('/api/files/:fileId/stl', (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ? AND filetype = ?').get(req.params.fileId, 'stl');
  if (!file) return res.status(404).json({ error: 'STL file not found' });
  try { confinePath(file.filepath); } catch (e) { if (sendPathError(res, e)) return; throw e; }
  if (!fs.existsSync(file.filepath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', 'model/stl');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  const stream = fs.createReadStream(file.filepath);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: `Could not read file: ${err.code || err.message}` });
    else res.destroy(err);
  });
  stream.pipe(res);
});

// ── Print Queue ───────────────────────────────────────────────────────────────

app.get('/api/queue', (req, res) => {
  const rows = db.prepare(`
    SELECT pq.model_id, pq.position, pq.added_at, pq.note,
           m.name, m.thumbnail_path, m.print_status, m.franchise,
           c.name AS creator_name
    FROM print_queue pq
    JOIN models m ON m.id = pq.model_id
    LEFT JOIN creators c ON c.id = m.creator_id
    ORDER BY pq.position ASC
  `).all();
  res.json(rows);
});

app.post('/api/queue', (req, res) => {
  const { modelId } = req.body;
  if (!modelId) return res.status(400).json({ error: 'modelId required' });
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(modelId);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  // Add at the end (max position + 1)
  const maxPos = db.prepare('SELECT MAX(position) as m FROM print_queue').get().m || 0;
  try {
    db.prepare('INSERT INTO print_queue (model_id, position) VALUES (?, ?)').run(modelId, maxPos + 1);
  } catch {
    return res.status(409).json({ error: 'Already in queue' });
  }
  res.json({ success: true, position: maxPos + 1 });
});

app.delete('/api/queue/:modelId', (req, res) => {
  db.prepare('DELETE FROM print_queue WHERE model_id = ?').run(req.params.modelId);
  res.json({ success: true });
});

// Update a queue entry's note
app.patch('/api/queue/:modelId', (req, res) => {
  const { note } = req.body;
  const row = db.prepare('SELECT model_id FROM print_queue WHERE model_id = ?').get(req.params.modelId);
  if (!row) return res.status(404).json({ error: 'Not in queue' });
  db.prepare('UPDATE print_queue SET note = ? WHERE model_id = ?').run(note || null, req.params.modelId);
  res.json({ success: true });
});

app.put('/api/queue/reorder', (req, res) => {
  // { order: [modelId1, modelId2, ...] } — assign positions 1,2,3...
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  const update = db.prepare('UPDATE print_queue SET position = ? WHERE model_id = ?');
  db.transaction(() => {
    order.forEach((modelId, i) => update.run(i + 1, modelId));
  })();
  res.json({ success: true });
});

// ── Tag suggestions ───────────────────────────────────────────────────────────

app.get('/api/models/:id(\\d+)/tag-suggestions', (req, res) => {
  const model = db.prepare('SELECT id, tags, franchise, creator_id FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  let existingTags;
  try { existingTags = new Set(JSON.parse(model.tags || '[]')); } catch { existingTags = new Set(); }

  // Gather tags from same-franchise AND same-creator models
  const conditions = [];
  const params = [];
  if (model.franchise) { conditions.push('franchise = ?'); params.push(model.franchise); }
  conditions.push('creator_id = ?'); params.push(model.creator_id);
  params.push(model.id);

  const siblings = db.prepare(`
    SELECT tags FROM models
    WHERE (${conditions.join(' OR ')}) AND id != ? AND (hidden IS NULL OR hidden = 0)
    LIMIT 200
  `).all(...params);

  const freq = {};
  for (const s of siblings) {
    try {
      for (const t of JSON.parse(s.tags || '[]')) {
        if (!existingTags.has(t)) freq[t] = (freq[t] || 0) + 1;
      }
    } catch {}
  }

  const suggestions = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  res.json(suggestions);
});

// ── Collections ───────────────────────────────────────────────────────────────

app.get('/api/collections', (req, res) => {
  const cols = db.prepare(`
    SELECT c.id, c.name, c.color, c.created_at, c.pinned, c.description,
           COUNT(mm.id) AS model_count,
           (SELECT m.thumbnail_path FROM collection_models cm2
              JOIN models m ON m.id = cm2.model_id
              WHERE cm2.collection_id = c.id AND m.thumbnail_path IS NOT NULL AND m.folded_into IS NULL
              ORDER BY cm2.sort_order, cm2.id LIMIT 1) AS cover
    FROM collections c
    LEFT JOIN collection_models cm ON cm.collection_id = c.id
    LEFT JOIN models mm ON mm.id = cm.model_id AND mm.folded_into IS NULL
    GROUP BY c.id ORDER BY c.pinned DESC, c.name ASC
  `).all();
  res.json(cols);
});

app.post('/api/collections', (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const r = db.prepare('INSERT INTO collections (name, color) VALUES (?, ?)').run(name.trim(), color || '#5b9bd5');
    res.json({ id: r.lastInsertRowid, name: name.trim(), color: color || '#5b9bd5', model_count: 0 });
  } catch { res.status(409).json({ error: 'Name already in use' }); }
});

app.patch('/api/collections/:id', (req, res) => {
  const { name, color } = req.body;
  const col = db.prepare('SELECT id FROM collections WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'Not found' });
  const { pinned } = req.body;
  if (name) db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  if (color) db.prepare('UPDATE collections SET color = ? WHERE id = ?').run(color, req.params.id);
  if (pinned !== undefined) db.prepare('UPDATE collections SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/collections/:id', (req, res) => {
  db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/collections/:id/models', (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 1e6);
  const limit = clampInt(req.query.limit, 48, 1, 500);
  const offset = (page - 1) * limit;
  const total = db.prepare('SELECT COUNT(*) as n FROM collection_models cm JOIN models m ON m.id = cm.model_id WHERE cm.collection_id = ? AND m.folded_into IS NULL').get(req.params.id).n;
  const models = db.prepare(`
    SELECT m.id, m.name, m.thumbnail_path, m.print_status, m.tags, m.franchise,
           m.has_stl, m.has_chitubox, m.has_lychee, m.file_count,
           c.name AS creator_name, cm.sort_order
    FROM collection_models cm
    JOIN models m ON m.id = cm.model_id
    LEFT JOIN creators c ON c.id = m.creator_id
    WHERE cm.collection_id = ? AND m.folded_into IS NULL
    ORDER BY cm.sort_order ASC, cm.added_at ASC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);
  res.json({ models, total, pages: Math.ceil(total / limit) });
});

app.post('/api/collections/:id/models', (req, res) => {
  const { modelIds } = req.body;
  if (!Array.isArray(modelIds) || !modelIds.length) return res.status(400).json({ error: 'modelIds array required' });
  const insert = db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id) VALUES (?, ?)');
  db.transaction(() => { for (const mid of modelIds) insert.run(req.params.id, mid); })();
  res.json({ success: true, added: modelIds.length });
});

app.delete('/api/collections/:id/models/:modelId', (req, res) => {
  db.prepare('DELETE FROM collection_models WHERE collection_id = ? AND model_id = ?').run(req.params.id, req.params.modelId);
  res.json({ success: true });
});

app.get('/api/models/:id(\\d+)/collections', (req, res) => {
  const cols = db.prepare(`
    SELECT c.id, c.name, c.color FROM collections c
    JOIN collection_models cm ON cm.collection_id = c.id
    WHERE cm.model_id = ? ORDER BY c.name
  `).all(req.params.id);
  res.json(cols);
});

// ── Health ────────────────────────────────────────────────────────────────────

// Libraries and writability are cached (startup, after scans, then at most once a minute in the
// background): /api/health is polled and must never block on a slow or stalled library mount.
const HEALTH_TTL_MS = 60000;
const HEALTH_FS_TIMEOUT_MS = 3000;
const healthCache = { libraries: null, libraryWritable: null, at: 0, error: null, pending: null };
function refreshHealthCache() {
  if (healthCache.pending) return healthCache.pending;
  healthCache.pending = librariesLib.listLibrariesAsync(LIBRARY_PATH, metaSummary?.libraryLabels, { timeoutMs: HEALTH_FS_TIMEOUT_MS })
    .then(({ libraries, rootWritable }) => {
      healthCache.libraries = libraries.map(l => ({ name: l.name, path: l.path, writable: !!l.writable }));
      healthCache.libraryWritable = rootWritable;
      healthCache.error = null;
    })
    .catch((e) => { healthCache.error = e.message; })
    .finally(() => { healthCache.at = Date.now(); healthCache.pending = null; });
  return healthCache.pending;
}
refreshHealthCache();

app.get('/api/health', async (req, res) => {
  if (!healthCache.at && healthCache.pending) await healthCache.pending; // first call: bounded by HEALTH_FS_TIMEOUT_MS
  else if (Date.now() - healthCache.at > HEALTH_TTL_MS) refreshHealthCache(); // answer from cache, refresh behind
  res.json({
    ok: true,
    libraryPath: LIBRARY_PATH,
    ...APP_VERSION,
    gitSha: process.env.GIT_SHA || 'dev',
    buildDate: process.env.BUILD_DATE || '',
    libraryWritable: healthCache.libraryWritable,
    layoutMode: (process.env.LAYOUT_MODE || 'layout').toLowerCase() === 'legacy' ? 'legacy' : 'layout',
    libraries: healthCache.libraries || [],
    ...(healthCache.error ? { libraryError: healthCache.error } : {}),
    librariesCheckedAt: healthCache.at ? new Date(healthCache.at).toISOString() : null,
  });
});

// ── Facets, _Meta and attribution (docs/library-metadata.md §7) ──────────────

const ATTRIBUTED = new Set(['sidecar', 'exact', 'name']);
const countList = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));

app.get('/api/facets', (req, res) => {
  const rows = db.prepare(`
    SELECT m.library, m.libraries, m.studio, m.franchise, m.release_term, COALESCE(m.kind, 'model') AS kind, m.source, m.confidence, c.name AS creator
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
  `).all();
  const f = { libraries: new Map(), studios: new Map(), creators: new Map(), genres: new Map(), terms: new Map(), kinds: new Map(), sources: new Map(), confidence: new Map() };
  const inc = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const r of rows) {
    inc(f.kinds, r.kind);
    if (r.kind === 'tool') continue;
    const libs = parseJSON(r.libraries, r.library ? [r.library] : []);
    for (const l of libs) inc(f.libraries, l);
    inc(f.studios, r.studio); inc(f.creators, r.creator); inc(f.genres, r.franchise); inc(f.terms, r.release_term);
    inc(f.sources, r.source); inc(f.confidence, r.confidence || 'none');
  }
  const out = Object.fromEntries(Object.entries(f).map(([k, m]) => [k, countList(m)]));
  out.terms.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  res.json(out);
});

/**
 * _Meta status. model.json sidecars are read by the scanner (it walks the library, the server
 * does not): their count and the unreadable ones come from the last full scan.
 */
function metaStatusBody(sum) {
  const st = JSON.parse(JSON.stringify(sum.status));
  const sc = parseInt(db.getSetting ? db.getSetting('meta_sidecars') : '', 10);
  if (Number.isFinite(sc)) st.counts.sidecars = sc;
  const bad = parseJSON(db.getSetting ? db.getSetting('meta_sidecar_errors') : null, []);
  if (Array.isArray(bad) && bad.length) {
    st.errors = [...st.errors, ...bad.slice(0, 50)];
    st.counts.sidecarErrors = bad.length;
  }
  return st;
}
// Express 4 does not catch rejected promises: async routes go through this
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get('/api/meta/status', asyncRoute(async (req, res) => res.json(metaStatusBody(await getMetaSummary()))));
app.post('/api/meta/reload', asyncRoute(async (req, res) => { gapsCache = null; res.json(metaStatusBody(await getMetaSummary({ reload: true }))); }));

/**
 * Owned manifest products with no file in any library. A product is present when any of its
 * files (name key + size) is in model_files on any card, or a card/file was attributed to it.
 * Listed once per creator + name (a product bought twice has two download URLs).
 */
let gapsCache = null; // { sum, fp, owned }
function ownedKeys(sum) {
  const fp = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS mx FROM model_files').get();
  const fpKey = `${fp.n}|${fp.mx}`;
  if (gapsCache && gapsCache.sum === sum && gapsCache.fp === fpKey) return gapsCache;
  const wanted = new Set();
  for (const p of sum.products) for (const k of p.keys) wanted.add(k);
  const sizes = new Set([...wanted].map(k => k.slice(k.lastIndexOf('|') + 1)));
  const files = new Set();
  for (const r of db.prepare('SELECT filename, filesize FROM model_files WHERE filesize IS NOT NULL').iterate()) {
    if (!sizes.has(String(r.filesize))) continue; // fileKey() only for candidate sizes
    const k = `${metaLib.fileKey(r.filename)}|${r.filesize}`;
    if (wanted.has(k)) files.add(k);
  }
  const products = new Set();
  for (const r of db.prepare(`SELECT products FROM models WHERE products IS NOT NULL AND products != '[]'`).all()) {
    for (const p of parseJSON(r.products, [])) products.add(p.libraryUrl || p.name);
  }
  for (const r of db.prepare('SELECT DISTINCT product FROM model_files WHERE product IS NOT NULL').all()) products.add(r.product);
  gapsCache = { sum, fp: fpKey, files, products };
  return gapsCache;
}
async function attributionGaps(creatorFilter) {
  const sum = await getMetaSummary();
  const { files, products } = ownedKeys(sum);
  const want = creatorFilter ? String(creatorFilter).toLowerCase() : null;
  const missing = new Map();
  for (const p of sum.products) {
    if (products.has(p.libraryUrl || p.name) || products.has(p.name) || p.keys.some(k => files.has(k))) continue;
    if (want && ![p.creator, p.rawCreator, p.studio].some(x => x && String(x).toLowerCase() === want)) continue;
    const id = `${String(p.creator || '').toLowerCase()}|${String(p.name).toLowerCase()}`;
    const prev = missing.get(id);
    if (prev && prev.files >= p.files) continue;
    missing.set(id, {
      creator: p.creator, name: p.name, term: p.term || null, libraryUrl: p.libraryUrl, productUrl: p.productUrl || null,
      files: p.files, sizeGB: Math.round(p.bytes / 1e7) / 100,
    });
  }
  // a product (creator + name) present under another download URL is not missing
  for (const p of sum.products) {
    if (products.has(p.libraryUrl || p.name) || p.keys.some(k => files.has(k))) missing.delete(`${String(p.creator || '').toLowerCase()}|${String(p.name).toLowerCase()}`);
  }
  return [...missing.values()]
    .sort((a, b) => String(a.creator).localeCompare(String(b.creator)) || String(b.term || '').localeCompare(String(a.term || '')) || a.name.localeCompare(b.name));
}

app.get('/api/attribution/summary', asyncRoute(async (req, res) => {
  const rows = db.prepare(`
    SELECT m.libraries, m.library, m.studio, m.confidence FROM models m
    WHERE (m.hidden IS NULL OR m.hidden = 0) AND COALESCE(m.kind, 'model') != 'tool'
  `).all();
  const byConfidence = {};
  const lib = new Map(), studio = new Map();
  const add = (m, k, a) => { if (!k) return; const v = m.get(k) || { name: k, total: 0, attributed: 0 }; v.total++; if (a) v.attributed++; m.set(k, v); };
  for (const r of rows) {
    const c = r.confidence || 'none';
    byConfidence[c] = (byConfidence[c] || 0) + 1;
    const a = ATTRIBUTED.has(c);
    for (const l of parseJSON(r.libraries, r.library ? [r.library] : [])) add(lib, l, a);
    add(studio, r.studio || 'Other', a);
  }
  res.json({
    total: rows.length, byConfidence,
    byLibrary: [...lib.values()].sort((a, b) => b.total - a.total),
    byStudio: [...studio.values()].sort((a, b) => b.total - a.total),
    gaps: (await attributionGaps()).length,
  });
}));

app.get('/api/attribution/gaps', asyncRoute(async (req, res) => {
  res.json({ products: await attributionGaps(req.query.creator) });
}));

// ── Library roots ───────────────────────────────────────────────────────────
// Lists the top-level folders mounted under LIBRARY_PATH (one per docker-compose
// volume line). Lets the UI show what's actually mounted and how many models
// each root holds — read-only; mounts themselves are configured in .env.
app.get('/api/library/roots', (req, res) => {
  let entries = [];
  try {
    entries = fs.readdirSync(LIBRARY_PATH, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('@') && !e.name.startsWith('#') && !e.name.startsWith('.'))
      .map(e => e.name);
  } catch (err) {
    return res.json({ libraryPath: LIBRARY_PATH, mounted: false, roots: [], error: err.message });
  }

  const roots = entries.map(name => {
    const fullPath = path.join(LIBRARY_PATH, name);
    let accessible = false;
    try { fs.accessSync(fullPath, fs.constants.R_OK); accessible = true; } catch {}
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM models WHERE folder_path = ? OR folder_path LIKE ? ESCAPE '\\'"
    ).get(fullPath, likeEscape(fullPath) + '/%').n;
    return { name, path: fullPath, accessible, modelCount: count };
  }).sort((a, b) => a.name.localeCompare(b.name));

  res.json({ libraryPath: LIBRARY_PATH, mounted: true, roots });
});

// Folder tree built from indexed models' folder_path values. Each node carries
// an aggregate model count (a model counts toward every ancestor folder).
app.get('/api/library/tree', (req, res) => {
  const rows = db.prepare(
    'SELECT folder_path FROM models WHERE folder_path IS NOT NULL AND (hidden IS NULL OR hidden = 0)'
  ).all();

  const root = { name: 'Library', path: LIBRARY_PATH, children: {}, count: 0 };
  const base = LIBRARY_PATH.replace(/\/+$/, '');

  for (const row of rows) {
    const folder_path = realFolder(row.folder_path); // virtual "<folder>#<slug>" counts toward its folder
    if (!folder_path || !folder_path.startsWith(base)) continue;
    const rel = folder_path.slice(base.length).replace(/^\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    let node = root;
    node.count++;
    let accum = base;
    for (const part of parts) {
      accum += '/' + part;
      if (!node.children[part]) node.children[part] = { name: part, path: accum, children: {}, count: 0 };
      node = node.children[part];
      node.count++;
    }
  }

  const toArr = (node) => ({
    name: node.name,
    path: node.path,
    count: node.count,
    children: Object.values(node.children).map(toArr).sort((a, b) => a.name.localeCompare(b.name)),
  });

  res.json(toArr(root));
});

// ── Wishlist ──────────────────────────────────────────────────────────────────

const SITE_PATTERNS = [
  { re: /printables\.com/i,     site: 'printables' },
  { re: /thingiverse\.com/i,    site: 'thingiverse' },
  { re: /myminifactory\.com/i,  site: 'myminifactory' },
  { re: /cults3d\.com/i,        site: 'cults3d' },
  { re: /patreon\.com/i,        site: 'patreon' },
  { re: /gumroad\.com/i,        site: 'gumroad' },
];

function detectSite(url) {
  for (const { re, site } of SITE_PATTERNS) if (re.test(url)) return site;
  return null;
}

app.get('/api/wishlist', (req, res) => {
  const items = db.prepare('SELECT * FROM wishlist ORDER BY added_at DESC').all();
  res.json(items);
});

app.post('/api/wishlist', (req, res) => {
  const { url, name, notes } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'url required' });
  const source_site = detectSite(url);
  try {
    const r = db.prepare(
      'INSERT INTO wishlist (url, name, source_site, notes) VALUES (?, ?, ?, ?)'
    ).run(url.trim(), name?.trim() || null, source_site, notes?.trim() || null);
    res.json({ id: r.lastInsertRowid, url: url.trim(), name: name?.trim() || null, source_site, notes: notes?.trim() || null, status: 'want' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/wishlist/:id', (req, res) => {
  const { status, name, notes, url } = req.body;
  const item = db.prepare('SELECT id FROM wishlist WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const updates = []; const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (name !== undefined)   { updates.push('name = ?');   params.push(name || null); }
  if (notes !== undefined)  { updates.push('notes = ?');  params.push(notes || null); }
  if (url !== undefined)    {
    updates.push('url = ?'); params.push(url);
    updates.push('source_site = ?'); params.push(detectSite(url));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE wishlist SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

app.delete('/api/wishlist/:id', (req, res) => {
  db.prepare('DELETE FROM wishlist WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// JSON error handler (must be registered after every route)
app.use(errorHandler);

// ── Process lifecycle ────────────────────────────────────────────────────────

function startServer() {
  // A crashed async handler must never take the whole server down.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  });
  let shuttingDown = false;
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
    // State may be inconsistent after a synchronous throw — shut down cleanly
    // (Docker's restart policy brings us back).
    shutdown('uncaughtException', 1);
  });

  // Anything left 'running' from a previous process was interrupted.
  markRunningScans('interrupted', 'Server restarted during scan');

  const server = app.listen(PORT, HOST, () => console.log(`The Vault v${APP_VERSION.version} (build ${APP_VERSION.build}) running on ${HOST}:${PORT}`));
  if (enrich.fakeEnabled()) {
    console.warn('\n' + '!'.repeat(78) + '\n!! ENRICH_FAKE=1: AI enrichment answers come from the DEV FAKE MODEL, not Claude.\n!! For UI demos only. Unset ENRICH_FAKE in any real deployment.\n' + '!'.repeat(78) + '\n');
  }

  // Daily DB snapshot: first check 60s after start (never delays the
  // healthcheck), then hourly; writes one file per day.
  try { require('./lib/backup').startDailyBackups({ db, delayMs: 60 * 1000 }); } catch (e) { console.error('[backup]', e.message); }
  // Card-size thumbs for any card image without one: once, a little after start (one at a time)
  if (thumbsAutomatic()) {
    const t = setTimeout(() => { try { const n = thumbs.fillMissing(db); if (n) console.log(`[thumbs] making ${n} card thumbnail(s) in the background`); } catch (e) { console.warn('[thumbs]', e.message); } }, 20 * 1000);
    t.unref();
  }

  function shutdown(signal, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — closing`);
    const hardExit = setTimeout(() => { console.error('[shutdown] timed out, forcing exit'); process.exit(code || 1); }, 5000);
    hardExit.unref();
    try { require('./lib/backup').stopDailyBackups(); } catch {}
    server.close();
    try { server.closeIdleConnections?.(); } catch {}
    // SSE streams never go idle — give in-flight requests a moment, then cut them.
    setTimeout(() => { try { server.closeAllConnections?.(); } catch {} }, 1500).unref();
    (async () => {
      if (scanWorker) {
        markRunningScans('interrupted', `Server shutdown (${signal})`);
        try { await scanWorker.terminate(); } catch {}
      }
      thumbs.stopFiller();
      await stopFillJob();
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[shutdown] checkpoint failed:', e.message); }
      try { db.close(); } catch {}
      console.log('[shutdown] database closed');
      process.exit(code);
    })();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

// Only start the server if run directly (not when imported for testing)
if (require.main === module) startServer();

module.exports = app;
