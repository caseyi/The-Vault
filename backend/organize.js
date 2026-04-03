/**
 * organize.js — Library organisation routes for The Vault
 *
 * Routes mounted at /api/organize:
 *   GET  /snapshot            – text snapshot of library (filterable by creator)
 *   POST /auto-annotate       – SSE: send snapshot to Claude, stream directives
 *   POST /annotate/preview    – parse directives, return DB diff preview
 *   POST /annotate/apply      – apply previewed changes to DB
 *   GET  /health              – find duplicates, empties, missing thumbnails
 *   POST /apply-franchise     – move model folders into franchise/ subdirs, update DB
 *   POST /gap-analysis        – compare Gumroad CSV against library, find missing
 */

'use strict';

const express  = require('express');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const db       = require('./db');

const router = express.Router();

const LIBRARY_PATH  = process.env.LIBRARY_PATH || '/library';
const CLAUDE_MODEL  = process.env.CLAUDE_MODEL  || 'claude-haiku-4-5-20251001';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Simple Levenshtein distance for fuzzy matching */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalise a model name for fuzzy comparison */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Similarity ratio 0-1 (higher = more similar) */
function similarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - levenshtein(na, nb) / maxLen : 1;
}

/** Build an https request to the Claude API, return { body, status } */
function claudeRequest(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Build a streaming https request; calls onChunk(chunk) for each data chunk */
function claudeStream(apiKey, payload, onChunk) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...payload, stream: true });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      res.on('data', chunk => onChunk(chunk.toString()));
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── snapshot ──────────────────────────────────────────────────────────────────

/**
 * GET /api/organize/snapshot
 * Query params: creator (filter by creator name), format (txt|json)
 *
 * Returns a text/JSON snapshot of all models, suitable for pasting into Claude.
 */
