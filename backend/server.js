const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { scanLibrary, scanSingleCreator, LIBRARY_PATH, matchesHint, pickRenderArchives, analyzeFolder, inferReleaseName } = require('./scanner');
const { scrapeImagesFromUrl, detectUrlFromFolderName } = require('./scraper');
const organizeRouter = require('./organize');

const app = express();
const PORT = process.env.PORT || 3001;
const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';

// Version info — auto-incremented by pre-commit hook
let APP_VERSION = { version: '0.0.0', build: 0 };
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch {}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/images', express.static(IMAGES_DIR));
app.use('/api/organize', organizeRouter);

// ── Scan ──────────────────────────────────────────────────────────────────────

let scanInProgress = false;
let scanLog = [];       // running log lines
let scanSummary = null; // final result

function pushLog(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg };
  scanLog.push(line);
  return line;
}

// SSE stream — client connects and receives log lines in real time
app.get('/api/scan/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Replay existing log lines for late-joiners
  scanLog.forEach(line => send(line));
  if (scanSummary) { send({ type: 'done', ...scanSummary }); res.end(); return; }
  if (!scanInProgress) { send({ type: 'idle' }); res.end(); return; }

  // Subscribe to new log lines via polling the array length
  let lastIdx = scanLog.length;
  const interval = setInterval(() => {
    while (lastIdx < scanLog.length) send(scanLog[lastIdx++]);
    if (!scanInProgress) {
      if (scanSummary) send({ type: 'done', ...scanSummary });
      clearInterval(interval);
      res.end();
    }
  }, 150);

  req.on('close', () => clearInterval(interval));
});

app.post('/api/scan', async (req, res) => {
  if (scanInProgress) return res.status(409).json({ error: 'Scan already in progress' });
  const libPath = req.body.path || LIBRARY_PATH;
  const force = req.body.force === true;
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: `Path not found: ${libPath}` });

  // Force full rescan: clear all folder hashes so nothing is skipped
  if (force) {
    db.prepare('UPDATE models SET folder_hash = NULL').run();
  }

  scanInProgress = true;
  scanLog = [];
  scanSummary = null;

  res.json({ message: 'Scan started', path: libPath, force });

  pushLog('info', `Starting ${force ? 'FULL ' : ''}scan: ${libPath}`);
  pushLog('info', 'Discovering creators and models…');

  try {
    const result = await scanLibrary(libPath, (p) => {
      if (p.stage === 'scanning') {
        if (p.model) pushLog('scan', `  ${p.creator} / ${p.model}`);
        else if (p.creator) pushLog('creator', `▸ Creator: ${p.creator}`);
      }
    }, pushLog);

    pushLog('success', `✓ Scan complete — ${result.modelsFound} found · ${result.modelsAdded} added · ${result.modelsUpdated} updated · ${result.modelsSkipped} skipped (unchanged)`);
    scanSummary = { type: 'done', success: true, ...result };
  } catch (err) {
    pushLog('error', `✗ Error: ${err.message}`);
    scanSummary = { type: 'done', success: false, error: err.message };
  } finally {
    scanInProgress = false;
  }
});

// Legacy status endpoint (still used by anything polling)
app.get('/api/scan/status', (req, res) => {
  res.json({ inProgress: scanInProgress, log: scanLog, summary: scanSummary });
});

// Per-creator rescan — scans a single creator's folder using the shared SSE machinery
app.post('/api/scan/creator/:id', async (req, res) => {
  if (scanInProgress) return res.status(409).json({ error: 'Scan already in progress' });
  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Creator not found' });
  if (!creator.folder_path) return res.status(400).json({ error: 'Creator has no folder path' });
  if (!fs.existsSync(creator.folder_path)) return res.status(400).json({ error: `Folder not found: ${creator.folder_path}` });

  scanInProgress = true;
  scanLog = [];
  scanSummary = null;

  res.json({ message: 'Creator scan started', creator: creator.name, path: creator.folder_path });

  pushLog('info', `Scanning creator: ${creator.name}`);
  pushLog('info', `Path: ${creator.folder_path}`);

  try {
    const result = await scanSingleCreator(
      creator.folder_path, creator.id, creator.name,
      (p) => {
        if (p.stage === 'scanning') {
          if (p.model) pushLog('scan', `  ${p.creator} / ${p.model}`);
        }
      },
      pushLog
    );
    pushLog('success', `✓ Done — ${result.modelsFound} found · ${result.modelsAdded} added · ${result.modelsUpdated} updated · ${result.modelsSkipped} skipped`);
    scanSummary = { type: 'done', success: true, ...result };
  } catch (err) {
    pushLog('error', `✗ Error: ${err.message}`);
    scanSummary = { type: 'done', success: false, error: err.message };
  } finally {
    scanInProgress = false;
  }
});

