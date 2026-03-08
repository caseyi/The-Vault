const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { scanLibrary, LIBRARY_PATH } = require('./scanner');

const app = express();
const PORT = process.env.PORT || 3001;
const IMAGES_DIR = process.env.IMAGES_DIR || '/data/images';

app.use(cors());
app.use(express.json());
app.use('/images', express.static(IMAGES_DIR));

// ── Scan ──────────────────────────────────────────────────────────────────────

let scanInProgress = false;
let scanProgress = null;

app.post('/api/scan', async (req, res) => {
  if (scanInProgress) return res.status(409).json({ error: 'Scan already in progress' });
  const libPath = req.body.path || LIBRARY_PATH;
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: `Path not found: ${libPath}` });

  scanInProgress = true;
  scanProgress = { stage: 'starting', started: new Date().toISOString() };

  res.json({ message: 'Scan started', path: libPath });

  try {
    const result = await scanLibrary(libPath, (p) => { scanProgress = p; });
    scanProgress = { stage: 'complete', ...result };
  } catch (err) {
    scanProgress = { stage: 'error', error: err.message };
  } finally {
    scanInProgress = false;
  }
});

app.get('/api/scan/status', (req, res) => {
  res.json({ inProgress: scanInProgress, progress: scanProgress });
});

// ── Models ─────────────────────────────────────────────────────────────────────

app.get('/api/models', (req, res) => {
  const { search, creator, status, tags, page = 1, limit = 48 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = ['1=1'];
  const params = [];

  if (search) {
    where.push('(m.name LIKE ? OR c.name LIKE ? OR m.tags LIKE ? OR m.notes LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (creator) { where.push('c.name = ?'); params.push(creator); }
  if (status) { where.push('m.print_status = ?'); params.push(status); }
  if (tags) {
    const tagList = tags.split(',');
    tagList.forEach(t => { where.push("m.tags LIKE ?"); params.push(`%${t.trim()}%`); });
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

  const files = db.prepare('SELECT * FROM model_files WHERE model_id = ? ORDER BY filetype, filename').all(model.id);
  res.json({
    ...model,
    tags: JSON.parse(model.tags || '[]'),
    images: JSON.parse(model.images || '[]'),
    files
  });
});

app.patch('/api/models/:id', (req, res) => {
  const { print_status, tags, notes, source_url, name } = req.body;
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(req.params.id);
  if (!model) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const params = [];
  if (print_status !== undefined) { updates.push('print_status = ?'); params.push(print_status); }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (source_url !== undefined) { updates.push('source_url = ?'); params.push(source_url); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
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

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM models').get().n;
  const byStatus = db.prepare(`
    SELECT print_status, COUNT(*) as n FROM models GROUP BY print_status
  `).all();
  const creators = db.prepare('SELECT COUNT(*) as n FROM creators').get().n;
  const withImages = db.prepare("SELECT COUNT(*) as n FROM models WHERE thumbnail_path IS NOT NULL").get().n;
  const lastScan = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 1').get();
  res.json({ total, byStatus, creators, withImages, lastScan });
});

// ── Tags ──────────────────────────────────────────────────────────────────────

app.get('/api/tags', (req, res) => {
  const models = db.prepare('SELECT tags FROM models WHERE tags != \'[]\'').all();
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

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true, libraryPath: LIBRARY_PATH }));

app.listen(PORT, () => console.log(`The Vault API running on port ${PORT}`));
