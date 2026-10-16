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
const fs       = require('fs');
const path     = require('path');
const db       = require('./db');
const { pickRenderArchives, analyzeFolder, extractImagesFromArchive } = require('./scanner');
const { callClaudeAPI, claudeStream } = require('./lib/claude');
const { confinePath, tryConfine, sendPathError, isSafeSegment } = require('./lib/paths');
const { openSSE } = require('./lib/sse');
const { acquireOr409 } = require('./lib/jobs');
const { shellQuote, toHostPath } = require('./lib/shell');
const { findSimilarNames, isVariantOnlyName } = require('./lib/similar');
const { wrapAsyncRoutes } = require('./lib/middleware');

const router = wrapAsyncRoutes(express.Router());

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

/**
 * Deep-normalise a model name for cross-creator duplicate detection.
 * Strips noise (timestamps, scale prefixes, common modifiers) but keeps
 * meaningful variant words (bust, statue, diorama) so "Spider-Man Bust"
 * and "Spider-Man Statue" are NOT collapsed together.
 */
function deepNorm(s) {
  let n = String(s || '').toLowerCase();
  // Google Drive batch-download timestamps: -20250109T000437Z-003
  n = n.replace(/-\d{8}t\d{6}z(-\d+)?/gi, '');
  // Scale prefixes: "1_12 scale", "1:12", "1/12 scale"
  n = n.replace(/\b\d+[\:_\/x]\d+\s*scale\b/gi, '');
  // Common noise-only modifiers (not bust/statue/diorama — those are meaningful)
  n = n.replace(/\b(nsfw|presupported|pre[-\s]?support(?:s|ed)?|unsupported|fdm|remix|fan[-\s]?art|fanart|painted|uncut)\b/gi, '');
  // Creator slug suffixes: CA3D, MMF, TGA, etc.
  n = n.replace(/\b([A-Z]{2,4}\d*)\b/g, '');
  // Collapse non-alphanumeric to single space
  n = n.replace(/[^a-z0-9]+/g, ' ').trim();
  return n;
}

/** Similarity ratio 0-1 (higher = more similar) */
function similarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return maxLen ? 1 - levenshtein(na, nb) / maxLen : 1;
}

/** Escape LIKE wildcards (use with ESCAPE '\\'). */
const likeEscape = (v) => String(v).replace(/[\\%_]/g, '\\$&');

/** Confine a request path or answer 400/403. Returns the path, or null if a response was sent. */
function confinedOr4xx(res, p) {
  try { return confinePath(p); } catch (e) { if (sendPathError(res, e)) return null; throw e; }
}

/**
 * Find ONE model by name for an AI directive: exact (case-insensitive) match
 * first; otherwise a LIKE match only when it is unambiguous. Never guesses.
 */
