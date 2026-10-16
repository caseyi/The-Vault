'use strict';
/**
 * lib/naming.js — studio identity parser (docs/library-metadata.md §4).
 *
 * Turns a file or folder name such as
 *   "WICKED - Capitain Marvel Statue 310mm (Pre Supported Chitubox)-20260602T183917Z-3-002.zip"
 * into { creator: 'Wicked', edition: 'Sculpture', character: 'Captain Marvel',
 *        variant: 'presupported-chitubox', strong: true, ... }.
 *
 * The rules follow the organizer (file_inbox.py parse_item / fixname / SEED_FIXES and
 * organize_library.py classify) so the app and the organizer agree on names.
 * Pure functions only; no fs, no DB.
 */

// ── creators / studios ───────────────────────────────────────────────────────

/** lowercased alias → canonical creator */
const CREATOR_ALIASES = {
  'wicked': 'Wicked',
  'wicked 3d models': 'Wicked',
  'b3dserk': 'B3DSERK', 'b3dserk studios': 'B3DSERK', 'bedserk': 'B3DSERK', 'b3dserk studio': 'B3DSERK', 'b3rdserk': 'B3DSERK',
  'sw3d': 'SW3D', 'star wars 3d models': 'SW3D', 'star wars 3d modes': 'SW3D',
  'zez': 'ZEZ', 'zez collectibles': 'ZEZ', 'zez collectibles patreon': 'ZEZ',
  'carlos': 'CA 3D', 'ca 3d': 'CA 3D', 'ca3d': 'CA 3D',
};
/** canonical creator → studio (the Wicked family share one studio) */
const STUDIO_OF = { Wicked: 'Wicked', B3DSERK: 'Wicked', SW3D: 'Wicked', ZEZ: 'ZEZ' };
/** creators whose trees use the studio (identity) layout */
const STUDIO_CREATORS = new Set(['Wicked', 'B3DSERK', 'SW3D', 'ZEZ']);
/** creators with one fixed genre (organizer filing_config fixed_genre) */
const FIXED_GENRE = { SW3D: 'Star Wars' };

function canonicalCreator(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return CREATOR_ALIASES[k] || null;
}
function studioOf(creator) { return STUDIO_OF[creator] || creator || null; }

// ── genres ───────────────────────────────────────────────────────────────────

const GENRES = ['Marvel', 'DC', 'Star Wars', 'Movies', 'TV', 'Video Games', 'Christmas', 'Other Comics',
  'Anime', 'Horror', 'Wildcard'];
/** lowercased folder/genre word → canonical genre */
function canonicalGenre(name) {
  if (!name) return null;
  const s = String(name).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('other comics')) return String(name).trim(); // keep the organizer's long label
  if (s === 'video game' || s === 'videogames') return 'Video Games';
  if (s === 'movie') return 'Movies';
  if (s === '_unsorted') return '_Unsorted';
  for (const g of GENRES) if (g.toLowerCase() === s) return g;
  return null;
}

// ── typo fixes (organizer SEED_FIXES + what the inventories show) ────────────