router.get('/snapshot', (req, res) => {
  const { creator, pathFilter, format = 'txt' } = req.query;

  let query = `
    SELECT m.id, m.name, m.folder_path, m.file_count, m.has_stl, m.franchise, m.team,
           m.tags, m.thumbnail_path, m.source_url, m.notes,
           c.name AS creator_name
    FROM models m
    LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
  `;
  const params = [];

  if (creator) {
    query += ' AND c.name LIKE ?';
    params.push(`%${creator}%`);
  }
  if (pathFilter) {
    query += ' AND m.folder_path LIKE ?';
    params.push(`%${pathFilter}%`);
  }

  query += ' ORDER BY c.name, m.name';

  const models = db.prepare(query).all(...params);

  if (format === 'json') return res.json(models);

  // Build WickedSync-style text snapshot
  const lines = [`# The Vault — Library Snapshot`, `# Generated: ${new Date().toISOString()}`, `# Total models: ${models.length}`, ''];

  // Group by creator
  const byCreator = {};
  for (const m of models) {
    const key = m.creator_name || '(no creator)';
    if (!byCreator[key]) byCreator[key] = [];
    byCreator[key].push(m);
  }

  for (const [cname, cmodels] of Object.entries(byCreator)) {
    lines.push(`## ${cname} (${cmodels.length} models)`);
    for (const m of cmodels) {
      const tags = (() => { try { return JSON.parse(m.tags || '[]').join(', '); } catch { return ''; } })();
      const franchise = m.franchise ? ` [franchise: ${m.franchise}]` : ' [franchise: none]';
      const team = m.team ? ` [team: ${m.team}]` : '';
      const thumb = m.thumbnail_path ? ' ✓thumb' : ' ✗thumb';
      lines.push(`  - ${m.name}${franchise}${team}${thumb} | files:${m.file_count} | tags:${tags || 'none'}`);
    }
    lines.push('');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

// ── auto-annotate (SSE) ───────────────────────────────────────────────────────

/**
 * POST /api/organize/auto-annotate
 * Body: { creator?, snapshot? }  — snapshot overrides generated one
 * Headers: x-claude-key
 *
 * Streams FRANCHISE/RENAME/MERGE/TAG directives from Claude Haiku via SSE.
 */
router.post('/auto-annotate', async (req, res) => {
  const apiKey = req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) return res.status(401).json({ error: 'API key required' });

  // Build snapshot from DB if not provided
  let snapshot = req.body?.snapshot;
  if (!snapshot) {
    const { creator, pathFilter, modelIds } = req.body || {};
    let query = `
      SELECT m.id, m.name, m.folder_path, m.file_count, m.franchise, m.team, m.tags,
             c.name AS creator_name
      FROM models m
      LEFT JOIN creators c ON m.creator_id = c.id
      WHERE (m.hidden IS NULL OR m.hidden = 0)
    `;
    const params = [];
    if (creator) { query += ' AND c.name LIKE ?'; params.push(`%${creator}%`); }
    if (pathFilter) { query += ' AND m.folder_path LIKE ?'; params.push(`%${pathFilter}%`); }
    if (Array.isArray(modelIds) && modelIds.length) {
      query += ` AND m.id IN (${modelIds.map(() => '?').join(',')})`;
      params.push(...modelIds);
    }
    query += ' ORDER BY c.name, m.name';

    const models = db.prepare(query).all(...params);
    const byCreator = {};
    for (const m of models) {
      const key = m.creator_name || '(no creator)';
      if (!byCreator[key]) byCreator[key] = [];
      byCreator[key].push(m);
    }

    const lines = [`# Library Snapshot — ${models.length} models`, ''];
    for (const [cname, cmodels] of Object.entries(byCreator)) {
      lines.push(`## ${cname}`);
      for (const m of cmodels) {
        const tags = (() => { try { return JSON.parse(m.tags || '[]').join(', '); } catch { return ''; } })();
        const franchise = m.franchise ? ` [franchise: ${m.franchise}]` : ' [franchise: none]';
        const team = m.team ? ` [team: ${m.team}]` : '';
        lines.push(`  - ${m.name}${franchise}${team} | files:${m.file_count} | tags:${tags || 'none'}`);
      }
      lines.push('');
    }
    snapshot = lines.join('\n');
  }

  const systemPrompt = `You are a 3D print library organizer. You are given a snapshot of a library of 3D-printable model folders.
Each model entry shows its current franchise assignment and existing tags.

Your job is to output a list of organizational directives — one per line — using these formats:

FRANCHISE: <model name> -> <franchise name>
  (assign or correct a model's franchise/universe group, e.g. "Star Wars", "Warhammer 40K", "Marvel", "TMNT")

RENAME: <old name> -> <new name>
  (suggest a cleaner folder name — fix typos, standardise abbreviations)

MERGE: <model name> -> <target model name>
  (flag potential duplicates that could be merged)

TAG: <model name> -> <tag1>, <tag2>, ...
  (suggest ADDITIONAL tags to add — only suggest tags not already present)
  (useful tags: bust, full-figure, terrain, scenic, presupported, fdm, resin, character, vehicle, diorama, creature)

Rules:
- Only output directives, no explanation, no commentary
- Be conservative with RENAME — only rename if clearly wrong or truncated
- Be generous with FRANCHISE — most character/IP models belong to a recognisable franchise
- For TAG: only emit if you have useful tags to ADD beyond what's already there
- For FRANCHISE: if [franchise: none] and you can identify one, always emit a directive
- Skip models that already look well-organised (have a franchise and good tags)
- One directive per line
- Use the exact model name from the snapshot in your directives`;

  const userContent = `Here is my 3D print library snapshot. Generate organisational directives — focusing on franchise assignment for unassigned models and adding missing tags:\n\n${snapshot}`;

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    let buffer = '';

    await claudeStream(apiKey, {
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }, (chunk) => {
      // Parse SSE lines from Claude's streaming response
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text || '';
            buffer += text;

            // Emit complete lines as directives
            const parts = buffer.split('\n');
            buffer = parts.pop(); // keep incomplete last line
            for (const part of parts) {
              const directive = part.trim();
              if (directive) send({ type: 'directive', text: directive });
            }
          } else if (event.type === 'message_stop') {
            // Flush remaining buffer
            if (buffer.trim()) send({ type: 'directive', text: buffer.trim() });
            buffer = '';
          } else if (event.type === 'error') {
            send({ type: 'error', message: event.error?.message || 'Claude error' });
          }
        } catch {}
      }
    });

    // Flush any remaining
    if (buffer.trim()) send({ type: 'directive', text: buffer.trim() });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }

  res.end();
});

