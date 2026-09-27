'use strict';
/**
 * lib/similar.js — near-duplicate model-name detection for /api/organize/health.
 *
 * The old version bucketed by the first 6 chars of the raw name. Libraries name
 * folders "<Creator> - <Model>", so a whole creator landed in ONE bucket and the
 * O(n²) Levenshtein pass took 30s+ at 15k models, blocking the server.
 *
 * Now: normalise names (strip the creator prefix, variant keywords, dates,
 * punctuation), bucket by the first meaningful token, compare with a banded
 * Levenshtein that bails early, cap work per bucket, and yield to the event
 * loop between buckets.
 */

const VARIANT_TOKENS = new Set([
  'supported', 'presupported', 'presupport', 'presupports', 'unsupported', 'support', 'supports', 'pre', 'un', 'no',
  'fdm', 'resin', 'sla', 'msla', 'dlp', 'stl', 'stls', 'obj', '3mf', 'lychee', 'chitubox', 'lys', 'ctb',
  'files', 'file', 'parts', 'part', 'renders', 'render', 'images', 'image', 'pics', 'pic', 'photos', 'photo',
  'previews', 'preview', 'version', 'copy', 'final', 'fixed', 'hollow', 'hollowed', 'solid', 'split', 'merged',
  'nsfw', 'sfw', 'remix', 'uncut', 'print', 'ready', 'scale', 'the', 'and', 'of',
]);