const SEED_FIXES = {
  'kingdome': 'kingdom', 'porrait': 'portrait', 'tayson': 'tyson', 'litlle': 'little', 'durde': 'durden',
  'gigpsy': 'gipsy', 'quick silver': 'quicksilver', 'altaïr': 'altair', 'sablé': 'sable',
  'assassin´s': "assassin's", 'jor el': 'jor-el', 'faora-ui': 'faora-ul', 'space knight': 'spaceknight',
  // seen in the Oct 2026 inventories
  'capitain': 'captain', 'barlog': 'balrog', 'jurasic': 'jurassic', 'scculture': 'sculpture',
  'sculture': 'sculpture', 'scupture': 'sculpture', 'sculpure': 'sculpture', 'satue': 'statue',
  'golbin': 'goblin', 'grevious': 'grievous', 'anikin': 'anakin', 'jhon': 'john', 'saphire': 'sapphire',
  'driod': 'droid', 'doku': 'dooku', 'sideous': 'sidious', 'carange': 'carnage', 'masterchief': 'master chief',
  'moonknight': 'moon knight', 'cyclope': 'cyclops', 'jean gray': 'jean grey', 'ashoka': 'ahsoka',
  'spider man': 'spiderman', 'spider-man': 'spiderman', 'iron-man': 'iron man',
  'supproted': 'supported', 'supporte': 'supported', 'piee': 'piece', 'xpise': 'xpose', 'racoon': 'raccoon',
  'dr.': 'doctor', 'dr': 'doctor', 'mr.': 'mr', 'presoported': 'presupported', 'portarit': 'portrait',
  'ligthsaber': 'lightsaber', 'ligthsabers': 'lightsabers', 'batmanand': 'batman and', 'sopported': 'supported', 'suported': 'supported', 'suports': 'supports', 'estatua': 'statue', 'estatue': 'statue', 'kingom': 'kingdom', 'capitan': 'captain', 'c3poand': 'c3po and', 'statute': 'statue',
};

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Build a fixer from SEED_FIXES plus `fix` rows of filing_rules.csv ({bad: good}). */
function makeFixer(extra) {
  const fixes = { ...SEED_FIXES, ...(extra || {}) };
  const list = Object.entries(fixes)
    .filter(([b, g]) => b && b !== g)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([bad, good]) => [new RegExp(`(?<![\\w])${escapeRe(bad)}(?![\\w])`, 'gi'), good]);
  return (s) => {
    let out = ` ${s} `;
    for (const [re, good] of list) out = out.replace(re, good);
    return out.replace(/\s+/g, ' ').trim();
  };
}
const defaultFix = makeFixer();

// ── cleaning ─────────────────────────────────────────────────────────────────

const FILE_EXT = /\.(zip|rar|7z|stl|obj|3mf|lys|lychee|chitubox|ctb|photon|gcode|gco|txt|pdf|png|jpe?g|gif|webp|blend|ztl|step|stp|fbx)$/i;
const DRIVE_STAMP = /[-_ ]?\d{8}T\d{6}Z(?:-\d+)*$/i;

/**
 * Strip extension, Drive stamps (-20260602T183917Z-3-002), part suffixes (-002),
 * extraction copies (_2) and copy suffixes ( (1)). Folders named "X.zip" (Finder
 * extraction) lose the .zip too.
 */
function cleanStem(name) {
  let s = String(name || '').trim();
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(FILE_EXT, '').trim();
    s = s.replace(DRIVE_STAMP, '').trim();
    s = s.replace(/[_\s]+[A-Za-z0-9.]+_[A-Za-z]{3}-\d{2}-\d{6}-\d{4}_Conflict$/i, '').trim(); // Synology Drive conflict copy
    s = s.replace(/\s*\(\d{1,2}\)$/, '').trim();        // " (1)"
    s = s.replace(/(?<=\S)-\d{3}$/, '').trim();         // "-002" Drive multi-part
    s = s.replace(/(?<=[a-z)\]])_\d{1,2}$/i, '').trim(); // "_2" extraction copy
    if (s === before) break;
  }
  return s;
}

// ── variants ─────────────────────────────────────────────────────────────────