// ── Models ─────────────────────────────────────────────────────────────────────

app.get('/api/models', (req, res) => {
  const { search, creator, status, tags, franchise, page = 1, limit = 48, show_hidden, has_thumbnail, recently_added } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = ['1=1'];
  const params = [];

  // Hide hidden models by default; show_hidden=1 to include them
  if (!show_hidden || show_hidden === '0') {
    where.push('(m.hidden IS NULL OR m.hidden = 0)');
  }

  // Thumbnail filter
  if (has_thumbnail === '1') {
    where.push('m.thumbnail_path IS NOT NULL');
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

  if (search) {
    where.push('(m.name LIKE ? OR c.name LIKE ? OR m.tags LIKE ? OR m.notes LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (creator) { where.push('c.name = ?'); params.push(creator); }
  if (status) { where.push('m.print_status = ?'); params.push(status); }
  if (tags) {
    const tagList = tags.split(',');
    tagList.forEach(t => { where.push("m.tags LIKE ?"); params.push(`%"${t.trim()}"%`); });
  }

  const whereStr = where.join(' AND ');
  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM models m LEFT JOIN creators c ON m.creator_id = c.id WHERE ${whereStr}
  `).get(...params).cnt;

  const models = db.prepare(`
    SELECT m.*, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE ${whereStr}
    ORDER BY c.name ASC, m.name ASC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    models: models.map(m => ({
      ...m,
      tags: JSON.parse(m.tags || '[]'),
      images: JSON.parse(m.images || '[]')
    })),
    total,
    page: parseInt(page),
    pages: Math.ceil(total / parseInt(limit))
  });
});

app.get('/api/models/:id', (req, res) => {
  const model = db.prepare(`
    SELECT m.*, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE m.id = ?
  `).get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const files = db.prepare('SELECT * FROM model_files WHERE model_id = ? ORDER BY release_name NULLS LAST, filetype, filename').all(model.id);
  res.json({
    ...model,
    tags: JSON.parse(model.tags || '[]'),
    images: JSON.parse(model.images || '[]'),
    files
  });
});

app.patch('/api/models/:id', (req, res) => {
  const { print_status, tags, notes, source_url, name, thumbnail_path, hidden, franchise, team } = req.body;
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const params = [];
  if (print_status !== undefined) { updates.push('print_status = ?'); params.push(print_status); }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (source_url !== undefined) { updates.push('source_url = ?'); params.push(source_url); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (thumbnail_path !== undefined) { updates.push('thumbnail_path = ?'); params.push(thumbnail_path); }
  if (hidden !== undefined) { updates.push('hidden = ?'); params.push(hidden ? 1 : 0); }
  if (franchise !== undefined) { updates.push('franchise = ?'); params.push(franchise || null); }
  if (team !== undefined) { updates.push('team = ?'); params.push(team || null); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
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

// Re-extract renders for all models belonging to a creator, using the current hint
app.post('/api/creators/:id/reextract', async (req, res) => {
  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (level, msg) => res.write(`data: ${JSON.stringify({ level, msg, ts: new Date().toISOString() })}\n\n`);
  const done = (data) => { res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`); res.end(); };

  const AdmZip = require('adm-zip');
  const hint = creator.render_zip_hint || null;
  send('info', `Creator: ${creator.name}`);
  send('info', `Render ZIP hint: ${hint || '(auto-detect by keyword)'}`);

  const models = db.prepare('SELECT * FROM models WHERE creator_id = ?').all(creator.id);
  send('info', `Processing ${models.length} model(s)…`);

  let updated = 0, skipped = 0;
  for (const model of models) {
    // Model-level hint overrides creator hint
    const effectiveHint = model.render_zip_hint || hint;
    const analysis = analyzeFolder(model.folder_path);
    const renderZips = pickRenderZips(analysis, effectiveHint);

    if (renderZips.length === 0) {
      send('warn', `  ⚠ ${model.name}: no matching ZIP found`);
      skipped++;
      continue;
    }

    send('zip', `  📦 ${model.name}: extracting from ${renderZips.map(z => path.basename(z)).join(', ')}`);

    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    const modelImgDir = path.join(IMAGES_DIR, model.uuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });

    const freshImages = [];
    for (const zipPath of renderZips) {
      try {
        const zip = new AdmZip(zipPath);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const ext = path.extname(entry.entryName).toLowerCase();
          if (!IMAGE_EXTS.has(ext)) continue;
          const safeName = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, '_');
          const outPath = path.join(modelImgDir, safeName);
          zip.extractEntryTo(entry, modelImgDir, false, true, false, safeName);
          freshImages.push(`/images/${model.uuid}/${safeName}`);
        }
      } catch (e) {
        send('error', `    ✗ Failed: ${e.message}`);
      }
    }

    if (freshImages.length > 0) {
      const existing = JSON.parse(model.images || '[]');
      const merged = [...new Set([...freshImages, ...existing])];
      db.prepare(`UPDATE models SET images=?, thumbnail_path=?, folder_hash=NULL, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(merged), merged[0], model.id);
      send('img', `     → ${freshImages.length} image(s) saved`);
      updated++;
    } else {
      send('warn', `     ⚠ No images found inside ZIP(s)`);
      skipped++;
    }
  }

  done({ success: true, updated, skipped });
});

// Per-model render ZIP hint override
app.patch('/api/models/:id/render-hint', (req, res) => {
  const { render_zip_hint } = req.body;
  db.prepare('UPDATE models SET render_zip_hint = ?, folder_hash = NULL WHERE id = ?').run(render_zip_hint || null, req.params.id);
  res.json({ success: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM models WHERE hidden IS NULL OR hidden = 0').get().n;
  const totalHidden = db.prepare('SELECT COUNT(*) as n FROM models WHERE hidden = 1').get().n;
  const byStatus = db.prepare(`
    SELECT print_status, COUNT(*) as n FROM models WHERE hidden IS NULL OR hidden = 0 GROUP BY print_status
  `).all();
  const creators = db.prepare('SELECT COUNT(*) as n FROM creators').get().n;
  const withImages = db.prepare("SELECT COUNT(*) as n FROM models WHERE thumbnail_path IS NOT NULL AND (hidden IS NULL OR hidden = 0)").get().n;
  const lastScan = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();

  // Count models added since the last scan started
  let recentlyAdded = 0;
  if (lastScan?.started_at) {
    recentlyAdded = db.prepare('SELECT COUNT(*) as n FROM models WHERE (hidden IS NULL OR hidden = 0) AND created_at >= ?').get(lastScan.started_at).n;
  }

  // Franchise list with counts
  const franchises = db.prepare(`
    SELECT franchise, COUNT(*) as count FROM models
    WHERE franchise IS NOT NULL AND franchise != '' AND (hidden IS NULL OR hidden = 0)
    GROUP BY franchise ORDER BY count DESC, franchise
  `).all();

  res.json({ total, totalHidden, byStatus, creators, withImages, lastScan, recentlyAdded, franchises });
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

  if (hidden !== undefined) {
    const result = db.prepare(
      `UPDATE models SET hidden = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(hidden ? 1 : 0, ...ids);
    updated = result.changes;
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

  res.json({ success: true, updated });
});

// SSE stream version of scrape (GET so EventSource can use it)
app.get('/api/models/:id/scrape-stream', async (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (level, msg) => res.write(`data: ${JSON.stringify({ level, msg, ts: new Date().toISOString() })}\n\n`);
  const done = (data) => { res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`); res.end(); };

  let sourceUrl = req.query.url || model.source_url;
  if (!sourceUrl) {
    const folderName = path.basename(model.folder_path);
    const detected = detectUrlFromFolderName(folderName);
    if (detected) { sourceUrl = detected.url; send('info', `Auto-detected URL: ${sourceUrl}`); }
  }

  if (!sourceUrl) return done({ success: false, error: 'No source URL — paste one manually.' });

  send('info', `Fetching: ${sourceUrl}`);

  try {
    const { savedPaths, sourceSite, sourceUrl: finalUrl } = await scrapeImagesFromUrl(sourceUrl, model.uuid, send);
    if (savedPaths.length === 0) return done({ success: false, error: 'No images could be downloaded.' });

    send('success', `✓ Downloaded ${savedPaths.length} image(s)`);

    const existingImages = JSON.parse(model.images || '[]');
    const allImages = [...new Set([...existingImages, ...savedPaths])];
    db.prepare(`UPDATE models SET images=?, thumbnail_path=?, source_url=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(allImages), allImages[0], finalUrl, model.id);
    if (sourceSite && sourceSite !== 'unknown') {
      db.prepare(`UPDATE models SET source_site=? WHERE id=?`).run(sourceSite, model.id);
    }
    done({ success: true, images: savedPaths, total: allImages.length });
  } catch (err) {
    done({ success: false, error: err.message });
  }
});

app.post('/api/models/:id/scrape', async (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  // SSE mode if client requests it
  const useStream = req.headers.accept === 'text/event-stream';
  if (useStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  const sendLog = (level, msg) => {
    if (useStream) res.write(`data: ${JSON.stringify({ level, msg, ts: new Date().toISOString() })}\n\n`);
  };
  const sendDone = (data) => {
    if (useStream) { res.write(`data: ${JSON.stringify({ type: 'done', ...data })}\n\n`); res.end(); }
    else res.json(data);
  };
  const sendError = (msg) => {
    if (useStream) { res.write(`data: ${JSON.stringify({ type: 'done', success: false, error: msg })}\n\n`); res.end(); }
    else res.status(500).json({ error: msg });
  };

  let sourceUrl = req.body.url || model.source_url;
  if (!sourceUrl) {
    const folderName = path.basename(model.folder_path);
    const detected = detectUrlFromFolderName(folderName);
    if (detected) { sourceUrl = detected.url; sendLog('info', `Auto-detected URL from folder name: ${sourceUrl}`); }
  }

  if (!sourceUrl) return sendError('No source URL provided and none could be auto-detected from the folder name.');

  sendLog('info', `Fetching page: ${sourceUrl}`);

  try {
    const { savedPaths, sourceSite, sourceUrl: finalUrl } = await scrapeImagesFromUrl(sourceUrl, model.uuid, sendLog);

    if (savedPaths.length === 0) return sendError('Found the page but could not download any images.');

    sendLog('success', `✓ Downloaded ${savedPaths.length} image(s)`);

    const existingImages = JSON.parse(model.images || '[]');
    const allImages = [...new Set([...existingImages, ...savedPaths])];
    const thumbnail = allImages[0];

    db.prepare(`UPDATE models SET images = ?, thumbnail_path = ?, source_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(allImages), thumbnail, finalUrl, model.id);
    if (sourceSite && sourceSite !== 'unknown') {
      db.prepare(`UPDATE models SET source_site = ? WHERE id = ?`).run(sourceSite, model.id);
    }

    sendDone({ success: true, images: savedPaths, total: allImages.length });
  } catch (err) {
    sendError(err.message);
  }
});

// Auto-detect source URL from folder name
app.get('/api/models/:id/detect-url', (req, res) => {
  const model = db.prepare('SELECT folder_path, source_url FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  if (model.source_url) return res.json({ url: model.source_url, source: 'saved' });

  const folderName = path.basename(model.folder_path);
  const detected = detectUrlFromFolderName(folderName);
  if (detected) return res.json({ url: detected.url, site: detected.site, source: 'folder_name' });

  res.json({ url: null });
});

// ── ZIP Image Picker ──────────────────────────────────────────────────────────

// List all ZIP files for a model
app.get('/api/models/:id/zips', (req, res) => {
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const zips = db.prepare(
    "SELECT * FROM model_files WHERE model_id = ? AND (filetype = 'zip' OR filename LIKE '%.zip')"
  ).all(model.id);

  res.json(zips);
});

// Preview images inside a ZIP without extracting
app.get('/api/files/:fileId/zip-contents', (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!fs.existsSync(file.filepath)) return res.status(404).json({ error: 'File not found on disk' });

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(file.filepath);
    const entries = zip.getEntries()
      .filter(e => !e.isDirectory)
      .map(e => {
        const ext = path.extname(e.entryName).toLowerCase();
        return {
          name: e.entryName,
          basename: path.basename(e.entryName),
          size: e.header.size,
          isImage: IMAGE_EXTS.has(ext),
          ext
        };
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
app.post('/api/files/:fileId/extract-images', (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(file.model_id);
  if (!model) return res.status(404).json({ error: 'Model not found' });

  const { selectedFiles } = req.body; // optional: array of entry names to extract, or extract all images

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(file.filepath);
    const entries = zip.getEntries().filter(e => {
      if (e.isDirectory) return false;
      const ext = path.extname(e.entryName).toLowerCase();
      if (selectedFiles && selectedFiles.length > 0) {
        return selectedFiles.includes(e.entryName);
      }
      return IMAGE_EXTS.has(ext);
    });

    if (entries.length === 0) {
      return res.status(422).json({ error: 'No image files found in this ZIP' });
    }

    const modelImgDir = path.join(IMAGES_DIR, model.uuid);
    if (!fs.existsSync(modelImgDir)) fs.mkdirSync(modelImgDir, { recursive: true });

    const savedPaths = [];
    for (const entry of entries) {
      const safeName = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(modelImgDir, safeName);
      zip.extractEntryTo(entry, modelImgDir, false, true, false, safeName);
      if (fs.existsSync(destPath)) {
        savedPaths.push(`/images/${model.uuid}/${safeName}`);
      }
    }

    // Merge with existing images
    const existingImages = JSON.parse(model.images || '[]');
    const allImages = [...new Set([...existingImages, ...savedPaths])];
    const thumbnail = allImages[0];

    db.prepare(`
      UPDATE models SET images = ?, thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(allImages), thumbnail, model.id);

    res.json({ success: true, extracted: savedPaths.length, images: savedPaths, total: allImages.length });
  } catch (e) {
    res.status(500).json({ error: `Extraction failed: ${e.message}` });
  }
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

// ── Claude API Helper ─────────────────────────────────────────────────────────

function callClaudeAPI(apiKey, body, { timeoutMs = 120000 } = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        // Check HTTP status BEFORE trying to parse JSON
        if (apiRes.statusCode !== 200) {
          // Try to extract a useful error message
          let errMsg = `Claude API returned HTTP ${apiRes.statusCode}`;
          if (apiRes.statusCode === 401) errMsg = 'Invalid API key — check your key at console.anthropic.com';
          else if (apiRes.statusCode === 403) errMsg = 'API key lacks permission — check your key permissions';
          else if (apiRes.statusCode === 429) errMsg = 'Rate limited — too many requests, wait a moment and retry';
          else if (apiRes.statusCode === 500) errMsg = 'Claude API internal error — try again later';
          else if (apiRes.statusCode === 529) errMsg = 'Claude API overloaded — try again in a few minutes';

          // Try to get more detail from response body
          try {
            const parsed = JSON.parse(data);
            if (parsed.error?.message) errMsg += `: ${parsed.error.message}`;
          } catch {
            // Response was HTML or other non-JSON (e.g. Cloudflare error page)
            const titleMatch = data.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) errMsg += ` (${titleMatch[1]})`;
            else if (data.length < 200) errMsg += ` — ${data.substring(0, 100)}`;
          }
          return reject(new Error(errMsg));
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Claude API error: ${parsed.error.message}`));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Claude response as JSON (got ${data.substring(0, 80)}…)`));
        }
      });
    });

    // Timeout
    apiReq.setTimeout(timeoutMs, () => {
      apiReq.destroy();
      reject(new Error(`Claude API timed out after ${Math.round(timeoutMs / 1000)}s — the request may have been too large`));
    });

    apiReq.on('error', (e) => {
      if (e.code === 'ECONNRESET') reject(new Error('Connection to Claude API was reset — check your network'));
      else if (e.code === 'ENOTFOUND') reject(new Error('Cannot reach api.anthropic.com — check DNS/network'));
      else reject(new Error(`Network error calling Claude API: ${e.message}`));
    });

    apiReq.write(payload);
    apiReq.end();
  });
}

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

// ── AI Auto-Tagging (SSE) ────────────────────────────────────────────────────

app.get('/api/ai/generate-tags', async (req, res) => {
  const apiKey = req.query.key || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const log = (level, msg) => send({ level, msg, ts: new Date().toISOString() });
  const finish = (data) => { send({ type: 'done', ...data }); res.end(); };

  // Gather all models with creator names and slicer info
  const models = db.prepare(`
    SELECT m.id, m.name, m.tags, m.folder_path, m.has_chitubox, m.has_lychee, c.name as creator_name
    FROM models m LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY c.name, m.name
  `).all();

  if (models.length === 0) {
    log('info', 'No models found to tag.');
    return finish({ success: true, tagged: 0, total: 0 });
  }

  log('info', `Found ${models.length} model(s) to tag`);

  // Build a manifest for Claude — batch into chunks of 50 for better progress visibility
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    batches.push(models.slice(i, i + BATCH_SIZE));
  }

  log('info', `Split into ${batches.length} batch(es) of up to ${BATCH_SIZE}`);

  let totalTagged = 0;
  let totalErrors = 0;

  const systemPrompt = `You are a tagging assistant for "The Vault", a 3D print model library.
Given a list of 3D printable models with their names, creator names, folder paths, and slicer format, generate up to 7 relevant tags per model.

Rules:
- Max 7 tags per model. Fewer is fine if there aren't 7 meaningful tags.
- The creator name should ALWAYS be included as a tag (exactly as given, lowercase).
- Tags should be lowercase.
- Tags should describe the model's franchise, category, character, or theme.
- If slicer is "resin" (Chitubox/Lychee files present), include "resin" as a tag.
- If slicer is "fdm" (no resin slicer files), include "fdm" as a tag. This is important for filtering by print technology.
- Examples: "star wars", "marvel", "thundercats", "dragon", "miniature", "terrain", "bust", "vehicle", "droid", "rebel", "empire", "fantasy", "sci-fi", "anime", "warhammer", "dnd", "resin", "fdm"
- Use broad franchise tags (e.g. "star wars") AND specific tags (e.g. "rebel", "x-wing")
- Use the folder path structure for context clues (e.g. "Star Wars/Vehicles/X-wing" → tags: ["star wars", "vehicle", "x-wing"])
- If a model name suggests a known character or IP, tag appropriately (e.g. "Cheetara" → ["thundercats", "cheetara"])

Respond with ONLY a JSON array. Each element: {"id": <model_id>, "tags": ["tag1", "tag2", ...]}
No other text or explanation — just the JSON array.`;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchLabel = `Batch ${b + 1}/${batches.length}`;
    const firstCreator = batch[0]?.creator_name || 'unknown';
    const lastCreator = batch[batch.length - 1]?.creator_name || 'unknown';
    const creatorRange = firstCreator === lastCreator ? firstCreator : `${firstCreator} → ${lastCreator}`;

    log('info', `${batchLabel} — ${batch.length} models (${creatorRange})`);
    log('api', `${batchLabel} — sending to Claude API…`);

    const manifest = batch.map(m => ({
      id: m.id,
      name: m.name,
      creator: m.creator_name,
      path: m.folder_path.replace(/^\/library\/?/, ''),
      slicer: (m.has_chitubox || m.has_lychee) ? 'resin' : 'fdm'
    }));

    const userContent = `Tag these 3D models:\n\n${JSON.stringify(manifest, null, 1)}`;

    try {
      const parsed = await callClaudeAPI(apiKey, {
        model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      }, { timeoutMs: 180000 }); // 3 min per batch

      const textBlocks = (parsed.content || []).filter(b => b.type === 'text');
      const fullText = textBlocks.map(b => b.text).join('\n');

      // Log token usage
      if (parsed.usage) {
        log('info', `${batchLabel} — API responded (${parsed.usage.input_tokens} in / ${parsed.usage.output_tokens} out tokens)`);
      }

      // Extract JSON array — may be wrapped in code fences
      const jsonMatch = fullText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log('error', `${batchLabel} — Claude didn't return a JSON array. Response preview: "${fullText.substring(0, 120)}…"`);
        totalErrors++;
        continue;
      }

      let result;
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        log('error', `${batchLabel} — couldn't parse JSON from Claude response: ${parseErr.message}`);
        totalErrors++;
        continue;
      }

      if (!Array.isArray(result)) {
        log('error', `${batchLabel} — expected array but got ${typeof result}`);
        totalErrors++;
        continue;
      }

      log('info', `${batchLabel} — received tags for ${result.length} model(s), applying…`);

      // Apply tags to DB
      const updateStmt = db.prepare(`UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?`);
      let batchTagged = 0;
      const applyBatch = db.transaction((tagResults) => {
        for (const item of tagResults) {
          if (!item.id || !Array.isArray(item.tags)) continue;
          const existing = batch.find(m => m.id === item.id);
          const existingTags = existing ? JSON.parse(existing.tags || '[]') : [];
          const merged = [...new Set([...existingTags, ...item.tags.map(t => t.toLowerCase())])].slice(0, 7);
          updateStmt.run(JSON.stringify(merged), item.id);
          batchTagged++;
        }
      });
      applyBatch(result);
      totalTagged += batchTagged;

      // Show some example tags from this batch
      const examples = result.slice(0, 3).map(r => {
        const m = batch.find(bm => bm.id === r.id);
        return `${m?.name || r.id}: [${r.tags.join(', ')}]`;
      });
      for (const ex of examples) {
        log('tag', `  ${ex}`);
      }
      if (result.length > 3) log('tag', `  … and ${result.length - 3} more`);

      log('success', `${batchLabel} — ✓ tagged ${batchTagged} models (${totalTagged} total so far)`);

    } catch (e) {
      log('error', `${batchLabel} — ✗ ${e.message}`);
      totalErrors++;

      // If it's an auth error, no point continuing
      if (e.message.includes('Invalid API key') || e.message.includes('lacks permission')) {
        log('error', 'Stopping — fix your API key and try again.');
        return finish({ success: false, error: e.message, tagged: totalTagged, total: models.length });
      }

      // If rate limited, wait and retry
      if (e.message.includes('Rate limited')) {
        log('warn', 'Waiting 30s before retrying…');
        await new Promise(r => setTimeout(r, 30000));
        b--; // retry this batch
        continue;
      }
    }
  }

  const msg = totalErrors > 0
    ? `Done with ${totalErrors} error(s) — tagged ${totalTagged} of ${models.length} models`
    : `✓ All done — tagged ${totalTagged} of ${models.length} models`;
  log(totalErrors > 0 ? 'warn' : 'success', msg);
  finish({ success: true, tagged: totalTagged, total: models.length, errors: totalErrors });
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
  const folderName = path.basename(model.folder_path);
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

app.get('/api/ai/find-images', async (req, res) => {
  const apiKey = req.headers['x-claude-key'] || req.query.key || process.env.CLAUDE_API_KEY || '';
  const trialMode = req.query.trial !== '0'; // trial mode ON by default
  const TRIAL_LIMIT = 10;

  if (!apiKey) { res.status(401).json({ error: 'API key required' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const log = (level, msg) => send({ level, msg, ts: new Date().toISOString() });
  const done = (data) => { send({ type: 'done', ...data }); res.end(); };

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
    const model = batch[i];
    const label = `[${i + 1}/${batch.length}] ${model.creator_name || '?'} / ${model.name}`;
    const confidence = model.score >= 40 ? '●' : model.score >= 20 ? '◐' : '○';

    // Step 1: Try to get a source URL
    let sourceUrl = model.source_url;

    // Try folder name detection first (free, no API call)
    if (!sourceUrl) {
      const folderName = path.basename(model.folder_path);
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
        }, { timeoutMs: 60000 });

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
          await new Promise(r => setTimeout(r, 30000));
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
      });

      if (savedPaths.length > 0) {
        const existingImages = JSON.parse(model.images || '[]');
        const allImages = [...new Set([...existingImages, ...savedPaths])];
        db.prepare(`UPDATE models SET images=?, thumbnail_path=?, source_url=?, updated_at=datetime('now') WHERE id=?`)
          .run(JSON.stringify(allImages), allImages[0], sourceUrl, model.id);
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
});

// ── STL File Serving ──────────────────────────────────────────────────────────

// Serve individual STL files for the 3D viewer (by model_file id)
app.get('/api/files/:fileId/stl', (req, res) => {
  const file = db.prepare('SELECT * FROM model_files WHERE id = ? AND filetype = ?').get(req.params.fileId, 'stl');
  if (!file) return res.status(404).json({ error: 'STL file not found' });
  if (!fs.existsSync(file.filepath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', 'model/stl');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(file.filepath).pipe(res);
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true, libraryPath: LIBRARY_PATH, ...APP_VERSION }));

// Only start the server if run directly (not when imported for testing)
if (require.main === module) {
  app.listen(PORT, () => console.log(`The Vault v${APP_VERSION.version} (build ${APP_VERSION.build}) running on port ${PORT}`));
}

module.exports = app;