function findModelByName(name, cols = 'id, name') {
  const n = String(name || '').trim();
  if (!n) return null;
  const exact = db.prepare(`SELECT ${cols} FROM models WHERE name = ? COLLATE NOCASE AND (hidden IS NULL OR hidden = 0) LIMIT 2`).all(n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // ambiguous
  const fuzzy = db.prepare(`SELECT ${cols} FROM models WHERE name LIKE ? ESCAPE '\\' AND (hidden IS NULL OR hidden = 0) LIMIT 2`).all(`%${likeEscape(n)}%`);
  return fuzzy.length === 1 ? fuzzy[0] : null;
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
    query += " AND c.name LIKE ? ESCAPE '\\'";
    params.push(`%${likeEscape(creator)}%`);
  }
  if (pathFilter) {
    query += " AND m.folder_path LIKE ? ESCAPE '\\'";
    params.push(`%${likeEscape(pathFilter)}%`);
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
    if (creator) { query += " AND c.name LIKE ? ESCAPE '\\'"; params.push(`%${likeEscape(creator)}%`); }
    if (pathFilter) { query += " AND m.folder_path LIKE ? ESCAPE '\\'"; params.push(`%${likeEscape(pathFilter)}%`); }
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

  // One AI batch job at a time; stop (and stop paying) when the client leaves
  const release = acquireOr409(res, 'auto-annotate');
  if (!release) return;
  const sse = openSSE(req, res);
  sse.onAbort(release);
  const send = (data) => sse.send(data);

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
    }, { signal: sse.signal });

    // Flush any remaining
    if (buffer.trim()) send({ type: 'directive', text: buffer.trim() });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', message: e.message });
  } finally {
    release();
  }

  sse.end();
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
      const model = findModelByName(modelName, 'id, name, franchise');
      changes.push({ type: 'FRANCHISE', directive: line, modelName, franchise, id: model?.id, modelId: model?.id, matchedName: model?.name || null, current: model?.franchise || null, found: !!model });
      continue;
    }

    // RENAME: <old> -> <new>
    m = line.match(/^RENAME:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const oldName = m[1].trim(), newName = m[2].trim();
      const model = findModelByName(oldName);
      changes.push({ type: 'RENAME', directive: line, oldName, newName, id: model?.id, modelId: model?.id, matchedName: model?.name || null, current: model?.name || null, found: !!model });
      continue;
    }

    // MERGE: <name> -> <target>
    m = line.match(/^MERGE:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const srcName = m[1].trim(), targetName = m[2].trim();
      const src = findModelByName(srcName);
      const target = findModelByName(targetName);
      changes.push({ type: 'MERGE', directive: line, srcName, targetName, id: src?.id, srcId: src?.id, targetId: target?.id, found: !!(src && target) });
      continue;
    }

    // TAG: <name> -> <tag1>, <tag2>
    m = line.match(/^TAG:\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
    if (m) {
      const modelName = m[1].trim(), tagsRaw = m[2].trim();
      const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
      const model = findModelByName(modelName, 'id, name, tags');
      const currentTags = (() => { try { return JSON.parse(model?.tags || '[]'); } catch { return []; } })();
      changes.push({ type: 'TAG', directive: line, modelName, tags, id: model?.id, modelId: model?.id, matchedName: model?.name || null, current: currentTags, found: !!model });
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
 * Body: { changes?: previewChange[], directives?: string[], types?: string[] }
 *
 * Preferred: pass `changes` straight from /annotate/preview — each item is
 * applied to the model ID the preview resolved (id / modelId), so what you
 * reviewed is exactly what gets written. Legacy: `directives` are re-parsed and
 * matched by name (exact, or an unambiguous partial match — never a guess).
 * RENAME only updates the `name` column (and locks it against rescans).
 * MERGE is advisory only (flagged, not applied). Returns a summary.
 */
router.post('/annotate/apply', (req, res) => {
  const { directives = [], changes, types = ['FRANCHISE', 'RENAME', 'TAG'] } = req.body || {};
  if (changes !== undefined && !Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
  if (!Array.isArray(directives)) return res.status(400).json({ error: 'directives must be an array' });
  if (!Array.isArray(types)) return res.status(400).json({ error: 'types must be an array' });

  const results = { applied: 0, skipped: 0, errors: [], details: [] };
  const getById = db.prepare('SELECT id, name, tags FROM models WHERE id = ?');
  const setFranchise = db.prepare(`UPDATE models SET franchise = ?, updated_at = datetime('now') WHERE id = ?`);
  const setName = db.prepare(`UPDATE models SET name = ?, name_locked = 1, updated_at = datetime('now') WHERE id = ?`);
  const setTags = db.prepare(`UPDATE models SET tags = ?, updated_at = datetime('now') WHERE id = ?`);

  // Normalise both input styles to { type, model, value }
  const ops = [];
  if (Array.isArray(changes)) {
    for (const c of changes) {
      const type = String(c?.type || '').toUpperCase();
      const id = c?.id ?? c?.modelId ?? c?.srcId;
      if (type === 'MERGE') { ops.push({ type, advisory: true, text: c.directive || '' }); continue; }
      const model = id != null ? getById.get(id) : null;
      if (type === 'FRANCHISE') ops.push({ type, model, label: c.modelName, value: String(c.franchise || '').trim() });
      else if (type === 'RENAME') ops.push({ type, model, label: c.oldName, value: String(c.newName || '').trim() });
      else if (type === 'TAG') ops.push({ type, model, label: c.modelName, value: (Array.isArray(c.tags) ? c.tags : []).map(t => String(t).trim()).filter(Boolean) });
      else ops.push({ type: 'OTHER' });
    }
  } else {
    for (const raw of directives) {
      const line = String(raw || '').trim();
      if (!line || line.startsWith('#')) continue;
      let m = line.match(/^(FRANCHISE|RENAME|TAG|MERGE):\s*(.+?)\s*(?:→|->|>)\s*(.+)$/i);
      if (!m) { ops.push({ type: 'OTHER' }); continue; }
      const type = m[1].toUpperCase(), left = m[2].trim(), right = m[3].trim();
      if (type === 'MERGE') { ops.push({ type, advisory: true, text: line }); continue; }
      const found = findModelByName(left);
      const model = found ? getById.get(found.id) : null;
      if (type === 'TAG') ops.push({ type, model, label: left, value: right.split(',').map(t => t.trim()).filter(Boolean) });
      else ops.push({ type, model, label: left, value: right });
    }
  }

  const applyInTx = db.transaction(() => {
    for (const op of ops) {
      if (op.type === 'MERGE') {
        results.skipped++;
        results.details.push({ type: 'MERGE', advisory: true, text: op.text });
        continue;
      }
      if (op.type === 'OTHER' || !types.includes(op.type) || !op.model) { results.skipped++; continue; }
      const { model } = op;
      if (op.type === 'FRANCHISE') {
        if (!op.value) { results.skipped++; continue; }
        setFranchise.run(op.value, model.id);
        results.details.push({ type: 'FRANCHISE', id: model.id, name: model.name, value: op.value });
      } else if (op.type === 'RENAME') {
        if (!op.value) { results.skipped++; continue; }
        setName.run(op.value, model.id);
        results.details.push({ type: 'RENAME', id: model.id, old: model.name, new: op.value });
      } else if (op.type === 'TAG') {
        const existing = (() => { try { return JSON.parse(model.tags || '[]'); } catch { return []; } })();
        const merged = [...new Set([...existing, ...op.value])];
        setTags.run(JSON.stringify(merged), model.id);
        results.details.push({ type: 'TAG', id: model.id, name: model.name, tags: merged });
      }
      results.applied++;
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
router.get('/health', async (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.folder_path, m.file_count, m.thumbnail_path,
           m.source_url, m.tags, m.franchise, m.creator_id, c.name AS creator_name
    FROM models m
    LEFT JOIN creators c ON m.creator_id = c.id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
    ORDER BY m.name
  `).all();

  // Similar-name duplicates — normalised, bucketed, capped and yielding (see lib/similar.js)
  const duplicates = await findSimilarNames(models);

  const emptyFolders  = models.filter(m => !m.file_count || m.file_count === 0);
  const noThumbnail   = models.filter(m => !m.thumbnail_path);
  const noSource      = models.filter(m => !m.source_url);
  const noTags        = models.filter(m => { try { return !JSON.parse(m.tags || '[]').length; } catch { return true; } });
  const noFranchise   = models.filter(m => !m.franchise);

  // Cross-creator duplicates: same deep-normalized name, different creators
  const byDeepKey = new Map();
  for (const m of models) {
    // Names that are only variant/role words ("Supported", "FDM", "Renders")
    // say nothing about WHICH model it is — never group those across creators.
    if (isVariantOnlyName(m.name)) continue;
    const key = deepNorm(m.name);
    if (!key || key.length < 4 || isVariantOnlyName(key)) continue; // skip too-short keys
    if (!byDeepKey.has(key)) byDeepKey.set(key, []);
    byDeepKey.get(key).push(m);
  }
  const crossCreatorDupes = [];
  for (const [key, group] of byDeepKey) {
    const creatorIds = new Set(group.map(m => m.creator_id).filter(Boolean));
    if (creatorIds.size > 1) {
      crossCreatorDupes.push({ key, models: group });
    }
  }
  crossCreatorDupes.sort((a, b) => b.models.length - a.models.length);

  res.json({
    summary: {
      total: models.length,
      duplicatePairs: duplicates.length,
      emptyFolders: emptyFolders.length,
      noThumbnail: noThumbnail.length,
      noSource: noSource.length,
      noTags: noTags.length,
      noFranchise: noFranchise.length,
      crossCreatorDupes: crossCreatorDupes.length,
    },
    duplicates,
    crossCreatorDupes,
    emptyFolders,
    noThumbnail,
    noSource,
    noTags,
    noFranchise,
  });
});

// ── apply-franchise ───────────────────────────────────────────────────────────

/** Turn a franchise label into ONE safe folder name (no separators, no dots-only, no control chars). */
function franchiseFolderName(franchise) {
  const clean = String(franchise || '')
    .replace(/[\/\\\x00-\x1f\x7f]+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return isSafeSegment(clean) ? clean : null;
}

function isReadOnlyError(e) {
  return e && (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM');
}

/**
 * POST /api/organize/apply-franchise
 * Body: { dryRun?: boolean }  (default dryRun=true for safety)
 *
 * For every model that has a `franchise` value, moves the model folder into
 * `<parent>/<franchise>/<model-folder>` and updates models.folder_path and
 * model_files.filepath (for it and any nested models) in one transaction.
 *
 * Refuses to overwrite an existing destination, confines every path to the
 * library, and stops with a clear error when the library is read-only (the
 * default Docker mount is :ro).
 */
router.post('/apply-franchise', (req, res) => {
  const dryRun = req.body?.dryRun !== false; // safe default: dry run

  const models = db.prepare(`
    SELECT id, name, folder_path, franchise
    FROM models
    WHERE franchise IS NOT NULL AND franchise != ''
      AND (hidden IS NULL OR hidden = 0)
    ORDER BY length(folder_path) DESC
  `).all();

  if (!dryRun) {
    try {
      fs.accessSync(LIBRARY_PATH, fs.constants.W_OK);
    } catch (e) {
      return res.status(409).json({
        error: `The library is read-only (${e.code || e.message}). Folder moves need a writable library mount — remove ":ro" from the library volume in docker-compose.yml, or use the dry run and move folders yourself.`,
        code: e.code || 'EROFS', readOnly: true,
      });
    }
  }

  const getPath = db.prepare('SELECT folder_path FROM models WHERE id = ?');
  const [sepLo, sepHi] = [path.sep, String.fromCharCode(path.sep.charCodeAt(0) + 1)];
  const rehomeModels = db.prepare(`
    UPDATE models SET folder_path = ? || substr(folder_path, ?), updated_at = datetime('now')
    WHERE folder_path = ? OR (folder_path > ? AND folder_path < ?)
  `);
  const rehomeFiles = db.prepare(`
    UPDATE model_files SET filepath = ? || substr(filepath, ?)
    WHERE filepath > ? AND filepath < ?
  `);
  const moveInDb = db.transaction((from, to) => {
    const cut = from.length + 1; // substr is 1-based: keep everything after `from`
    rehomeModels.run(to, cut, from, from + sepLo, from + sepHi);
    rehomeFiles.run(to, cut, from + sepLo, from + sepHi);
  });

  const moves = [];
  const errors = [];
  let executed = 0;
  let stoppedReadOnly = null;

  for (const m of models) {
    const current = getPath.get(m.id)?.folder_path || m.folder_path; // may have moved with a parent
    const folder = franchiseFolderName(m.franchise);
    if (!folder) { errors.push({ id: m.id, name: m.name, error: `Franchise "${m.franchise}" is not a usable folder name` }); continue; }

    const parent = path.dirname(current);
    const base = path.basename(current);
    // Skip if the model already sits inside a folder with that name anywhere
    // below the library root (e.g. franchise "Marvel" derived from
    // creator/Marvel/Avengers/X must not become .../Avengers/Marvel/X).
    const ancestors = path.relative(LIBRARY_PATH, parent).split(path.sep).map(p => p.toLowerCase());
    if (ancestors.includes(folder.toLowerCase())) continue;

    const newParent = path.join(parent, folder);
    const newPath = path.join(newParent, base);
    if (!tryConfine(current) || !tryConfine(newPath)) {
      errors.push({ id: m.id, name: m.name, error: 'Path is outside the library' });
      continue;
    }
    const move = { id: m.id, name: m.name, franchise: m.franchise, folder, from: current, to: newPath };

    if (fs.existsSync(newPath)) {
      errors.push({ id: m.id, name: m.name, error: `Destination already exists: ${newPath}` });
      continue;
    }
    moves.push(move);
    if (dryRun) continue;

    if (!fs.existsSync(current)) { errors.push({ id: m.id, name: m.name, error: 'Source folder no longer exists' }); continue; }
    try {
      fs.mkdirSync(newParent, { recursive: true });
      fs.renameSync(current, newPath);
    } catch (e) {
      errors.push({ id: m.id, name: m.name, error: e.message, code: e.code });
      if (isReadOnlyError(e)) { stoppedReadOnly = e; break; }
      continue;
    }
    try {
      moveInDb(current, newPath);
      executed++;
    } catch (e) {
      // Keep disk and DB consistent: undo the move if the DB update failed
      try { fs.renameSync(newPath, current); } catch {}
      errors.push({ id: m.id, name: m.name, error: `Database update failed, move undone: ${e.message}` });
    }
  }

  const body = { dryRun, moves, errors, summary: { planned: moves.length, executed, errors: errors.length } };
  if (stoppedReadOnly) {
    body.error = `Stopped: the library is not writable (${stoppedReadOnly.code}). ${executed} folder(s) were moved before this.`;
    body.readOnly = true;
    return res.status(409).json(body);
  }
  res.json(body);
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
router.post('/fix-thumbnails', async (req, res) => {
  // Pass 1: models that already have images[] in DB but no thumbnail_path
  const withImages = db.prepare(`
    SELECT id, images FROM models
    WHERE (hidden IS NULL OR hidden = 0)
      AND (thumbnail_path IS NULL OR thumbnail_path = '')
      AND images IS NOT NULL AND images != '[]' AND images != ''
  `).all();

  let fixed = 0;
  db.transaction(() => {
    for (const m of withImages) {
      try {
        const imgs = JSON.parse(m.images);
        if (imgs && imgs.length) {
          db.prepare(`UPDATE models SET thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?`).run(imgs[0], m.id);
          fixed++;
        }
      } catch {}
    }
  })();

  // Pass 2: models with no images at all — try to extract from render archives
  const noImages = db.prepare(`
    SELECT m.id, m.uuid, m.folder_path, m.render_zip_hint,
           c.render_zip_hint AS creator_hint
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
      AND (m.thumbnail_path IS NULL OR m.thumbnail_path = '')
      AND (m.images IS NULL OR m.images = '[]' OR m.images = '')
      AND m.folder_path IS NOT NULL
  `).all();

  let extracted = 0;
  for (const m of noImages) {
    try {
      if (!tryConfine(m.folder_path) || !fs.existsSync(m.folder_path)) continue;
      const hint = m.render_zip_hint || m.creator_hint || null;
      const analysis = analyzeFolder(m.folder_path, null);
      const archives = pickRenderArchives(analysis, hint);
      const imgs = [];
      for (const archPath of archives) {
        imgs.push(...await extractImagesFromArchive(archPath, m.uuid));
        if (imgs.length) break;
      }
      if (imgs.length) {
        db.prepare(`UPDATE models SET images = ?, thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(JSON.stringify(imgs), imgs[0], m.id);
        extracted++;
      }
    } catch {}
  }

  res.json({ fixed, extracted, total: withImages.length + noImages.length });
});

/**
 * GET /api/organize/integrity
 * Checks which model folder paths no longer exist on disk.
 * Fast (filesystem stat only, no ZIP parsing).
 */
router.get('/integrity', (req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.name, m.folder_path, m.file_count,
           c.name AS creator_name
    FROM models m LEFT JOIN creators c ON c.id = m.creator_id
    WHERE (m.hidden IS NULL OR m.hidden = 0)
  `).all();

  const missingFolders = [];
  const missingFiles = [];
  const checked = { folders: 0, ok: 0 };

  for (const m of models) {
    checked.folders++;
    if (!m.folder_path || !fs.existsSync(m.folder_path)) {
      missingFolders.push({ id: m.id, name: m.name, creator_name: m.creator_name, folder_path: m.folder_path });
    } else {
      checked.ok++;
    }
  }

  res.json({
    summary: { checked: checked.folders, ok: checked.ok, missingFolders: missingFolders.length },
    missingFolders,
  });
});

// ── loose file grouper ────────────────────────────────────────────────────────

const GROUPABLE_EXTS = new Set(['.zip', '.rar', '.7z', '.stl', '.obj', '.3mf', '.lys', '.chitubox', '.gcode', '.pdf', '.png', '.jpg', '.jpeg']);

function isGroupableFile(filename) {
  const lower = filename.toLowerCase();
  if (lower === '.ds_store' || lower === 'thumbs.db') return false;
  if (lower.startsWith('._') || lower.startsWith('@') || lower.startsWith('#')) return false;
  const ext = path.extname(lower);
  return GROUPABLE_EXTS.has(ext);
}

/**
 * Extract a model/character name from a filename by stripping:
 *  - file extension
 *  - Google Drive timestamp suffix (e.g. -20250109T000437Z-003)
 *  - scale prefix (e.g. "1_12 scale", "1-6 scale", "1-9scale")
 *  - common modifiers (pre-support, uncut, NSFW, painted, …)
 *  - creator slug (CA3D, CA 3D)
 */
function extractModelName(filename) {
  let name = filename;

  // Strip extension
  name = name.replace(/\.(zip|rar|7z|stl|obj|3mf|lys|chitubox|gcode|pdf|png|jpe?g)$/i, '');

  // Strip Google Drive timestamp: -20250109T000437Z-003  (with optional leading space/dash)
  name = name.replace(/\s*-\s*\d{8}T\d{6}Z-\d+\s*$/, '');

  // Strip scale prefix: "1_12 scale ", "1-9scale ", "1_6 Scale " etc.
  name = name.replace(/^\d+[-_]\d+\s*[Ss]cale\s*/i, '');

  // Strip common variant modifiers (word-boundary aware)
  // Note: "diorama" is intentionally NOT stripped — it's a distinct product type
  name = name.replace(/\bpre[-\s]?support(?:s|ed)?\b/gi, '');
  name = name.replace(/\buncut\b/gi, '');
  name = name.replace(/\bNSFW\b/gi, '');
  name = name.replace(/\bpainted\b/gi, '');
  name = name.replace(/\bbust\b/gi, '');
  name = name.replace(/\bstatue\b/gi, '');

  // Strip creator slug at word boundary
  name = name.replace(/\bCA[-\s]?3D\b/gi, '');

  // Clean up leftover separators and whitespace
  name = name.replace(/\s*[-–—]\s*$/, '').trim();
  name = name.replace(/^\s*[-–—]\s*/, '').trim();
  name = name.replace(/\s+/g, ' ').trim();

  return name;
}

function normalizeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function groupFilesByName(files) {
  const groups = new Map(); // normalizedKey → { suggestedName, files }

  for (const filename of files) {
    const extracted = extractModelName(filename);
    if (!extracted) continue;
    const key = normalizeKey(extracted);
    if (!groups.has(key)) groups.set(key, { suggestedName: extracted, files: [] });
    groups.get(key).files.push(filename);
  }

  return Array.from(groups.entries())
    .map(([key, g]) => ({ key, suggestedName: g.suggestedName, files: g.files.sort() }))
    .sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
}

/**
 * GET /api/organize/loose-files?path=<folder_path>
 *
 * Reads a directory and groups all loose (non-subfolder) files by inferred model name.
 * Returns: { path, groups, existingFolders, looseFileCount, unmatched }
 */
router.get('/loose-files', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path query param required' });
  const folderPath = confinedOr4xx(res, String(req.query.path));
  if (!folderPath) return;

  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch (e) {
    return res.status(404).json({ error: `Cannot read directory: ${e.message}` });
  }

  const looseFiles = [];
  const existingFolders = [];
  const unmatched = [];

  for (const entry of entries) {
    let stat;
    try { stat = fs.statSync(path.join(folderPath, entry)); } catch { continue; }
    if (stat.isDirectory()) {
      existingFolders.push(entry);
    } else if (isGroupableFile(entry)) {
      looseFiles.push(entry);
    } else {
      unmatched.push(entry);
    }
  }

  const groups = groupFilesByName(looseFiles);

  // Flag groups whose suggested name conflicts with an existing folder
  const existingKeys = new Set(existingFolders.map(normalizeKey));
  for (const g of groups) {
    g.conflicts = existingKeys.has(normalizeKey(g.suggestedName));
  }

  res.json({
    path: folderPath,
    groups,
    existingFolders,
    looseFileCount: looseFiles.length,
    unmatched,
  });
});

/** rename, falling back to copy+unlink across devices; never overwrites. */
function moveFileNoClobber(from, to) {
  if (fs.existsSync(to)) { const e = new Error(`Destination already exists: ${path.basename(to)}`); e.code = 'EEXIST'; throw e; }
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

/**
 * POST /api/organize/group-files
 * Body: { path, groups: [{name, files}], dryRun? }
 *
 * Creates subfolders and moves loose files into them.
 * dryRun=true (default) only returns the plan + bash script without touching the filesystem.
 * Always returns a bash script the user can run on the NAS directly.
 * Group and file names must be plain names (no "/", "\\", "..", NUL); existing
 * files are never overwritten.
 */
router.post('/group-files', (req, res) => {
  const { path: rawPath, groups, dryRun = true } = req.body || {};
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'groups array required' });
  const folderPath = confinedOr4xx(res, String(rawPath));
  if (!folderPath) return;

  const moves = [];
  const errors = [];
  const foldersCreated = [];
  const validGroups = [];

  for (const group of groups) {
    const name = typeof group?.name === 'string' ? group.name.trim() : group?.name;
    const files = group?.files;
    if (!name && (!Array.isArray(files) || !files.length)) continue;
    if (!isSafeSegment(name)) { errors.push({ type: 'invalid', name: String(name ?? ''), error: 'Invalid group name (no slashes, "..", or control characters)' }); continue; }
    if (!Array.isArray(files) || !files.length) continue;
    const okFiles = [];
    for (const f of files) {
      if (!isSafeSegment(f)) errors.push({ type: 'invalid', file: String(f ?? ''), group: name, error: 'Invalid file name' });
      else okFiles.push(f);
    }
    if (!okFiles.length) continue;
    validGroups.push({ name, files: okFiles });
  }

  if (!dryRun) {
    try { fs.accessSync(folderPath, fs.constants.W_OK); } catch (e) {
      return res.status(409).json({ error: `Folder is not writable (${e.code || e.message}). Use the generated script instead.`, code: e.code, readOnly: true });
    }
  }

  for (const { name, files } of validGroups) {
    const targetDir = path.join(folderPath, name);
    if (!dryRun) {
      try {
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir);
          foldersCreated.push(name);
        } else if (!fs.statSync(targetDir).isDirectory()) {
          errors.push({ type: 'mkdir', name, error: 'A file with that name already exists' });
          continue;
        }
      } catch (e) {
        errors.push({ type: 'mkdir', name, error: e.message });
        continue;
      }
    } else {
      foldersCreated.push(name);
    }

    for (const filename of files) {
      const from = path.join(folderPath, filename);
      const to   = path.join(targetDir, filename);
      moves.push({ file: filename, group: name, from, to });
      if (!dryRun) {
        try { moveFileNoClobber(from, to); }
        catch (e) { errors.push({ type: 'move', file: filename, group: name, error: e.message }); }
      }
    }
  }

  // Build a bash script for the machine that hosts the library. Every name is
  // single-quoted, so file names like "$(touch x).stl" stay inert.
  const hostPath = toHostPath(folderPath);
  const sshTarget = process.env.ORGANIZE_SSH_TARGET;
  const scriptLines = [
    '#!/bin/bash',
    `# STL Vault — Loose File Organizer`,
    sshTarget ? `# Run this on your NAS via SSH: ssh ${sshTarget.replace(/[^\w@.\-:]/g, '')}` : '# Run this in a shell on the machine that stores the library.',
    `# Generated: ${new Date().toISOString()}`,
    '',
    `cd -- ${shellQuote(hostPath)} || { echo ${shellQuote('Folder not found: ' + hostPath)}; exit 1; }`,
    '',
  ];

  for (const group of validGroups) {
    scriptLines.push(`# ── ${group.name} (${group.files.length} file${group.files.length !== 1 ? 's' : ''}) ──`);
    scriptLines.push(`mkdir -p -- ${shellQuote(group.name)}`);
    for (const filename of group.files) {
      scriptLines.push(`mv -n -- ${shellQuote(filename)} ${shellQuote(group.name + '/')}`);
    }
    scriptLines.push('');
  }

  const script = scriptLines.join('\n');

  res.json({
    dryRun,
    moves,
    foldersCreated,
    errors,
    script,
    summary: {
      groups: validGroups.length,
      files: moves.length,
      executed: dryRun ? 0 : moves.length - errors.filter(e => e.type === 'move').length,
      errors: errors.length,
    },
  });
});

// ── Folder role overrides ──────────────────────────────────────────────────
// Let the user pin how the scanner treats a folder (creator | passthrough |
// ignore), overriding the heuristic. Used by scanner.resolveCreatorDirs.

router.get('/folder-overrides', (req, res) => {
  res.json(db.prepare('SELECT path, role, created_at FROM folder_overrides ORDER BY path').all());
});

router.post('/folder-overrides', (req, res) => {
  const role = req.body?.role;
  if (!req.body?.path) return res.status(400).json({ error: 'path required' });
  if (!role) {
    // Clearing is always allowed (even for a stale path outside the library)
    db.prepare('DELETE FROM folder_overrides WHERE path = ?').run(String(req.body.path));
    return res.json({ ok: true, cleared: true });
  }
  const p = confinedOr4xx(res, String(req.body.path));
  if (!p) return;
  if (!['creator', 'passthrough', 'ignore'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  db.prepare('INSERT INTO folder_overrides (path, role) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET role = excluded.role').run(p, role);
  res.json({ ok: true });
});

// Raw filesystem tree (bounded) for the folder-roles UI — shows the ACTUAL
// directory structure (not the indexed grouping) so misclassifications are fixable.
router.get('/fs-tree', (req, res) => {
  const base = confinedOr4xx(res, String(req.query.path || LIBRARY_PATH));
  if (!base) return;
  const maxDepth = Math.min(parseInt(req.query.depth, 10) || 3, 5);
  const MAX_CHILDREN = 300;
  let overrides;
  try { overrides = new Map(db.prepare('SELECT path, role FROM folder_overrides').all().map(r => [r.path, r.role])); }
  catch { overrides = new Map(); }

  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    entries = entries.filter(e => !e.name.startsWith('@') && !e.name.startsWith('#') && !e.name.startsWith('.'));
    const dirs = entries.filter(e => e.isDirectory());
    const node = {
      name: path.basename(dir), path: dir, role: overrides.get(dir) || null,
      dirCount: dirs.length, fileCount: entries.length - dirs.length, children: [],
    };
    if (depth < maxDepth) {
      for (const c of dirs.slice(0, MAX_CHILDREN)) {
        const child = walk(path.join(dir, c.name), depth + 1);
        if (child) node.children.push(child);
      }
    } else {
      node.truncated = dirs.length > 0;
    }
    return node;
  }

  const tree = walk(base, 0);
  if (!tree) return res.status(400).json({ error: `Cannot read ${base}` });
  res.json(tree);
});

// AI-assisted folder classification — sends Claude a compact text tree (names +
// counts only, no file contents) and returns suggested roles to review & apply.
router.post('/classify-folders', async (req, res) => {
  const apiKey = req.headers['x-claude-key'] || process.env.CLAUDE_API_KEY || '';
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const base = confinedOr4xx(res, String(req.body?.path || LIBRARY_PATH));
  if (!base) return;
  const maxDepth = 3;

  const lines = [];
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter(e => !e.name.startsWith('@') && !e.name.startsWith('#') && !e.name.startsWith('.'));
    const dirs = entries.filter(e => e.isDirectory());
    const files = entries.length - dirs.length;
    lines.push(`${'  '.repeat(depth)}${path.basename(dir)} [${dirs.length} folders, ${files} files] :: ${dir}`);
    if (depth < maxDepth) for (const d of dirs.slice(0, 80)) walk(path.join(dir, d.name), depth + 1);
  }
  walk(base, 0);
  const treeText = lines.join('\n').slice(0, 12000);

  const system = `You classify folders in a 3D-print library so a scanner groups models correctly. For each folder, decide a role:
- "creator": a creator/studio whose subfolders are that creator's models — the scanner should STOP here.
- "passthrough": a wrapper, download dump, mount root, or category folder the scanner should descend THROUGH (e.g. "Downloads", "Gumroad", "STL Archive").
- "ignore": junk/system folders to skip.
Use folder NAMES as the main signal (e.g. "...Studios"/"...3D Models" = creator; "Gumroad Downloads" = passthrough). Only include folders where you have a clear opinion; skip obvious individual model folders. Respond with ONLY a JSON array: [{"path":"<full path exactly as given after ::>","role":"creator|passthrough|ignore","reason":"short"}]`;
  const user = `Folder tree (indentation = depth; each line ends with " :: <full path>"):\n\n${treeText}`;

  try {
    let parsed;
    try {
      parsed = await callClaudeAPI(apiKey, {
        model: CLAUDE_MODEL, max_tokens: 2000, system,
        messages: [{ role: 'user', content: user }],
      }, { timeoutMs: 90000 });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
    const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = text.match(/\[[\s\S]*\]/);
    const suggestions = (m ? JSON.parse(m[0]) : [])
      .filter(s => s && s.path && ['creator', 'passthrough', 'ignore'].includes(s.role));
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve a duplicate set: keep one model, hide the rest. Non-destructive —
// consolidates tags + collection memberships into the keeper and adopts a
// thumbnail if it lacks one; the dropped models are hidden, never deleted.
router.post('/dedupe/resolve', (req, res) => {
  const { keepId, dropIds } = req.body || {};
  if (!keepId || !Array.isArray(dropIds) || dropIds.length === 0) {
    return res.status(400).json({ error: 'keepId and dropIds[] required' });
  }
  const keep = db.prepare('SELECT * FROM models WHERE id = ?').get(keepId);
  if (!keep) return res.status(404).json({ error: 'Keeper model not found' });

  const placeholders = dropIds.map(() => '?').join(',');
  const drops = db.prepare(`SELECT * FROM models WHERE id IN (${placeholders})`).all(...dropIds);

  db.transaction(() => {
    const tags = new Set();
    try { for (const t of JSON.parse(keep.tags || '[]')) tags.add(t); } catch {}
    let thumb = keep.thumbnail_path;

    for (const d of drops) {
      try { for (const t of JSON.parse(d.tags || '[]')) tags.add(t); } catch {}
      if (!thumb && d.thumbnail_path) thumb = d.thumbnail_path;
      // Move the dropped model's collection memberships onto the keeper
      const cols = db.prepare('SELECT collection_id FROM collection_models WHERE model_id = ?').all(d.id);
      for (const c of cols) {
        try {
          db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id) VALUES (?, ?)')
            .run(c.collection_id, keepId);
        } catch {}
      }
      db.prepare("UPDATE models SET hidden = 1, updated_at = datetime('now') WHERE id = ?").run(d.id);
    }

    db.prepare("UPDATE models SET tags = ?, thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify([...tags].slice(0, 12)), thumb || null, keepId);
  })();

  res.json({ success: true, kept: keepId, hidden: dropIds.length });
});

module.exports = router;