// Order matters: specific presupport flavours before the generic ones.
const VARIANT_RULES = [
  ['presupported-chitubox', /\b(?:pre[\s_-]*supp?or?t\w*[\s_-]*\(?\s*chitubox\s*\)?|\(?chitubox\)?[\s_-]*(?:&|and)?[\s_-]*(?:stl[\s_-]*)?pre[\s_-]*supp?or?t\w*|chitubox(?:[\s_-]*files?)?)\b/i],
  ['presupported-lychee', /\b(?:pre[\s_-]*supp?or?t\w*[\s_-]*\(?\s*lychee\s*\)?|lychee[\s_-]*(?:pre[\s_-]*supp?or?t\w*)?)\b/i],
  ['presupported-stl', /\b(?:stl[\s_-]*pre[\s_-]*supp?or?t\w*|pre[\s_-]*supp?or?t\w*[\s_-]*\(?\s*stl\s*\)?|pres?[\s_-]*supp?or?ts?|pre[\s_-]*supp?or?t\w*)\b/i],
  ['unsupported', /\b(?:non[\s_-]*(?:and[\s_-]*)?supp?or?t\w*|un[\s_-]*supp?or?t\w*|no[\s_-]*supp?or?ts?|without[\s_-]*supports?)\b/i],
  ['one-piece', /\bone[\s_-]*pie(?:c|e)?e?s?\b/i],
  ['x-pose', /\bx[\s_-]*poses?\b|\bxposes?\b/i],
  ['images', /\b(?:images?|renders?|pngs?|photos?|pictures?|imgs?|previews?|render[\s_-]*final)\b/i],
];
const INFO_RE = /\b(?:size\s*and\s*printing\s*information|printing\s*information|size|info|information|measures?|instructions?)\b/i;

const VARIANT_IDS = ['unsupported', 'one-piece', 'presupported-chitubox', 'presupported-stl', 'presupported-lychee', 'x-pose', 'images', 'info', 'other'];

/** Variant id of a short string (a parenthesis, a folder name). */
function variantOf(s) {
  const t = String(s || '');
  for (const [id, re] of VARIANT_RULES) if (re.test(t)) return id;
  return null;
}

// ── words ────────────────────────────────────────────────────────────────────

const STOP = new Set(['and', 'the', 'of', 'vs', 'v', 'a', 'an', 'with', 'for', 'in', 'on']);
const SMALL = new Set(['the', 'of', 'and', 'a', 'in', 'vs', 'for', 'with', 'on', 'an']);
/** words that never identify a work on their own (parts, packaging, variants) */
const GENERIC_WORDS = new Set([
  'stl', 'stls', 'file', 'files', 'part', 'parts', 'piece', 'pieces', 'base', 'bases', 'full', 'head', 'heads',
  'body', 'upper', 'lower', 'left', 'right', 'arm', 'arms', 'leg', 'legs', 'hand', 'hands', 'torso', 'cape',
  'wings', 'wing', 'sword', 'whip', 'weapon', 'weapons', 'images', 'image', 'renders', 'render', 'pngs', 'png',
  'jpg', 'photos', 'pictures', 'color', 'colour', 'one', 'pose', 'poses', 'xpose', 'supported', 'unsupported',
  'presupported', 'support', 'supports', 'pre', 'non', 'no', 'chitubox', 'lychee', 'hollow', 'hollowed', 'solid',
  'fdm', 'resin', 'sla', 'msla', 'dlp', 'beefed', 'slicer', 'sliced', 'section', 'sections', 'logo', 'extra',
  'extras', 'bonus', 'fix', 'fixed', 'fixes', 'update', 'updated', 'version', 'v1', 'v2', 'v3', 'final', 'new',
  'old', 'scale', 'mm', 'cm', 'size', 'info', 'information', 'printing', 'print', 'ready', 'tested', 'models',
  'model', 'collection', 'complete', 'lite', 'small', 'big', 'large', 'medium', 'only', 'misc', 'other', 'files',
  'statue', 'statues', 'sculpture', 'sculptures', 'bust', 'busts', 'diorama', 'dioramas', 'portrait', 'dio',
  'figure', 'figures', 'accessory', 'accessories', 'presupports', 'presuport', 'optional', 'laser', 'glass',
  'without', 'separate', 'rings', 'ring', 'measures', 'term', 'pack', 'swag', 'obj', '3mf', 'lys', 'ctb',
  'squared', 'square', 'lowe', 'wetransfer', 'rende', 'onepiece', 'nosupports', 'readytoslice', 'folder', 'carpeta', 'nueva', 'untitled', 'copy', 'second', 'alt', 'alternative', 'test', 'tests', 'chest', 'neck', 'foot', 'feet', 'boot',
  'boots', 'tail', 'eyes', 'eye', 'hair', 'face', 'faces', 'mask', 'helmet', 'cables', 'cable_', 'plate', 'plates',
  'floor', 'window', 'windows', 'column', 'columns', 'bridge', 'rock', 'rocks', 'wall', 'walls',
]);
const PART_WORD_STRIP = /\b(?:torso|bust\s+torso|heads?|extra|second|separate|pieces|parts?|without\s+glass|lite\s+version|complete|full|updated?|fix(?:ed)?|optional|laser)\b/gi;