// ── annotate preview / apply ──────────────────────────────────────────────────

/**
 * POST /api/organize/annotate/preview
 * Body: { directives: string[] }
 *
 * Parses directives and returns a preview of what would change in the DB.
 * Does NOT write anything.
 */
router.post('/annotate/preview', (req, res) => {
  const { directives = [] } = req.body || {};
  if (!Array.isArray(directives)) return res.status(400).json({ error: 'directives must be an array' });

  const changes = [];

  for (const raw of directives) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // FRANCHISE: <name> -> <franchise>
    let m = line.match(/^FRANCHISE:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const modelName = m[1].trim(), franchise = m[2].trim();
      const model = db.prepare(`SELECT id, name, franchise FROM models WHERE name = ? OR name LIKE ? LIMIT 1`)
        .get(modelName, `%${modelName}%`);
      changes.push({ type: 'FRANCHISE', directive: line, modelName, franchise, modelId: model?.id, current: model?.franchise || null, found: !!model });
      continue;
    }

    // RENAME: <old> -> <new>
    m = line.match(/^RENAME:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const oldName = m[1].trim(), newName = m[2].trim();
      const model = db.prepare(`SELECT id, name FROM models WHERE name = ? OR name LIKE ? LIMIT 1`)
        .get(oldName, `%${oldName}%`);
      changes.push({ type: 'RENAME', directive: line, oldName, newName, modelId: model?.id, current: model?.name || null, found: !!model });
      continue;
    }

    // MERGE: <name> -> <target>
    m = line.match(/^MERGE:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const srcName = m[1].trim(), targetName = m[2].trim();
      const src = db.prepare(`SELECT id, name FROM models WHERE name = ? OR name LIKE ? LIMIT 1`).get(srcName, `%${srcName}%`);
      const target = db.prepare(`SELECT id, name FROM models WHERE name = ? OR name LIKE ? LIMIT 1`).get(targetName, `%${targetName}%`);
      changes.push({ type: 'MERGE', directive: line, srcName, targetName, srcId: src?.id, targetId: target?.id, found: !!(src && target) });
      continue;
    }

    // TAG: <name> -> <tag1>, <tag2>
    m = line.match(/^TAG:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const modelName = m[1].trim(), tagsRaw = m[2].trim();
      const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
      const model = db.prepare(`SELECT id, name, tags FROM models WHERE name = ? OR name LIKE ? LIMIT 1`)
        .get(modelName, `%${modelName}%`);
      const currentTags = (() => { try { return JSON.parse(model?.tags || '[]'); } catch { return []; } })();
      changes.push({ type: 'TAG', directive: line, modelName, tags, modelId: model?.id, current: currentTags, found: !!model });
      continue;
    }
  }

  const stats = {
    total: changes.length,
    found: changes.filter(c => c.found).length,
    notFound: changes.filter(c => !c.found).length,
    byType: { FRANCHISE: 0, RENAME: 0, MERGE: 0, TAG: 0 },
  };
  for (const c of changes) if (stats.byType[c.type] !== undefined) stats.byType[c.type]++;

  res.json({ changes, stats });
});

/**
 * POST /api/organize/annotate/apply
 * Body: { directives: string[], types?: string[] }   (types filters which directive types to apply)
 *
 * Applies the directives to the DB. RENAME only updates the `name` column.
 * MERGE is advisory only (flagged, not applied). Returns a summary.
 */