function tokens(s) {
  return String(s || '').toLowerCase()
    .replace(/-\d{8}t\d{6}z(-\d+)?/g, ' ')                 // Google Drive batch timestamps
    .replace(/\b(19|20)\d{2}(?:[-_. ]\d{1,2}){0,2}\b/g, ' ') // years / dates (2024, 2024-03, 2024.03.01)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** True when a name is made only of variant/role keywords ("Supported", "FDM", "STL Files"). */
function isVariantOnlyName(name) {
  const t = tokens(name).filter(x => !/^v?\d+$/.test(x));
  return t.length === 0 || t.every(x => VARIANT_TOKENS.has(x));
}

/**
 * Per-creator leading token that most of its model names share (folder names
 * like "B3DSERK - Dragon Knight" become "B3DSERK Dragon Knight" after scanning).
 */
function creatorPrefixes(models) {
  const byCreator = new Map();
  for (const m of models) {
    const key = m.creator_id ?? m.creator_name ?? '';
    if (!byCreator.has(key)) byCreator.set(key, []);
    byCreator.get(key).push(m.name || '');
  }
  const prefixes = new Map();
  for (const [key, names] of byCreator) {
    if (names.length < 3) continue;
    const counts = new Map();
    for (const n of names) {
      const t = tokens(n);
      if (t.length > 1) counts.set(t[0], (counts.get(t[0]) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [tok, n] of counts) if (n > bestN) { best = tok; bestN = n; }
    if (best && bestN >= names.length * 0.5) prefixes.set(key, best);
  }
  return prefixes;
}

/** Numbers that distinguish releases: years/dates and plain integers ("#12", "Part 2"), not "v2". */
function distinguishingNumbers(name) {
  const s = String(name || '').toLowerCase();
  const out = [];
  const dateRe = /\b((?:19|20)\d{2})(?:[-_. ](\d{1,2}))?(?:[-_. ](\d{1,2}))?\b/g;
  let m;
  while ((m = dateRe.exec(s)) !== null) out.push([m[1], m[2] && m[2].padStart(2, '0'), m[3] && m[3].padStart(2, '0')].filter(Boolean).join('-'));
  const rest = s.replace(dateRe, ' ');
  for (const t of rest.split(/[^a-z0-9]+/)) if (/^\d+$/.test(t)) out.push(String(parseInt(t, 10)));
  return out.sort().join(',');
}

function normalizeForSimilarity(name, creatorName, commonPrefix) {
  let t = tokens(name);
  const creatorTokens = tokens(creatorName);
  if (t.length > 1 && commonPrefix && t[0] === commonPrefix) {
    t = t.slice(1);
  } else if (creatorTokens.length && t.length > creatorTokens.length &&
             creatorTokens.every((c, i) => t[i] === c)) {
    t = t.slice(creatorTokens.length);
  } else if (t.length > 1 && creatorTokens[0] && creatorTokens[0].length >= 3 && t[0] === creatorTokens[0]) {
    t = t.slice(1);
  }
  return t.filter(x => !VARIANT_TOKENS.has(x) && !/^v?\d+$/.test(x)).join(' ');
}

/** Levenshtein distance, or Infinity as soon as it must exceed maxDist (banded, 2 rows). */
function boundedLevenshtein(a, b, maxDist) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > maxDist) return Infinity;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const lo = Math.max(1, i - maxDist), hi = Math.min(n, i + maxDist);
    for (let j = 1; j < lo; j++) cur[j] = Infinity;
    for (let j = lo; j <= hi; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    for (let j = hi + 1; j <= n; j++) cur[j] = Infinity;
    if (rowMin > maxDist) return Infinity;
    [prev, cur] = [cur, prev];
  }
  return prev[n] > maxDist ? Infinity : prev[n];
}

const MIN_LEN = 7;          // normalised names of <= 6 chars are too generic to compare
const FULL_PAIRWISE = 200;  // buckets up to this size are compared exhaustively
const WINDOW = 40;          // bigger buckets: compare each name with its sorted neighbours

/**
 * @param {Array<{id,name,creator_id,creator_name}>} models
 * @param {{threshold?: number, yieldEvery?: number}} opts
 * @returns {Promise<Array<{score,a,b}>>}
 */
async function findSimilarNames(models, { threshold = 0.85, sliceMs = 15 } = {}) {
  const prefixes = creatorPrefixes(models);
  const buckets = new Map();
  for (const m of models) {
    const norm = normalizeForSimilarity(m.name, m.creator_name, prefixes.get(m.creator_id ?? m.creator_name ?? ''));
    if (norm.length < MIN_LEN) continue;
    const first = norm.split(' ')[0];
    const key = first.length >= 3 ? first : norm.replace(/ /g, '').slice(0, 4);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ m, norm, nums: distinguishingNumbers(m.name) });
  }

  const out = [];
  let sliceStart = Date.now();
  const compare = (x, y) => {
    // "Dragon Bust 2021-08" vs "Dragon Bust 2022-03" (or "#7" vs "#122") are
    // different releases, not duplicates.
    if (x.nums && y.nums && x.nums !== y.nums) return;
    const maxLen = Math.max(x.norm.length, y.norm.length);
    const maxDist = Math.floor((1 - threshold) * maxLen);
    const d = x.norm === y.norm ? 0 : boundedLevenshtein(x.norm, y.norm, maxDist);
    if (d === Infinity) return;
    const score = 1 - d / maxLen;
    if (score >= threshold) out.push({ score: Math.round(score * 100) / 100, a: x.m, b: y.m });
  };

  for (const group of buckets.values()) {
    if (group.length > 1) {
      if (group.length <= FULL_PAIRWISE) {
        for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) compare(group[i], group[j]);
      } else {
        group.sort((p, q) => (p.norm < q.norm ? -1 : p.norm > q.norm ? 1 : 0));
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < Math.min(group.length, i + 1 + WINDOW); j++) compare(group[i], group[j]);
        }
      }
    }
    if (Date.now() - sliceStart > sliceMs) {
      await new Promise(r => setImmediate(r));
      sliceStart = Date.now();
    }
  }
  out.sort((p, q) => q.score - p.score);
  return out;
}

module.exports = { findSimilarNames, normalizeForSimilarity, isVariantOnlyName, boundedLevenshtein, creatorPrefixes, distinguishingNumbers };