const EDGE_PART_END = /(?:\s+(?:supported|supports?|presup\w*|pre|only|more|cuts?|printers?|medium|copia|copy|bases?|solid|hollow|heads?|torso|wings?|capes?|parts?|pieces?|fix(?:ed)?|updated?|stls?|files?|full|extra|bonus|logo|sections?|left|right|upper|lower|body|poster|render|renders|images?|arms?|legs?|rocks?|divided|split|big|small|[lr]\s+(?:arm|leg|hand|foot|boot|wing)s?)(?:\s+\d{1,2})?|\s+(?:and|&|\+|with|-))$/i;
const EDGE_PART_START = /^(?:upper\s+body|lowe?r?\s+body|wings?|extra|full|left|right|x\s*pose|bonus|base|final|logo|and|&|\+|with)\s+/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\b`, 'i');
function monthIndex(w) {
  const l = String(w).toLowerCase();
  const i = MONTHS.findIndex(m => m === l || m.startsWith(l.slice(0, 3)) && l.length >= 3);
  return i >= 0 ? i + 1 : null;
}

const ACRONYMS = new Set(['dc', 'tv', 'mj', 'tmnt', 'dbz', 'mcu', 'bb', 'hk', 'ig', 'ed', 'at', 'tie', 'arc', 'bwl', 'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii', 'usa', 'nypd', 'shield', 'rx', 'ufo', 'et', 'r2', 'c3po', 'k2so']);

/** Title-case display name: keeps McClane / LaRusso / HK-47, fixes SHOUTING and lowercase. */
function titleCase(s) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const lower = w.toLowerCase();
    if (ACRONYMS.has(lower.replace(/[^a-z0-9]/g, ''))) return w.toUpperCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    if (/\d/.test(w)) return w.toUpperCase().length <= 6 ? w.toUpperCase() : w;
    if (w === w.toLowerCase() || w === w.toUpperCase()) return lower.charAt(0).toUpperCase() + lower.slice(1);
    return w; // mixed case: keep (McClane, LaRusso)
  }).join(' ');
}

/** Normalized comparison key: lowercase, typos fixed, stopwords + plural "s" dropped. */
function normKey(s, fix = defaultFix) {
  let t = fix(String(s || '').toLowerCase());
  t = t.replace(/&/g, ' and ').replace(/['’´`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return t.split(' ').filter(w => w && !STOP.has(w))
    .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}
/** Same key without spaces (Spider Man / Spiderman, Master Chief / Masterchief). */
function compactKey(s, fix) { return normKey(s, fix).replace(/\s+/g, ''); }

/** Significant word stems (organizer stems(): 5-char prefixes of words > 2 chars). */
function stems(s, fix) {
  return new Set(normKey(s, fix).split(' ').filter(w => w.length > 2 && !GENERIC_WORDS.has(w)).map(w => w.slice(0, 5)));
}

/** True when every word is a part/variant/packaging word or a number. */
function isGenericText(s) {
  const words = String(s || '').toLowerCase().replace(/&/g, ' ').split(/[\s_]+/)
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);
  if (!words.length) return true;
  return words.every(w => {
    if (/[^a-z0-9]/.test(w)) { // "x-23", "hk-47": generic only when every piece is
      return w.split(/[^a-z0-9]+/).filter(Boolean).every(p => GENERIC_WORDS.has(p) || /^\d+$/.test(p));
    }
    return GENERIC_WORDS.has(w) || STOP.has(w) || /^v?\d+[a-z]?$/.test(w) || /^\d+(mm|cm|x)?$/.test(w) || w.length === 1;
  });
}