router.post('/annotate/apply', (req, res) => {
  const { directives = [], types = ['FRANCHISE', 'RENAME', 'TAG'] } = req.body || {};
  if (!Array.isArray(directives)) return res.status(400).json({ error: 'directives must be an array' });

  const results = { applied: 0, skipped: 0, errors: [], details: [] };

  const applyInTx = db.transaction(() => {
    for (const raw of directives) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      // FRANCHISE
      let m = line.match(/^FRANCHISE:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
      if (m && types.includes('FRANCHISE')) {
        const modelName = m[1].trim(), franchise = m[2].trim();
        const model = db.prepare(`SELECT id FROM models WHERE name = ? OR name LIKE ? LIMIT 1`).get(modelName, `%${modelName}%`);
        if (model) {
          db.prepare(`UPDATE models SET franchise = ?, updated_at = datetime('now') WHERE id = ?`).run(franchise, model.id);
          results.applied++;
          results.details.push({ type: 'FRANCHISE', name: modelName, value: franchise });
        } else { results.skipped++; }
        continue;
      }

      // RENAME
      m = line.match(/^RENAME:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
      if (m && types.includes('RENAME')) {
        const oldName = m[1].trim(), newName = m[2].trim();
        const model = db.prepare(`SELECT id FROM models WHERE name = ? OR name LIKE ? LIMIT 1`).get(oldName, `%${oldName}%`);
        if (model) {
          db.prepare(`UPDATE models SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(newName, model.id);
          results.applied++;
          results.details.push({ type: 'RENAME', old: oldName, new: newName });
        } else { results.skipped++; }
        continue;
      }

      // TAG
      m = line.match(/^TAG:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
      if (m && types.includes('TAG')) {
        const modelName = m[1].trim(), tagsRaw = m[2].trim();
        const newTags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
        const model = db.prepare(`SELECT id, tags FROM models WHERE name = ? OR name LIKE ? LIMIT 1`).get(modelName, `%${modelName}%`);
        if (model) {
          const existing = (() => { try { return JSON.parse(model.tags || '[]'); } catch { return []; } })();
          const merged = [...new Set([...existing, ...newTags])];
          db.prepare(`UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(merged), model.id);
          results.applied++;
          results.details.push({ type: 'TAG', name: modelName, tags: merged });
        } else { results.skipped++; }
        continue;
      }

      // MERGE — advisory only
      m = line.match(/^MERGE:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
      if (m) {
        results.skipped++;
        results.details.push({ type: 'MERGE', advisory: true, text: line });
        continue;
      }

      results.skipped++;
    }
  });

  try {
    applyInTx();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── health scan ───────────────────────────────────────────────────────────────

/**
 * GET /api/organize/health
 *
 * Returns:
 *   duplicates     – models with very similar names (similarity ≥ 0.85)
 *   emptyFolders   – models with file_count = 0
 *   noThumbnail    – models missing thumbnail_path
 *   noSource       – models missing source_url
 *   noTags         – models with empty tags array
 *   noFranchise    – models with no franchise assigned
 */
router.get('/health', (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.folder_path, m.file_count, m.thumbnail_path,
           m.source_url, m.tags, m.franchise, c.name AS creator_name
    FROM models m
    LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY m.name
  `).all();

  // Duplicates: O(n²) is fine for typical library sizes
  const duplicates = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const score = similarity(models[i].name, models[j].name);
      if (score >= 0.85) {
        duplicates.push({ score: Math.round(score * 100) / 100, a: models[i], b: models[j] });
      }
    }
  }

  const emptyFolders  = models.filter(m => !m.file_count || m.file_count === 0);
  const noThumbnail   = models.filter(m => !m.thumbnail_path);
  const noSource      = models.filter(m => !m.source_url);
  const noTags        = models.filter(m => { try { return !JSON.parse(m.tags || '[]').length; } catch { return true; } });
  const noFranchise   = models.filter(m => !m.franchise);

  res.json({
    summary: {
      total: models.length,
      duplicatePairs: duplicates.length,
      emptyFolders: emptyFolders.length,
      noThumbnail: noThumbnail.length,
      noSource: noSource.length,
      noTags: noTags.length,
      noFranchise: noFranchise.length,
    },
    duplicates,
    emptyFolders,
    noThumbnail,
    noSource,
    noTags,
    noFranchise,
  });
});

// ── apply-franchise ───────────────────────────────────────────────────────────

/**
 * POST /api/organize/apply-franchise
 * Body: { dryRun?: boolean }  (default dryRun=true for safety)
 *
 * For every model that has a `franchise` value, moves the model folder into
 * `<parent>/<franchise>/<model-name>` and updates folder_path in the DB.
 *
 * Only moves folders that are direct children of a creator root (i.e., not
 * already inside a franchise subfolder).
 */
router.post('/apply-franchise', (req, res) => {
  const dryRun = req.body?.dryRun !== false; // safe default: dry run

  const models = db.prepare(`
    SELECT id, name, folder_path, franchise
    FROM models
    WHERE franchise IS NOT NULL AND franchise != ''
      AND (hidden IS NULL OR hidden = 0)
  `).all();

  const moves = [];
  const errors = [];

  for (const m of models) {
    try {
      const parent  = path.dirname(m.folder_path);
      const base    = path.basename(m.folder_path);

      // Skip if already inside a franchise folder (parent basename === franchise)
      if (path.basename(parent) === m.franchise) continue;

      const newParent = path.join(parent, m.franchise);
      const newPath   = path.join(newParent, base);

      moves.push({ id: m.id, name: m.name, franchise: m.franchise, from: m.folder_path, to: newPath });

      if (!dryRun) {
        if (!fs.existsSync(newParent)) fs.mkdirSync(newParent, { recursive: true });
        fs.renameSync(m.folder_path, newPath);
        db.prepare(`UPDATE models SET folder_path = ?, updated_at = datetime('now') WHERE id = ?`).run(newPath, m.id);
      }
    } catch (e) {
      errors.push({ id: m.id, name: m.name, error: e.message });
    }
  }

  res.json({ dryRun, moves, errors, summary: { planned: moves.length, errors: errors.length } });
});

// ── gap analysis ──────────────────────────────────────────────────────────────

/**
 * POST /api/organize/gap-analysis
 * Body: { csv: string, threshold?: number }
 *
 * Accepts a Gumroad CSV (text/string — the full file contents) or a plain list
 * of model names (one per line, or comma-separated values with a "Model Name"
 * column header).
 *
 * Fuzzy-matches each name against models.name in the DB.
 * Returns: { missing[], present[], stats }
 */
router.post('/gap-analysis', (req, res) => {
  const { csv = '', threshold = 0.75 } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv body required' });

  // Parse names from CSV
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  let names = [];

  if (lines[0] && lines[0].toLowerCase().includes(',')) {
    // Proper CSV — find "Model Name" or "Name" column
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
    const nameIdx = headers.indexOf('model name') !== -1 ? headers.indexOf('model name')
      : headers.indexOf('name') !== -1 ? headers.indexOf('name') : 0;
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      const val = (cols[nameIdx] || '').replace(/"/g, '').trim();
      if (val) names.push(val);
    }
  } else {
    // Plain list
    names = lines;
  }

  const dbModels = db.prepare(`SELECT id, name FROM models WHERE (hidden IS NULL OR hidden = 0)`).all();

  const results = { missing: [], present: [], stats: { checked: names.length, missing: 0, present: 0 } };

  for (const name of names) {
    let bestScore = 0, bestMatch = null;
    for (const m of dbModels) {
      const score = similarity(name, m.name);
      if (score > bestScore) { bestScore = score; bestMatch = m; }
    }
    if (bestScore >= threshold) {
      results.present.push({ searched: name, matched: bestMatch?.name, score: Math.round(bestScore * 100) / 100, id: bestMatch?.id });
      results.stats.present++;
    } else {
      results.missing.push({ searched: name, closestMatch: bestMatch?.name, score: Math.round(bestScore * 100) / 100 });
      results.stats.missing++;
    }
  }

  results.missing.sort((a, b) => a.searched.localeCompare(b.searched));
  results.present.sort((a, b) => a.searched.localeCompare(b.searched));

  res.json(results);
});

// ── list franchises ───────────────────────────────────────────────────────────

/**
 * GET /api/organize/franchises
 * Returns all distinct franchise values with model counts.
 */
router.get('/franchises', (req, res) => {
  const rows = db.prepare(`
    SELECT franchise, COUNT(*) as count
    FROM models
    WHERE franchise IS NOT NULL AND franchise != ''
      AND (hidden IS NULL OR hidden = 0)
    GROUP BY franchise
    ORDER BY count DESC, franchise
  `).all();
  res.json(rows);
});

// ── franchise browser ─────────────────────────────────────────────────────────

/**
 * GET /api/organize/franchise-browser
 * Returns { total, unassigned: model[], franchises: [{name,count,models}] }
 */
router.get('/franchise-browser', (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.franchise, m.tags, m.thumbnail_path,
           c.name AS creator_name, c.id AS creator_id
    FROM models m
    LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY m.franchise, c.name, m.name
  `).all();

  const unassigned = models.filter(m => !m.franchise);
  const byFranchise = {};
  for (const m of models) {
    if (!m.franchise) continue;
    if (!byFranchise[m.franchise]) byFranchise[m.franchise] = [];
    byFranchise[m.franchise].push(m);
  }
  const franchises = Object.entries(byFranchise)
    .map(([name, mods]) => ({ name, count: mods.length, models: mods }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  res.json({ total: models.length, unassigned, franchises });
});

// ── bulk update ───────────────────────────────────────────────────────────────

/**
 * POST /api/organize/bulk-update
 * Body: { modelIds?, creatorId?, franchise?, tags?, tagsMode? }
 * Applies franchise and/or tags to all targeted models. Tags are merged by default.
 */
router.post('/bulk-update', (req, res) => {
  const { modelIds, creatorId, franchise, tags, tagsMode = 'merge' } = req.body || {};

  let targetIds = Array.isArray(modelIds) ? modelIds : [];
  if (!targetIds.length && creatorId) {
    targetIds = db.prepare('SELECT id FROM models WHERE creator_id = ?').all(creatorId).map(r => r.id);
  }
  if (!targetIds.length) return res.status(400).json({ error: 'No models targeted' });

  let updated = 0;
  db.transaction(() => {
    for (const id of targetIds) {
      const model = db.prepare('SELECT id, tags FROM models WHERE id = ?').get(id);
      if (!model) continue;
      const updates = [];
      const params = [];
      if (franchise !== undefined) {
        updates.push('franchise = ?');
        params.push(franchise || null);
      }
      if (tags && tags.length) {
        let existing = [];
        if (tagsMode === 'merge') { try { existing = JSON.parse(model.tags || '[]'); } catch {} }
        const merged = [...new Set([...existing, ...tags])];
        updates.push('tags = ?');
        params.push(JSON.stringify(merged));
      }
      if (updates.length) {
        updates.push("updated_at = datetime('now')");
        params.push(id);
        db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        updated++;
      }
    }
  })();
  res.json({ updated, total: targetIds.length });
});

// ── thumbnail stats / fix ─────────────────────────────────────────────────────

/**
 * GET /api/organize/thumbnail-stats
 */
router.get('/thumbnail-stats', (req, res) => {
  const total   = db.prepare(`SELECT COUNT(*) as n FROM models WHERE hidden IS NULL OR hidden = 0`).get().n;
  const noThumb = db.prepare(`SELECT COUNT(*) as n FROM models WHERE (hidden IS NULL OR hidden = 0) AND (thumbnail_path IS NULL OR thumbnail_path = '')`).get().n;
  const fixable = db.prepare(`
    SELECT COUNT(*) as n FROM models
    WHERE (hidden IS NULL OR hidden = 0)
      AND (thumbnail_path IS NULL OR thumbnail_path = '')
      AND images IS NOT NULL AND images != '[]' AND images != ''
  `).get().n;
  res.json({ total, noThumb, fixable });
});

/**
 * POST /api/organize/fix-thumbnails
 * For every model that has images[] in DB but no thumbnail, set the first image.
 */
router.post('/fix-thumbnails', (req, res) => {
  const models = db.prepare(`
    SELECT id, images FROM models
    WHERE (hidden IS NULL OR hidden = 0)
      AND (thumbnail_path IS NULL OR thumbnail_path = '')
      AND images IS NOT NULL AND images != '[]' AND images != ''
  `).all();

  let fixed = 0;
  db.transaction(() => {
    for (const m of models) {
      try {
        const imgs = JSON.parse(m.images);
        if (imgs && imgs.length) {
          db.prepare(`UPDATE models SET thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?`).run(imgs[0], m.id);
          fixed++;
        }
      } catch {}
    }
  })();
  res.json({ fixed, total: models.length });
});

module.exports = router;