// ── release / term helpers ───────────────────────────────────────────────────

/** "2022-04 - Crimson Sand Arena" / "#40 - Elven Grace" / "Society Vol. XI" → release info, else null */
function parseRelease(name) {
  // "Pre-Supported - #41 - Barbarian Winter" is the pre-supported copy of "#41 - Barbarian Winter"
  const s = String(name || '').trim().replace(/^(?:pre[\s_-]*supported|presupported|supported|un[\s_-]*supported|no[\s_-]*supports?)(?:\s*\([^)]*\))?\s*-\s*/i, '');
  let m = s.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])\s*-\s*(.+)$/);
  if (m) return { term: `${m[1]}-${m[2]}`, label: m[3].trim(), number: null };
  m = s.match(/^#\s*(\d{1,4})\s*-\s*(.+)$/);
  if (m) return { term: null, label: m[2].trim(), number: parseInt(m[1], 10) };
  m = s.match(/\bvol(?:ume)?\.?\s+([ivxlcdm]+|\d+)\b/i);
  if (m) return { term: null, label: s, number: null };
  return null;
}

/** "MOVIES August Term 2024" → { term: '2024-08', genre: 'Movies' } (term folders are transparent) */
function parseTermFolder(name) {
  const s = cleanStem(name);
  if (MONTHS.includes(s.trim().toLowerCase())) return { term: null, genre: null }; // a bare "May" folder holds term downloads
  const my = s.match(/^([a-z]+)[\s_-]*(20\d{2})$/i); // "Aug 2024", "September 2025"
  if (my && monthIndex(my[1]) && MONTH_RE.test(my[1])) return { term: `${my[2]}-${String(monthIndex(my[1])).padStart(2, '0')}`, genre: null };
  if (!/\bterm\b/i.test(s)) return null;
  const mon = s.match(MONTH_RE);
  const yr = s.match(/\b(20\d{2})\b/);
  const g = s.match(/\b(marvel|dc|movies|video games?|star wars|wildcard|christmas)\b/i);
  return {
    term: mon && yr ? `${yr[1]}-${String(monthIndex(mon[1])).padStart(2, '0')}` : null,
    genre: g ? canonicalGenre(g[1]) : null,
  };
}

// ── the parser ───────────────────────────────────────────────────────────────

const PREFIX_RE = /^(?:\d{6}\s+)?(?:update\s*-\s*)?(wicked(?:\s+3d\s+models)?|b3dserk(?:\s+studios?)?|b3rdserk|bedserk|sw3d|zez)\b\s*[-_:]?\s*/i;
const SW3D_RE = /\s*[-_]*\s*star\s*wars\s*3d\s*mode?l?s?\b\s*[-_]*\s*/i;
const NOISE_RES = [
  /\b\d+(?:[.,]\d+)?\s?(?:mm|cm)\b/gi,                     // 345mm, 377,14mm, 30 cm
  /\(?\b\d+(?:[.,]\d+)?\s?mm\s+with\s+[^)]*\)?/gi,          // "(506mm with small base and 645.66mm with big base)"
  /\b1\s*[\/:_-]\s*\d{1,2}\b(?:\s*scale)?/gi,               // 1/6, 1_12 scale, 1-6
  /\b1\s(?:[2-9]|1[0-2])\b(?:\s*scale)?(?=\s|$)/gi,          // "bane 1_6" → "1 6"
  /\b\d{1,3}\s*%?\s*-+\s*\d{1,3}\s*%?-*/g,                  // 50%-100%, 50--100-
  /\b\d+\s*%/g,                                             // 60%
  /\b\d+\s*parts?\b/gi,                                     // 44 parts
  /\b(?:stls?\s+)?(?:tested\s+and\s+)?ready\s+(?:for|to)\s+(?:3d\s+)?print(?:ing)?\b/gi,
  /\btested\s+and\s+ready\s+for\s+3d\s+printing\b/gi,
  /\b3d\s+print(?:ing)?\b/gi,
  /\b(?:3d|stls?)\b/gi,
  /\bby\s+[a-z0-9]+(?:\s+[a-z0-9]+)?$/gi,
  /\bv\d+(?:\.\d+)?\b/gi,
  /\bscale\b/gi,
];

/**
 * Parse one name.
 * @param {string} raw     file or folder name
 * @param {object} [opts]  { fix: fixer from makeFixer(), isFile: boolean }
 */
function parseName(raw, opts = {}) {
  const fix = opts.fix || defaultFix;
  const out = {
    raw: String(raw || ''), clean: '', creator: null, prefixed: false, variant: null, edition: null,
    character: '', key: '', genre: null, term: null, generic: true, strong: false, isDiorama: false,
  };
  let s = cleanStem(raw);
  out.clean = s;
  const termFolder = parseTermFolder(s);
  if (termFolder && (/\b20\d{2}\b/.test(s) || MONTHS.includes(s.trim().toLowerCase())) && s.split(/\s+/).length <= 7) {
    out.term = termFolder.term; out.genre = termFolder.genre;
    return out; // "MOVIES August Term 2024" — a transparent term folder, never an identity
  }
  s = fix(s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim());

  // Creator prefix ("WICKED - ", "B3DSERK_", "Update - WICKED - ", "062221 B3DSERK - ")
  const pm = s.match(PREFIX_RE);
  if (pm) {
    out.creator = canonicalCreator(pm[1]) || canonicalCreator(pm[1].split(/\s+/)[0]);
    out.prefixed = true;
    s = s.slice(pm[0].length);
  }
  // SW3D suffix/infix "… - Star Wars 3D Models - 30 cm"
  if (SW3D_RE.test(s)) {
    out.creator = out.creator || 'SW3D';
    out.prefixed = true;
    s = s.replace(SW3D_RE, ' - ');
  }
  // Genre words right after the prefix ("Wicked Marvel Hulk …"), month terms ("June Term - …")
  if (out.prefixed) {
    const gm = s.match(/^(marvel|dc|movies|video games?|star wars|wildcard)\b\s*[-:]?\s*/i);
    if (gm && s.length > gm[0].length + 2) { out.genre = canonicalGenre(gm[1]); s = s.slice(gm[0].length); }
    s = s.replace(/^(?:[a-z]+\s+)?term(?:\s+20\d{2})?\s*[-:]\s*/i, '');
    s = s.replace(new RegExp(`^(?:${MONTHS.join('|')})\\b\\s*(?:20\\d{2}\\s*)?(?:term\\b\\s*)?[-:]?\\s*`, 'i'), ''); // "-February diorama …"
  }

  // Variant: parentheses first, then the bare words
  const parens = [];
  s = s.replace(/\(([^)]*)\)/g, (m, inner) => { parens.push(inner); return ' '; });
  for (const p of parens) {
    const v = variantOf(p) || (INFO_RE.test(p) ? 'info' : null);
    if (v && !out.variant) out.variant = v;
  }
  if (!out.variant) {
    const v = variantOf(s);
    if (v) out.variant = v;
  }
  for (const [, re] of VARIANT_RULES) s = s.replace(new RegExp(re.source, 'gi'), ' ');
  if (/\s-\s*(?:size|info|measures)\s*$/i.test(s)) { out.variant = out.variant || 'info'; s = s.replace(/\s-\s*(?:size|info|measures)\s*$/i, ' '); } // "… - Size.txt"
  if (/\bsize\s*and\s*printing\s*information\b/i.test(s)) { out.variant = out.variant || 'info'; s = s.replace(/\bsize\s*and\s*printing\s*information\b/gi, ' '); }
  s = s.replace(/^\s*renders?\s+/i, ' ');

  // Noise
  for (const re of NOISE_RES) s = s.replace(re, ' ');
  s = s.replace(/(\w)\.(?=[A-Za-z])/g, '$1. ');
  s = s.replace(/\s+[-–—:]+\s*|\s*[-–—:]+\s+|^[-–—:]+|[-–—:]+$/g, ' - ').replace(/\s+/g, ' ').trim();
  s = fix(s);

  // Edition (Diorama > Accessory > Bust > Sculpture); "bust for statue" is a statue part
  const low = s.toLowerCase();
  if (/\b(?:diorama|dioramas|dio)\b/.test(low)) out.edition = 'Diorama';
  else if (/\b(?:blaster|rifle|cannon|lightsaber|ship|speeder)\b/.test(low)) out.edition = 'Accessory';
  else if (/\b(?:bust|busts)\b[\w\s]*\bfor\s+(?:statue|sculpture)\b|\bfor\s+(?:statue|sculpture)\b/.test(low)) out.edition = 'Sculpture';
  else if (/\bfor\s+(?:the\s+)?bust\b/.test(low)) out.edition = 'Bust';
  else if (/\b(?:bust|busts|portrait)\b/.test(low)) out.edition = 'Bust';
  else if (/\b(?:sculpture|sculptures|statue|statues|figure|sculpt)\b/.test(low)) out.edition = 'Sculpture';
  out.isDiorama = out.edition === 'Diorama';

  // Character / title: drop edition words, part words and leftover separators
  let c = s
    .replace(/\bfor\s+(?:the\s+)?(?:statue|sculpture|bust)\b/gi, ' ')
    .replace(/\b(?:portrait\s+bust|bust\s+portrait|sculptures?|statues?|figure|sculpt|busts?|portrait|dioramas?|dio)\b/gi, ' ')
    .replace(PART_WORD_STRIP, ' ')
    .replace(/\bbase\d[\w-]*/gi, ' ')
    .replace(/(^|\s)(?:[2-9]\d|\d{3})(?=\s|$)/g, ' '); // "100"/"50" (percent folders); keeps "Slave 1", "Deadpool 2"
  if (out.isDiorama) c = c.replace(/\bbases?\b/gi, ' ');
  if (out.edition === 'Accessory') c = c.replace(/\b(?:blaster|rifle|cannon|lightsaber|ship|speeder)\b/gi, ' ');
  c = c.replace(/(^|\s)-(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  c = c.replace(/^[\s\-&+,.]+|[\s\-&+,.]+$/g, '').trim();
  // "Iron Patriot Solid Base" → "Iron Patriot", "Wings Vulture" → "Vulture" (part words at the edges)
  for (let i = 0; i < 4; i++) {
    const before = c;
    if (!isGenericText(c.replace(EDGE_PART_END, '')) && EDGE_PART_END.test(c)) c = c.replace(EDGE_PART_END, '').trim();
    if (!isGenericText(c.replace(EDGE_PART_START, '')) && EDGE_PART_START.test(c)) c = c.replace(EDGE_PART_START, '').trim();
    c = c.replace(/^[\s\-&+,.]+|[\s\-&+,.]+$/g, '').trim();
    if (c === before) break;
  }
  out.generic = isGenericText(c);
  out.character = out.generic ? '' : titleCase(c);
  out.key = out.generic ? '' : normKey(c, fix);
  out.strong = !out.generic && (out.prefixed || !!out.edition);
  return out;
}

// ── product names (Gumroad manifest) ─────────────────────────────────────────

/**
 * "Wicked Marvel March 2026 Term Conan The Barbarian Sculpture: Tested and ready…"
 *   → { creator:'Wicked', genre:'Marvel', term:'2026-03', character:'Conan The Barbarian', edition:'Sculpture' }
 * "B3DSERK June Term 2022: Hawkman Sculpture 1/6 ready for printing" → term 2022-06
 * "Mandalorian Sculpture - Star Wars 3D Models - Tested and Ready…" → creator SW3D, genre Star Wars
 */
function parseProductName(name, manifestCreator, fix = defaultFix) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  const res = { creator: canonicalCreator(manifestCreator) || (manifestCreator ? String(manifestCreator).trim() : null), genre: null, term: null, termMonth: null, character: '', edition: null, key: '', isDiorama: false };
  s = s.replace(/:\s*(?:tested|stls?|ready).*$/i, '').replace(/\b(?:tested and ready for 3d printing|ready for printing|stls? ready for printing)\b.*$/i, '');
  const pm = s.match(/^(wicked|b3dserk(?:\s+studios?)?|bedserk|sw3d|zez)\b\s*/i);
  if (pm) { res.creator = res.creator || canonicalCreator(pm[1]); s = s.slice(pm[0].length); }
  if (SW3D_RE.test(s)) { res.creator = 'SW3D'; s = s.replace(SW3D_RE, ' ').replace(/\s+-\s*$/, ''); }
  if (/^wildcard\b/i.test(s)) { s = s.replace(/^wildcard\s*/i, ''); res.genre = 'Wildcard'; }
  const gm = s.match(/^(marvel|dc|movies|video games?|star wars|christmas|horror|anime|tv)\b\s*/i);
  if (gm) { res.genre = canonicalGenre(gm[1]); s = s.slice(gm[0].length); }
  // "<Month> <Year> Term", "<Month> Term <Year>:", "<Month> term", "Movies Term"
  const tm = s.match(/^(?:([a-z]+)\s+)?(?:(20\d{2})\s+)?term\b(?:\s+(20\d{2}))?\s*[:\-]?\s*/i);
  if (tm) {
    const mon = tm[1] ? monthIndex(tm[1]) : null;
    const yr = tm[2] || tm[3];
    if (tm[1] && !mon && canonicalGenre(tm[1])) res.genre = res.genre || canonicalGenre(tm[1]);
    if (mon) res.termMonth = mon;
    if (mon && yr) res.term = `${yr}-${String(mon).padStart(2, '0')}`;
    s = s.slice(tm[0].length);
  }
  if (!res.genre && FIXED_GENRE[res.creator]) res.genre = FIXED_GENRE[res.creator];
  const p = parseName(s, { fix });
  res.edition = /\b(?:stl|3d print)\s*\+\s*bust\b/i.test(s) ? null : p.edition; // ZEZ "X STL + BUST" holds both
  res.isDiorama = p.isDiorama;
  res.character = p.character || titleCase(cleanStem(s).replace(/\s*[-:]\s*$/, ''));
  res.key = p.key || normKey(res.character, fix);
  return res;
}

/** "GOOGLE DRIVE WICKED MARVEL FEBRUARY TERM 2026" → { creator, genre, month, year, franchise } */
function parseDriveLabel(label) {
  const up = String(label || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = up.split(' ').filter(t => !['GOOGLE', 'DRIVE', 'TERM'].includes(t));
  let creator = null;
  const rest = [];
  let month = null, year = null, genre = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!creator && canonicalCreator(t)) { creator = canonicalCreator(t); continue; }
    if (/^20\d{2}$/.test(t)) { year = parseInt(t, 10); continue; }
    if (MONTHS.includes(t.toLowerCase())) { month = MONTHS.indexOf(t.toLowerCase()) + 1; continue; }
    if (t === 'VIDEO' && toks[i + 1] === 'GAMES') { genre = genre || 'Video Games'; i++; continue; }
    if (['MARVEL', 'DC', 'MOVIES'].includes(t)) { genre = genre || canonicalGenre(t); continue; }
    if (t === 'WILDCARD') { genre = genre || 'Wildcard'; continue; }
    rest.push(t);
  }
  return { creator, genre, month, year, franchise: rest.length ? titleCase(rest.join(' ').toLowerCase()) : '' };
}

module.exports = {
  CREATOR_ALIASES, STUDIO_OF, STUDIO_CREATORS, FIXED_GENRE, GENRES, SEED_FIXES, VARIANT_IDS, GENERIC_WORDS,
  canonicalCreator, studioOf, canonicalGenre, makeFixer, cleanStem, variantOf, parseName, parseProductName,
  parseDriveLabel, parseRelease, parseTermFolder, normKey, compactKey, stems, isGenericText, titleCase, monthIndex,
};
