'use strict';
/**
 * lib/works.js — layout detection and grouping of files into works (gallery cards).
 * docs/library-metadata.md §2–§5.
 *
 *   walkTree()      one pass over the library (special folders skipped)
 *   planWorks()     creator roots → studio / release / folder / tool layouts → works
 *   attributeWork() manifest / Drive / tracker / sidecar attribution of one work
 *   finalizeWorks() folder_path (deepest common folder, virtual "#slug" on collisions), libraries
 *
 * Pure apart from fs reads (walk, model.json sidecars). No DB access.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const naming = require('./naming');
const metaLib = require('./meta');
const { makeDiscovery, IGNORED_FOLDERS, isJunkFile, isPrintableName, isExtVariantName } = require('./discovery');

const SKIP_DIR = /^(?:_Inbox|_Duplicates_Pending_Delete|_Meta|#recycle|@eaDir|\..*)$/i; // + hidden ".Archive Service Temp…" 
// unfinished browser downloads are not files of a work
const PARTIAL_FILE = /\.(?:crdownload|part|partial|download|tmp)$|^Unconfirmed \d+|^\./i; // + dotfiles (.smbdelete…, ._x)
const TRANSPARENT = new Set(['_unsorted', '_dioramas', '_undated', '_bundles', 'wicked archive', 'gumroad downloads']);
const DEFAULT_CONTAINERS = { 'wicked archive': 'Wicked' };
const PASSTHROUGH_NAME = /^(gumroad|gumroad downloads?|downloads?|backups?|sync|syncthing|temp|tmp|unsorted|to[\s_-]?sort|imports?|stl[\s_-]?archive|3d[\s_-]?prints?|prints?|library)$/i;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const INFO_EXTS = new Set(['.txt', '.pdf', '.md', '.doc', '.docx', '.rtf']);
const ARCHIVE_RE = /\.(zip|rar|7z)$/i;
const EDITION_ORDER = ['Sculpture', 'Bust', 'Accessory', 'Diorama'];

// ── tree ─────────────────────────────────────────────────────────────────────

/**
 * Walk `root` once. Returns { root, dirs: Map(absDir → {dirs:[names], files:[{name,size,mtimeMs}]}),
 * fileCount, listDir(dir) } — listDir mimics fs.readdirSync(withFileTypes) for lib/discovery.
 */
function walkTree(root, { ignore, scope } = {}) {
  const dirs = new Map();
  // scope (per-creator rescan): walk only the folders above it (for the layout) and below it
  const wanted = (p) => !scope || p === scope || p.startsWith(scope + path.sep) || scope.startsWith(p + path.sep);
  let fileCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const node = { dirs: [], files: [] };
    dirs.set(dir, node);
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // deterministic grouping across platforms
    for (const e of ents) {
      if (IGNORED_FOLDERS.has(e.name) || isJunkFile(e.name)) continue;
      const full = path.join(dir, e.name);
      if (!e.isDirectory() && PARTIAL_FILE.test(e.name)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name) || (ignore && ignore.has(full))) continue;
        node.dirs.push(e.name);
        if (wanted(full)) stack.push(full);
      } else if (e.isFile()) {
        if (scope && !(dir === scope || dir.startsWith(scope + path.sep))) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        node.files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        fileCount++;
      } else if (e.isSymbolicLink()) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isFile()) { node.files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs }); fileCount++; }
        // symlinked directories are not followed (loops)
      }
    }
  }
  const cache = new Map();
  const listDir = (dir) => {
    let c = cache.get(dir);
    if (c) return c;
    const n = dirs.get(dir);
    c = n ? [
      ...n.dirs.map(name => ({ name, isDirectory: () => true })),
      ...n.files.map(f => ({ name: f.name, isDirectory: () => false })),
    ] : [];
    cache.set(dir, c);
    return c;
  };
  return { root, dirs, fileCount, listDir };
}

/** Every file at or below `dir`: [{ dir, name, size, mtimeMs, abs }] */
function filesUnder(tree, dir, skip) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    if (skip && d !== dir && skip(d)) continue;
    const n = tree.dirs.get(d);
    if (!n) continue;
    for (const f of n.files) out.push({ dir: d, name: f.name, size: f.size, mtimeMs: f.mtimeMs, abs: path.join(d, f.name) });
    for (const sd of n.dirs) stack.push(path.join(d, sd));
  }
  return out;
}

// ── creator roots ────────────────────────────────────────────────────────────

/**
 * Like scanner.resolveCreatorDirs, plus the layout rules: studio aliases and
 * containers start a studio subtree, `_Tools` is a tool root, transparent
 * containers are descended. Returns [{ type: 'studio'|'tools'|'regular', name, creator, path }].
 */
function resolveRoots(base, tree, { overrides = new Map(), containers = DEFAULT_CONTAINERS, log = () => {}, depth = 0 } = {}) {
  const node = tree.dirs.get(base);
  if (!node) return [];
  const out = [];
  for (const name of node.dirs) {
    const p = path.join(base, name);
    const ov = overrides.get(p);
    if (ov === 'ignore') { log('info', `Skipping "${name}" (manual override: ignore)`); continue; }
    const lower = name.trim().toLowerCase();
    const alias = naming.canonicalCreator(name);
    if (ov === 'creator') { out.push({ type: alias && naming.STUDIO_CREATORS.has(alias) ? 'studio' : 'regular', name, creator: alias || name, path: p }); continue; }
    if (ov === 'passthrough' && depth < 6) { out.push(...resolveRoots(p, tree, { overrides, containers, log, depth: depth + 1 })); continue; }
    if (alias && naming.STUDIO_CREATORS.has(alias)) { out.push({ type: 'studio', name, creator: alias, path: p }); continue; }
    if (containers[lower]) { out.push({ type: 'studio', name, creator: containers[lower], path: p, container: true }); continue; }
    if (lower === '_tools') { out.push({ type: 'tools', name: '_Tools', creator: '_Tools', path: p }); continue; }
    const child = tree.dirs.get(p) || { dirs: [], files: [] };
    const hasPrintable = child.files.some(f => isPrintableName(f.name));
    const transparent = TRANSPARENT.has(lower);
    const passthrough = !hasPrintable && child.dirs.length > 0 &&
      (transparent || PASSTHROUGH_NAME.test(name.trim()) ||
        (depth < 2 && child.dirs.length === 1 && !naming.parseRelease(child.dirs[0]))); // a creator with one release is still a creator
    if (passthrough && depth < 6) {
      log('info', `"${name}" looks like a container — descending to find creators inside it`);
      out.push(...resolveRoots(p, tree, { overrides, containers, log, depth: depth + 1 }));
    } else {
      out.push({ type: 'regular', name, creator: name, path: p });
    }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Damerau–Levenshtein (optimal string alignment) with an early exit above `max`. */
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'work';
const extOf = (n) => path.extname(n).toLowerCase();

/** "LeoOfColossus_Bust_v2" → "Leo Of Colossus Bust v2" */
function prettyName(s) {
  return String(s || '').replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+-\s+/g, ' - ').replace(/\s+/g, ' ').trim();
}
const CATEGORY_RE = /^(?:all\b.*|.*\b(?:enemies|heroes|allies|objects|props|busts|monsters|npcs|terrain|bases|minis|miniatures|characters|creatures|scenery|items|extras|bonus|models|files|stls?)\b.*|.*s)$/i;

/** Release item display name: no SKU prefix ("1528 - "), no support/variant words ("_Supports", "NoSupports"). */
function releaseItemName(label) {
  let s = prettyName(naming.cleanStem(label)).replace(/^\d{3,6}\s*-\s*/, '').replace(/^FN\d{4}[A-Z]{1,3}\d{1,3}[\s_-]+/i, '');
  s = s.replace(/\b(?:(?:pre|un|no|non)[\s-]*)?s[uo]p{1,2}o?r?t{1,2}(?:ed|s)?\b|\b(?:presupported|fdm|resin|ready\s*to\s*slice|lychee|lichee|chitubox|hollow|solid|beefed|slicer|\d+(?:[.,]\d+)?\s?mm)\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-_]+|[\s\-_]+$/g, '').trim();
  return s;
}

/** Legacy display name (keeps old folder-mode names stable). */
function inferModelName(folderPath) {
  return path.basename(folderPath).replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fileVariantFallback(name) {
  const e = extOf(name);
  if (IMAGE_EXTS.has(e)) return 'images';
  if (INFO_EXTS.has(e)) return 'info';
  return null;
}

/** Release-mode variant of a file from the variant folders between item and file: "32mm-supported". */
function releaseVariant(relSegs) {
  let scale = null, support = null;
  for (const seg of relSegs) {
    const s = seg.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/_/g, ' ');
    const mm = s.match(/(\d+(?:[.,]\d+)?)\s*mm\b/);
    if (mm && !scale) scale = `${mm[1]}mm`;
    const sc = s.match(/\b1[\s_:-](\d{1,2})(?:[\s_-]?scale)?\b/);
    if (sc && !scale) scale = `1-${sc[1]}`;
    if (/freescale/.test(s) && !scale) scale = 'freescale';
    if (!support || support === 'supported') { // "Supported/LYCHEE" → the more specific flavour
      if (!support && /\b(?:no[\s_-]*supports?|un[\s_-]*supported|non[\s_-]*supported)\b/.test(s)) support = 'unsupported';
      else if (/lychee|lichee/.test(s)) support = 'presupported-lychee';
      else if (/chitubox/.test(s)) support = 'presupported-chitubox';
      else if (!support && /\b(?:pre[\s_-]*)?supported\b|\bsupports?\b/.test(s)) support = 'supported';
    }
  }
  if (scale && support) return `${scale}-${support}`;
  return scale || support || null;
}

// ── studio layout ────────────────────────────────────────────────────────────

/**
 * One identity record per file of a studio subtree (Wicked, B3DSERK, SW3D, ZEZ,
 * Wicked Archive). §4: the first name, walking from the file up to the genre
 * folder, that parses to a non-generic character; sidecars win.
 */
function studioRecords(root, tree, ctx) {
  const { fix } = ctx;
  const P = ctx.parse;
  const recs = [];
  for (const f of filesUnder(tree, root.path, ctx.skipDir)) {
    if (f.name === 'model.json' || f.name === 'vault.json') continue;
    const rel = path.relative(root.path, f.dir);
    const relDirs = rel ? rel.split(path.sep) : [];
    // transparent containers and term folders ("MOVIES August Term 2024") carry no identity
    const segs = [];
    let termHint = null, genre = null;
    let accum = root.path;
    for (const name of relDirs) {
      accum = path.join(accum, name);
      const lower = name.trim().toLowerCase();
      if (TRANSPARENT.has(lower)) continue;
      const tf = naming.parseTermFolder(name);
      if (tf && P(name).generic) { termHint = termHint || tf.term; genre = genre || tf.genre; continue; }
      segs.push({ name, abs: accum });
    }
    if (segs.length && ctx.isGenre(segs[0].name)) genre = ctx.isGenre(segs.shift().name);
    else if (!genre && root.genre) genre = root.genre;

    const sc = ctx.sidecarFor(f.dir, root.path);
    const fp = P(f.name);
    const isArchive = ARCHIVE_RE.test(f.name);
    let anchor = null, anchorIdx = -1;
    const isImage = IMAGE_EXTS.has(extOf(f.name));
    if ((isArchive || (fp.prefixed && !isImage)) && fp.strong) { anchor = fp; anchorIdx = segs.length; }
    else {
      for (let i = segs.length - 1; i >= 0; i--) {
        const p = P(segs[i].name);
        if (p.strong) { anchor = p; anchorIdx = i; break; }
      }
    }
    // Diorama context: unbranded parts / sub-dioramas inside a diorama folder belong to it
    if (anchor) {
      for (let i = 0; i < Math.min(anchorIdx, segs.length); i++) {
        const d = P(segs[i].name);
        if (!d.isDiorama || d.generic || d === anchor) continue;
        const as = naming.stems(anchor.character, fix), ds = naming.stems(d.character, fix);
        if (as.size && [...as].every(x => ds.has(x)) && (anchor.isDiorama || !anchor.prefixed)) { anchor = d; anchorIdx = i; }
        break;
      }
    }
    let ident;
    if (anchor) {
      ident = { kind: anchor.isDiorama ? 'diorama' : 'work', character: anchor.character, key: anchor.key, edition: anchor.edition, creator: anchor.creator, prefixed: anchor.prefixed, strong: true, anchor: anchorIdx === segs.length ? f.abs : segs[anchorIdx].abs };
    } else {
      // the deepest meaningful folder with no part/variant folder above it
      // (Galactus/Chitubox/50/Head/Head_2_Op/x.chitubox → Galactus)
      let weakEd = null, w = null, wIdx = -1;
      for (let i = 0; i < segs.length; i++) {
        const p = P(segs[i].name);
        if (p.generic) { if (p.edition) weakEd = p.edition; if (w) break; continue; }
        w = p; wIdx = i;
      }
      if (!w && !fp.generic && fp.key && (isArchive || isPrintableName(f.name))) w = fp;
      if (w) {
        ident = { kind: weakEd === 'Diorama' ? 'diorama' : 'work', character: w.character, key: w.key, edition: weakEd, creator: null, prefixed: false, strong: false, anchor: wIdx >= 0 ? segs[wIdx].abs : f.abs };
      } else {
        // nothing identifies it (a stray info file in a genre folder): one "misc" card per folder
        const label = `${genre || root.creator} misc`;
        ident = { kind: 'work', character: naming.titleCase(label), key: naming.normKey(label, fix), edition: weakEd, creator: null, prefixed: false, strong: false, misc: true, anchor: f.dir };
      }
    }
    if (sc) {
      const ed = sc.type ? (/diorama/i.test(sc.type) ? 'Diorama' : /bust/i.test(sc.type) ? 'Bust' : /access/i.test(sc.type) ? 'Accessory' : /sculpt|statue/i.test(sc.type) ? 'Sculpture' : ident.edition) : ident.edition;
      const ch = sc.character || ident.character;
      ident = { ...ident, kind: ed === 'Diorama' ? 'diorama' : 'work', character: ch, key: naming.normKey(ch, fix), edition: ed, creator: naming.canonicalCreator(sc.creator) || sc.creator || ident.creator, strong: true, prefixed: true, sidecar: sc };
      if (sc.genre) genre = sc.genre;
    }

    // Variant: the file's own name, then folders up to the anchor, then by extension
    let variant = fp.variant;
    for (let i = segs.length - 1; !variant && i >= Math.max(0, anchorIdx); i--) variant = P(segs[i].name).variant;
    variant = variant || fileVariantFallback(f.name) || 'other';

    // Group: the first non-generic, non-identity folder above the anchor
    let group = null, tName = null;
    const limit = anchor ? Math.min(anchorIdx, segs.length) : segs.length;
    for (let i = 0; i < limit; i++) {
      const p = P(segs[i].name);
      if (p.generic || p.strong) continue;
      if (i === 0) tName = segs[i].name;
      if (p.key && p.key !== ident.key && !group) group = { name: segs[i].name, key: p.key, abs: segs[i].abs };
    }
    if (!tName && segs.length && !(anchor && anchorIdx === 0)) {
      const p0 = P(segs[0].name);
      if (!p0.generic && !p0.strong) tName = segs[0].name;
    }
    recs.push({
      ...f, root: root.path, rootCreator: root.creator, container: !!root.container, genre, termHint, ident, variant,
      edition: ident.edition, scope: `${root.path}|${genre || ''}|${tName || ''}`, tName, group,
      segNames: segs.map(sg => sg.name), // folders below the genre: release year / qualifier tokens
    });
  }
  return recs;
}

/** Cross-root canonicalisation of studio identities, then works. */
function studioWorks(recs, ctx) {
  const { fix } = ctx;
  const P = ctx.parse;

  // 1. creator for unbranded names: a branded sibling with the same key in the same root, then the root's creator
  const branded = new Map(); // root|key → creator counts
  for (const r of recs) {
    if (!r.ident.creator) continue;
    const k = `${r.root}|${r.ident.key}`;
    const m = branded.get(k) || new Map();
    m.set(r.ident.creator, (m.get(r.ident.creator) || 0) + 1);
    branded.set(k, m);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const r of recs) {
    if (r.ident.creator) continue;
    const m = branded.get(`${r.root}|${r.ident.key}`);
    if (m) { r.ident.creator = top(m); continue; }
    // a container (Wicked Archive) holds several creators: the manifest knows who made it
    if (r.container && r.genre) {
      const owner = Object.keys(naming.FIXED_GENRE).find(c => naming.FIXED_GENRE[c] === r.genre);
      if (owner) { r.ident.creator = owner; continue; } // Wicked Archive/Star Wars holds SW3D's files
    }
    r.ident.creator = r.rootCreator;
  }

  // 2. weak names that match a diorama of the same creator join it
  const dioKeys = new Set(recs.filter(r => r.ident.kind === 'diorama').map(r => `${r.ident.creator}|${r.ident.key}`));
  for (const r of recs) {
    if (r.ident.kind === 'work' && !r.ident.strong && dioKeys.has(`${r.ident.creator}|${r.ident.key}`)) r.ident = { ...r.ident, kind: 'diorama' };
  }

  // 3. superset names inside a character folder ("Green Goblin Bomb" in Green Goblin/, "Home Alone Kevin" in Home Alone/)
  const byScope = new Map();
  for (const r of recs) {
    if (!r.tName) continue;
    if (!byScope.has(r.scope)) byScope.set(r.scope, []);
    byScope.get(r.scope).push(r);
  }
  for (const list of byScope.values()) {
    const t = P(list[0].tName);
    if (!t.key || t.generic) continue;
    const tWords = new Set(t.key.split(' '));
    const tStems = naming.stems(t.character, fix);
    if (!tStems.size) continue;
    const anchors = new Map(); // key → Set(anchor) (distinct names, not files)
    const charOf = new Map();
    for (const r of list) {
      if (r.ident.kind !== 'work' || r.ident.sidecar) continue;
      if (!anchors.has(r.ident.key)) anchors.set(r.ident.key, new Set());
      anchors.get(r.ident.key).add(r.ident.anchor);
      if (!charOf.has(r.ident.key) || r.ident.strong) charOf.set(r.ident.key, r.ident.character);
    }
    const supersets = [...anchors.keys()].filter(k => {
      if (k === t.key) return false;
      const ks = naming.stems(k, fix);
      return ks.size > tStems.size && [...tStems].every(x => ks.has(x));
    });
    const others = [...anchors.entries()].filter(([k]) => !supersets.includes(k) && k !== t.key).map(([, s]) => s.size);
    const tCount = anchors.has(t.key) ? anchors.get(t.key).size : 0;
    const dominant = tCount > 0 && tCount >= Math.max(0, ...others);
    const remap = new Map();
    // Abbreviations inside a character folder (ZEZ: "Wolv" in Wolverine/, "BWL" in Batman Who Laughs/)
    const tInitials = t.key.split(' ').map(x => x[0]).join('');
    for (const k of anchors.keys()) {
      if (k === t.key || supersets.includes(k)) continue;
      const c = k.replace(/\s+/g, '');
      // an unbranded short name inside a single-character folder ("Croc" in Killer Croc/, "Leia" in Princess Leia/)
      const ks = naming.stems(k, fix);
      const multi = /\b(?:and|vs?|&|plus)\b|\+/i.test(list[0].tName);
      const unbranded = list.every(r => r.ident.key !== k || !r.ident.prefixed);
      if (!multi && unbranded && ks.size && ks.size < tStems.size && [...ks].every(x => tStems.has(x))) { remap.set(k, { key: t.key, character: charOf.get(t.key) || t.character }); continue; }
      const w0 = t.key.split(' ')[0];
      if (c.length >= 3 && ((c.length < w0.length && w0.startsWith(c)) || (c === tInitials && t.key.includes(' ')))) remap.set(k, { key: t.key, character: charOf.get(t.key) || t.character });
    }
    for (const k of supersets) {
      const rest = k.split(' ').filter(w => !tWords.has(w)).join(' ');
      if (rest && anchors.has(rest) && !supersets.includes(rest)) remap.set(k, { key: rest, character: charOf.get(rest) });
      else if (!rest || naming.isGenericText(rest) || dominant) remap.set(k, { key: t.key, character: charOf.get(t.key) || t.character });
    }
    for (const r of list) {
      const to = r.ident.kind === 'work' && !r.ident.sidecar && remap.get(r.ident.key);
      if (to) r.ident = { ...r.ident, key: to.key, character: to.character };
    }
  }

  // 4. typo-level merges per creator + kind: same compact key, or one edit apart (long names)
  const groups = new Map(); // creator|kind → Map(key → count)
  for (const r of recs) {
    const g = `${r.ident.creator}|${r.ident.kind}`;
    if (!groups.has(g)) groups.set(g, new Map());
    const m = groups.get(g);
    m.set(r.ident.key, (m.get(r.ident.key) || 0) + (r.ident.strong ? 2 : 1));
  }
  const canon = new Map(); // creator|kind|key → key
  for (const [g, counts] of groups) {
    const keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.length - b.length || a.localeCompare(b));
    const chosen = []; // [{ key, compact }]
    const byCompact = new Map();
    for (const k of keys) {
      const c = k.replace(/\s+/g, '');
      let target = byCompact.get(c);
      if (!target && c.length >= 6) {
        for (const ch of chosen) {
          if (Math.abs(ch.compact.length - c.length) > 1 || ch.compact.length < 6) continue;
          if ((c.match(/\d+/g) || []).join(',') !== (ch.compact.match(/\d+/g) || []).join(',')) continue; // "Iron Man 2023" ≠ "Iron Man 2025"
          if (editDistance(ch.compact, c, 1) <= 1) { target = ch.key; break; }
        }
      }
      if (!target) { target = k; chosen.push({ key: k, compact: c }); byCompact.set(c, k); }
      canon.set(`${g}|${k}`, target);
    }
  }

  // 5. works
  const works = new Map();
  for (const r of recs) {
    const g = `${r.ident.creator}|${r.ident.kind}`;
    const key = canon.get(`${g}|${r.ident.key}`) || r.ident.key;
    const wk = `${r.ident.creator}|${r.ident.kind}|${key}`;
    let w = works.get(wk);
    if (!w) {
      w = { key: wk, kind: r.ident.kind, layout: 'studio', creator: r.ident.creator, studio: naming.studioOf(r.ident.creator), files: [], names: new Map(), genres: new Map(), groups: new Map(), terms: new Map(), sidecar: null, roots: new Map() };
      works.set(wk, w);
    }
    w.files.push({ abs: r.abs, name: r.name, size: r.size, mtimeMs: r.mtimeMs, dir: r.dir, variant: r.variant, edition: r.ident.kind === 'diorama' ? 'Diorama' : r.edition,
      segs: r.segNames || [], scTerm: r.ident.sidecar && r.ident.sidecar.release_term ? r.ident.sidecar.release_term : null, termHint: r.termHint || null });
    const weight = (r.ident.sidecar ? 100 : 0) + (r.ident.prefixed ? 3 : 0) + (r.ident.strong ? 2 : 1);
    w.names.set(r.ident.character, (w.names.get(r.ident.character) || 0) + weight);
    if (r.genre) w.genres.set(r.genre, (w.genres.get(r.genre) || 0) + 1);
    if (r.group && r.group.key !== key) {
      const gn = naming.titleCase(prettyName(r.group.name));
      const g = w.groups.get(gn) || { n: 0, abs: new Set() };
      g.n++; g.abs.add(r.group.abs);
      w.groups.set(gn, g);
    }
    if (r.termHint) w.terms.set(r.termHint, (w.terms.get(r.termHint) || 0) + 1);
    if (r.ident.sidecar && !w.sidecar) w.sidecar = r.ident.sidecar;
    w.roots.set(r.root, (w.roots.get(r.root) || 0) + 1);
    if (r.ident.misc) w.misc = true;
  }
  const best = (m) => (m.size ? [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0] : null);
  for (const w of works.values()) {
    w.character = best(w.names);
    w.name = w.character;
    w.pathGenre = best(w.genres);
    // group: chosen in finalizeWorks, once the work's folder is known (only a folder holding it counts)
    w.groupCandidates = [...w.groups.entries()]
      .filter(([name]) => {
        // "Cap Marvel" is Captain Marvel's own folder, not a group
        const gs = naming.stems(name, fix), cs = [...naming.stems(w.character, fix)];
        const covered = gs.size && [...gs].every(x => cs.some(y => y.startsWith(x) || x.startsWith(y)));
        return !(naming.normKey(name, fix) === naming.normKey(w.character, fix) || covered);
      })
      .map(([name, g]) => ({ name, n: g.n, abs: [...g.abs] }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    w.group = null;
    w.termHint = best(w.terms);
    const eds = new Set(w.files.map(f => f.edition).filter(Boolean));
    w.editions = EDITION_ORDER.filter(e => eds.has(e));
    delete w.names; delete w.genres; delete w.groups; delete w.terms;
  }
  return [...works.values()];
}

// ── folder / release / tool layouts ──────────────────────────────────────────

/** Works for a non-studio creator root: release packs (§3.2) and folder discovery (§3.3). */
function folderWorks(root, tree, ctx) {
  const disc = makeDiscovery({ listDir: tree.listDir, extended: true });
  const isRelease = (abs, name) => !!naming.parseRelease(name);
  const releases = [];
  const collectReleases = (dir, depth) => {
    if (depth > 6) return;
    const n = tree.dirs.get(dir);
    if (!n) return;
    for (const d of n.dirs) {
      const p = path.join(dir, d);
      if (ctx.overrides.get(p) === 'ignore') continue;
      if (isRelease(p, d)) releases.push(p); else collectReleases(p, depth + 1);
    }
  };
  const kind = root.type === 'tools' ? 'tool' : 'model';
  collectReleases(root.path, 0);
  // A creator that publishes dated packs (Loot Studios, Lord of the Print): its other pack folders
  // ("Loxwort Academy", "_Undated/<Title>", "_Bundles/<Title>") are undated releases.
  if (kind === 'model' && releases.some(r => path.dirname(r) === root.path)) {
    const top = tree.dirs.get(root.path);
    for (const d of top ? top.dirs : []) {
      const p = path.join(root.path, d);
      if (releases.includes(p) || ctx.overrides.get(p) === 'ignore') continue;
      if (releases.some(r => r.startsWith(p + path.sep))) continue; // holds dated releases ("Pre-Supported (thick)/#41 - …")
      // "_Undated/<Title>", "SupportedFiles/<Title>": the container is transparent, its folders are the packs
      const container = /^_(undated|bundles)$/i.test(d) || isExtVariantName(d) || /^(?:pre[\s_-]?)?supported\s*files$|^unsupported(?:\s*files)?$/i.test(prettyName(d));
      const kids = container ? (tree.dirs.get(p)?.dirs || []).map(k => path.join(p, k)) : [p];
      for (const k of kids) {
        const n = tree.dirs.get(k);
        if (n && n.dirs.length && !n.files.some(f => isPrintableName(f.name))) releases.push(k); // packs only: folders of items
      }
    }
  }
  const releaseSet = new Set(releases);
  const models = disc.discoverModelFolders(root.path, '', 5, ctx.overrides, { boundary: (abs) => releaseSet.has(abs) })
    .map(m => ({ ...m, kind, release: null }));
  for (const rel of releases) {
    const info = naming.parseRelease(path.basename(rel))
      || { term: null, label: (releaseItemName(path.basename(rel)) || prettyName(path.basename(rel))).replace(/^myairbridge-/i, ''), number: null, undated: true };
    const items = disc.discoverModelFolders(rel, '', 7, ctx.overrides);
    // A release folder with loose packs is itself an item (the delivered zips)
    const relNode = tree.dirs.get(rel);
    if (relNode && relNode.files.some(f => isPrintableName(f.name)) && !items.some(i => i.fullPath === rel)) items.unshift({ name: '', fullPath: rel, variantDirs: [] });
    for (const it of items) models.push({ ...it, kind: kind === 'tool' ? 'tool' : 'release-item', release: { path: rel, ...info } });
  }

  // File ownership: the deepest discovered folder that contains the file
  const owners = new Map(models.map(m => [m.fullPath, m]));
  const works = new Map();
  for (const m of models) {
    const skip = (d) => d !== m.fullPath && owners.has(d);
    const files = filesUnder(tree, m.fullPath, skip).filter(f => f.name !== 'model.json');
    if (!files.length) continue;
    let name, key, group = null;
    const base = path.basename(m.fullPath);
    if (m.release) {
      const relKey = naming.normKey(releaseItemName(m.release.label) || m.release.label, ctx.fix) || slugify(m.release.label);
      const isRoot = m.fullPath === m.release.path;
      let label = isRoot ? m.release.label : base;
      if (!isRoot && naming.isGenericText(label)) {
        // "All_Busts_v2/STL" style: name after the nearest meaningful folder
        let d = path.dirname(m.fullPath);
        while (d.length > m.release.path.length && naming.isGenericText(path.basename(d))) d = path.dirname(d);
        label = d.length > m.release.path.length ? path.basename(d) : m.release.label;
      }
      name = releaseItemName(label) || m.release.label;
      // "All Objects" / "All Busts" / "Env" say what kind of items, not which: name after the pack or folder above
      if (!isRoot && (/^all\b/i.test(name) || /^(?:env|environment|objects?|props?|busts?|heroes|enemies|allies|npcs?|scenery|terrain|bonus|extras?|minis)$/i.test(name))) {
        let d = path.dirname(m.fullPath), up = '';
        while (d.length > m.release.path.length) { const pn = releaseItemName(path.basename(d)); if (pn && !/^all\b/i.test(pn) && !naming.isGenericText(pn)) { up = pn; break; } d = path.dirname(d); }
        name = `${up || releaseItemName(m.release.label) || m.release.label} ${name.replace(/^all\s+/i, '')}`.trim();
      }
      // parent category (Supported/Thrikeen_Supports/Sword_Idle_Supports ≡ Unsupported/Thrikeen/Sword_Idle)
      let parent = '';
      if (!isRoot) {
        let d = path.dirname(m.fullPath);
        while (d.length > m.release.path.length) {
          const pn = releaseItemName(path.basename(d));
          if (pn && !naming.isGenericText(pn)) { parent = pn; break; }
          d = path.dirname(d);
        }
      }
      const pk = parent ? naming.normKey(parent, ctx.fix) : '';
      if (parent && !CATEGORY_RE.test(parent) && !naming.normKey(name, ctx.fix).includes(pk.split(' ')[0].slice(0, 5))) {
        group = parent;
        if (parent.split(' ').length <= 2) name = `${parent} ${name}`;
      } else if (parent) group = parent;
      key = `${root.creator}|${kind === 'tool' ? 'tool' : 'release-item'}|${relKey}/${pk ? pk + '/' : ''}${naming.normKey(name, ctx.fix) || slugify(name)}`;
    } else {
      name = inferModelName(m.fullPath);
      if (naming.isGenericText(name)) {
        let d = path.dirname(m.fullPath);
        while (d.length > root.path.length && naming.isGenericText(path.basename(d))) d = path.dirname(d);
        const parentName = d.length > root.path.length ? inferModelName(d) : root.name;
        name = `${parentName} ${name}`.trim();
      }
      key = `${root.creator}|${kind}|${path.relative(root.path, m.fullPath).toLowerCase() || '.'}`;
    }
    let w = works.get(key);
    if (!w) {
      w = { key, kind: m.kind, layout: m.release ? 'release' : (kind === 'tool' ? 'tool' : 'folder'), creator: root.creator, studio: null, name, character: null, group, editions: [], files: [], folders: [], sidecar: null, roots: new Map([[root.path, 0]]) };
      if (m.release) { w.termHint = m.release.term; w.releaseLabel = m.release.label; }
      works.set(key, w);
    }
    w.folders.push(m.fullPath);
    for (const f of files) {
      const relSegs = path.relative(m.release ? m.release.path : m.fullPath, f.dir).split(path.sep).filter(Boolean);
      const v = releaseVariant(relSegs);
      w.files.push({ abs: f.abs, name: f.name, size: f.size, mtimeMs: f.mtimeMs, dir: f.dir, variant: v || fileVariantFallback(f.name) || 'other', edition: null });
      w.roots.set(root.path, (w.roots.get(root.path) || 0) + 1);
    }
    // Plain folder models: the first folder below the creator is a franchise only when it is a
    // known genre (Marvel, DC, …, genre_map); release packs and tools never get one from the path
    if (!m.release && kind === 'model') {
      const relParts = path.relative(root.path, m.fullPath).split(path.sep).filter(Boolean);
      w.pathGenre = relParts.length >= 2 ? ctx.isGenre(relParts[0]) : null;
      w.pathTeam = w.pathGenre && relParts.length >= 3 ? relParts[1] : null;
    }
    const sc = ctx.sidecarFor(m.fullPath, root.path);
    if (sc && !w.sidecar) w.sidecar = sc;
  }
  return [...works.values()];
}

// ── planning ─────────────────────────────────────────────────────────────────

/**
 * Build every work under `libraryPath`.
 * @param {object} opts { libraryPath, tree, meta, overrides, log, scope? (only roots under this path) }
 */
function planWorks({ libraryPath, tree, meta, overrides = new Map(), log = () => {}, scope = null, containers, aliases = null }) {
  const fix = meta?.fix || naming.makeFixer();
  const parseCache = new Map();
  const parse = (name) => { let p = parseCache.get(name); if (!p) { p = naming.parseName(name, { fix }); parseCache.set(name, p); } return p; };
  const genreSet = new Map(naming.GENRES.map(g => [g.toLowerCase(), g]));
  if (meta) {
    for (const g of meta.genreMap.values()) genreSet.set(g.toLowerCase(), g);
    for (const g of Object.values(meta.rules.genre || {})) genreSet.set(String(g).toLowerCase(), g);
    for (const g of Object.values(meta.rules.guess || {})) genreSet.set(String(g).toLowerCase(), g);
  }
  const isGenre = (name) => naming.canonicalGenre(name) || genreSet.get(String(name).trim().toLowerCase()) || null;
  const sidecarCache = new Map();
  let sidecars = 0;
  const sidecarErrors = [];
  const sidecarFor = (dir, stop) => {
    let d = dir;
    for (;;) {
      if (sidecarCache.has(d)) { const v = sidecarCache.get(d); if (v) return v; }
      else {
        const n = tree.dirs.get(d);
        const v = n && n.files.some(f => f.name === 'model.json') ? metaLib.readSidecar(path.join(d, 'model.json'), sidecarErrors) : null;
        if (v) sidecars++;
        sidecarCache.set(d, v);
        if (v) return v;
      }
      if (d === stop || d.length <= stop.length) return null;
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  const skipDir = (d) => overrides.get(d) === 'ignore';
  const ctx = { fix, parse, isGenre, sidecarFor, meta, overrides, skipDir };
  const cont = { ...DEFAULT_CONTAINERS };
  for (const c of containers || []) if (c && c.name) cont[String(c.name).toLowerCase()] = c.creator || 'Wicked';
  if (Array.isArray(meta?.vault?.containers)) for (const c of meta.vault.containers) { if (typeof c === 'string') cont[c.toLowerCase()] = 'Wicked'; else if (c && c.name) cont[c.name.toLowerCase()] = c.creator || 'Wicked'; }
  if (meta?.vault?.studioAliases && typeof meta.vault.studioAliases === 'object') for (const [a, c] of Object.entries(meta.vault.studioAliases)) {
    if (typeof c !== 'string') continue; naming.CREATOR_ALIASES[a.toLowerCase()] = c; naming.STUDIO_CREATORS.add(c); }

  let roots = resolveRoots(libraryPath, tree, { overrides, containers: cont, log });
  if (scope) roots = roots.filter(r => r.path === scope || r.path.startsWith(scope + path.sep) || scope.startsWith(r.path + path.sep));
  const recs = [];
  const works = [];
  for (const r of roots) {
    if (r.type === 'studio') recs.push(...studioRecords(r, tree, ctx));
    else works.push(...folderWorks(r, tree, ctx).map(w => ({ ...w, creatorFolder: r.path })));
  }
  works.push(...studioWorks(recs, ctx));
  const joined = applyAliases(works, aliases);
  if (joined.length !== works.length) log('info', `Aliases (confirmed merges) joined ${works.length - joined.length} card(s)`);
  // after aliases: a confirmed merge never collapses two releases of a character
  const merged = splitReleases(joined, meta);
  if (merged.length !== joined.length) log('info', `Releases: ${merged.length - joined.length} more card(s) for characters released more than once`);
  if (meta) { meta.sidecars = sidecars; meta.sidecarErrors = sidecarErrors; }
  // Root folder per creator (for the creators table)
  const creatorFolders = new Map();
  for (const r of roots) if (!creatorFolders.has(r.creator)) creatorFolders.set(r.creator, r.path);
  return { works: merged, roots, creatorFolders, sidecars, sidecarErrors };
}

// ── releases (one card per release of a character) ───────────────────────────

const PRINTABLE_RE = /\.(zip|rar|7z|stl|obj|3mf|lys|lychee|chitubox|ctb|cbddlp|photon|pwmx|goo|blend|ztl)$/i;
const YEAR_TOKEN = /(?:^|[^0-9a-z])(20[12]\d)(?![0-9])/i;
const QUALIFIER = /\b(netflix|mcu|classic|comics?|chibi|v ?[2-9]|version ?[2-9])\b/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// words in product names that say nothing about WHICH release (store, genre, edition, accessory, filler)
const PRODUCT_FILLER = new Set(['wicked', 'b3dserk', 'sw3d', 'zez', 'star', 'wars', '3d', 'models', 'marvel', 'dc', 'movies', 'movie', 'tv', 'video', 'games', 'game',
  'anime', 'horror', 'comic', 'other', 'wildcard', 'christmas', 'sculpture', 'sculptures', 'statue', 'bust', 'busts', 'portrait', 'diorama', 'complete',
  'base', 'accessory', 'accessories', 'term', 'tested', 'and', 'ready', 'for', 'printing', 'print', 'stl', 'stls', 'the', 'of', 'a', 'version', 'update',
  'updated', 'new', 'special', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'pack', 'swag', 'files', 'file', 'model', 'studios', 'studio', 'scale', 'lightsaber', 'lightsabers', 'saber', 'sabers', 'blaster', 'rifle', 'weapon', 'weapons',
  'helmet', 'hammer', 'shield', 'stand', 'logo', 'sword', 'gun', 'pistol', 'blastech', 'dl', 'mm', 'parts', 'piece', 'one', 'pre', 'supported', 'only']);

function qualifierId(text) {
  // a bare "V2" / "Comic" folder is a part variant, not a release: the qualifier must sit in a name
  if (String(text || '').trim().split(/[\s_-]+/).filter(Boolean).length < 2) return null;
  const m = String(text || '').match(QUALIFIER);
  if (!m) return null;
  const q = m[1].toLowerCase().replace(/\s+/g, '');
  if (/^comics?$/.test(q)) return 'comic';
  if (/^(v|version)\d$/.test(q)) return `v${q.slice(-1)}`;
  return q;
}
function yearId(text) {
  const m = naming.cleanStem(String(text || '')).match(YEAR_TOKEN);
  return m ? m[1] : null;
}

/**
 * Release signal of a manifest product: an explicit one (its term, a year or a version qualifier in
 * its name) or the words left once store, genre, edition, accessory and character words are gone
 * ("tobey", "andrew garfield"; "base" when nothing is left).
 */
function productRelease(prod, workKey, fix) {
  if (prod.term) return { id: prod.term, explicit: true };
  const y = yearId(prod.name);
  if (y) return { id: y, explicit: true };
  const q = qualifierId(prod.name);
  if (q) return { id: q, explicit: true };
  const charToks = String(workKey).split(' ').filter(Boolean);
  // the character's own words, their stems and typos ("octupu" in Doctor Octopus) — not compounds ("spiderverse")
  const near = (t) => charToks.some(c => c === t || c.startsWith(t) || (t.startsWith(c) && t.length - c.length <= 2)
    || (t.length >= 5 && Math.abs(c.length - t.length) <= 2 && editDistance(c, t, 2) <= 2));
  const left = naming.normKey(prod.name, fix).split(' ').filter(t => t && t.length > 1 && !PRODUCT_FILLER.has(t) && !near(t) && !/^\d+(mm)?$/.test(t));
  return { id: left.length ? left.slice(0, 3).join('-') : 'base', explicit: false };
}

function releaseLabel(id, siblings) {
  if (id === 'base') return null;
  const m = id.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const sameYear = siblings.filter(s => s !== id && s.slice(0, 4) === m[1]).length;
    return sameYear ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
  }
  if (/^\d{4}$/.test(id)) return id;
  if (id === 'mcu') return 'MCU';
  if (/^v\d$/.test(id)) return `V${id.slice(1)}`;
  return id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Split a studio work into one card per release when the creator released the character more
 * than once (Daredevil Netflix vs Daredevil March 2026 Term; Captain Marvel and Captain Marvel 2025).
 *
 * Per file, best signal first: model.json release_term; the matched manifest product (exact/size
 * match to a product of this character and studio); the Drive term of the file; a year (2010-2029)
 * or version qualifier (v2, Netflix, MCU, Comic, Classic, Chibi) in an archive name or a folder
 * below the genre. A folder's strong majority speaks for its unmatched files; files without any
 * signal join the release sharing their deepest folder, else the biggest.
 * Then: a year joins the term of that year (2024 + 2024-05); product leftovers of one release
 * agree (Sculpture product + Bust product, "tom" ⊂ "tom holland"); implicit releases whose editions
 * don't overlap are one release (Yoda + Yoda Lightsaber); an implicit release with fewer than two
 * printable files is not one. Two or more remaining releases with printable files → one card each,
 * keyed "<key>|r:<release id>". Sculpture + Bust of one release stay together; dioramas never split.
 */
function splitReleases(works, meta) {
  const fix = (meta && meta.fix) || naming.makeFixer();
  const out = [];
  const depth = (a, b) => { const x = a.split(path.sep), y = b.split(path.sep); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };
  const printable = (fs) => fs.filter(f => PRINTABLE_RE.test(f.name)).length;
  for (const w of works) {
    if (w.layout !== 'studio' || w.kind !== 'work' || w.files.length < 2) { out.push(w); continue; }
    const wkey = String(w.key).split('|').slice(2).join('|');
    const wToks = new Set(wkey.split(' ').filter(t => t.length >= 3));
    const family = (c) => naming.studioOf(c) || c;
    const strong = new Map(); // file → { id, explicit }
    for (const f of w.files) {
      if (f.scTerm) { strong.set(f, { id: f.scTerm, explicit: true }); continue; }
      if (!meta || IMAGE_EXTS.has(extOf(f.name))) continue;
      const m = metaLib.matchFile(meta, f.name, f.size, { creator: w.creator, character: w.character, edition: f.edition });
      if (m && (m.by === 'exact' || m.by === 'size') && m.product.key && m.product.key.split(' ').some(t => wToks.has(t)) && family(m.product.creator) === family(w.creator)) {
        strong.set(f, productRelease(m.product, wkey, fix)); continue;
      }
      const d = metaLib.driveForFile(meta, f.name);
      if (d && d.term) strong.set(f, { id: d.term, explicit: true });
    }
    const byDir = new Map();
    for (const f of w.files) { if (!byDir.has(f.dir)) byDir.set(f.dir, []); byDir.get(f.dir).push(f); }
    const dirRelease = new Map();
    for (const [dir, files] of byDir) {
      const c = new Map();
      for (const f of files) if (strong.has(f)) { const s = strong.get(f); const e = c.get(s.id) || { s, n: 0 }; e.n++; c.set(s.id, e); }
      if (c.size) { dirRelease.set(dir, [...c.values()].sort((a, b) => b.n - a.n || a.s.id.localeCompare(b.s.id))[0].s); continue; }
      const segs = files[0].segs || [];
      let id = null;
      for (let i = segs.length - 1; i >= 0 && !id; i--) id = yearId(segs[i]) || qualifierId(segs[i]);
      if (!id && files[0].termHint) id = files[0].termHint;
      if (id) dirRelease.set(dir, { id, explicit: true, fromName: true });
    }
    const groups = new Map(); // id → { id, explicit, files }
    const unassigned = [];
    for (const f of w.files) {
      let s = strong.get(f) || null;
      const dirS = dirRelease.get(f.dir) || null;
      // the folder's matched files outrank a year in one archive name; that outranks the folder name
      if (!s && dirS && !dirS.fromName) s = dirS;
      if (!s && ARCHIVE_RE.test(f.name)) { const id = yearId(f.name) || qualifierId(f.name); if (id) s = { id, explicit: true }; }
      if (!s) s = dirS;
      if (!s) { unassigned.push(f); continue; }
      if (!groups.has(s.id)) groups.set(s.id, { id: s.id, explicit: s.explicit, files: [] });
      const g = groups.get(s.id);
      g.explicit = g.explicit || s.explicit;
      g.files.push(f);
    }
    if (groups.size < 2) { out.push(w); continue; }
    const mergeInto = (from, to) => { to.files.push(...from.files); to.explicit = to.explicit || from.explicit; groups.delete(from.id); };
    const eds = (g) => new Set(g.files.map(f => f.edition).filter(Boolean));
    // a year joins the term of that year, else of the next (a "Daredevil v Kingpin 2025" folder
    // holds the January 2026 Term release)
    for (const g of [...groups.values()]) {
      if (!/^\d{4}$/.test(g.id)) continue;
      const termOf = (y) => [...groups.values()].filter(t => t.id.startsWith(`${y}-`)).sort((a, b) => b.files.length - a.files.length)[0];
      const t = termOf(g.id) || termOf(String(Number(g.id) + 1));
      if (t) mergeInto(g, t);
    }
    // implicit releases: "tom" ⊂ "tom-holland", "verse" ⊂ "spiderverse", "pepper-pots" ≈ "pepper-potts"
    for (const g of [...groups.values()]) {
      if (g.explicit || g.id === 'base' || !groups.has(g.id)) continue;
      const c = g.id.replace(/-/g, '');
      const sup = [...groups.values()].filter(t => {
        if (t === g || t.explicit || t.id === 'base') return false;
        const d = t.id.replace(/-/g, '');
        return d.includes(c) || (Math.abs(d.length - c.length) <= 2 && Math.min(c.length, d.length) >= 6 && editDistance(c, d, 2) <= 2);
      });
      if (sup.length === 1) mergeInto(g, sup[0]);
    }
    // implicit releases whose editions don't overlap are one release (Sculpture product + Bust product)
    for (let changed = true; changed;) {
      changed = false;
      const imp = [...groups.values()].filter(g => !g.explicit).sort((a, b) => b.files.length - a.files.length);
      for (let i = 0; i < imp.length && !changed; i++) for (let j = i + 1; j < imp.length && !changed; j++) {
        const a = eds(imp[i]), b = eds(imp[j]);
        if (![...a].some(e => b.has(e))) { mergeInto(imp[j], imp[i]); changed = true; }
      }
    }
    // a release needs two printable files of its own; an implicit one more than accessories
    for (const g of [...groups.values()]) {
      const ge = eds(g);
      const onlyExtras = !ge.size || [...ge].every(e => e === 'Accessory');
      // (explicit ones too: one archive with a year in a folder of another release is a stray)
      if (groups.size < 2 || (printable(g.files) >= 2 && (g.explicit || !onlyExtras))) continue;
      const others = [...groups.values()].filter(t => t !== g);
      const best = others.sort((a, b) => Math.max(...b.files.map(x => Math.max(...g.files.map(y => depth(x.dir, y.dir))))) - Math.max(...a.files.map(x => Math.max(...g.files.map(y => depth(x.dir, y.dir))))) || b.files.length - a.files.length)[0];
      mergeInto(g, best);
    }
    // files without a signal: the release sharing the deepest folder, then the biggest
    for (const f of unassigned) {
      let best = null, bd = -1, bn = -1;
      for (const g of groups.values()) {
        const d = Math.max(...g.files.map(x => depth(x.dir, f.dir)));
        if (d > bd || (d === bd && g.files.length > bn)) { best = g; bd = d; bn = g.files.length; }
      }
      best.files.push(f);
    }
    // a release with no printable file (only renders or an info txt) is not a release
    const real = [...groups.values()].filter(g => printable(g.files) > 0).sort((a, b) => printable(b.files) - printable(a.files) || a.id.localeCompare(b.id));
    if (real.length < 2) { out.push(w); continue; }
    for (const g of groups.values()) if (!real.includes(g)) real[0].files.push(...g.files);
    const relIds = real.map(g => g.id);
    for (const g of real) {
      const ge = eds(g);
      const th = new Map();
      for (const f of g.files) if (f.termHint) th.set(f.termHint, (th.get(f.termHint) || 0) + 1);
      const termHint = th.size ? [...th.entries()].sort((a, b) => b[1] - a[1])[0][0] : (/^\d{4}-\d{2}$/.test(g.id) ? g.id : null);
      out.push({
        ...w, key: `${w.key}|r:${g.id}`, files: g.files, splitFrom: w.key, releaseId: g.id, releaseLabel: releaseLabel(g.id, relIds),
        siblingReleases: relIds, editions: EDITION_ORDER.filter(e => ge.has(e)), roots: new Map(w.roots), termHint,
        groupCandidates: w.groupCandidates ? [...w.groupCandidates] : w.groupCandidates,
      });
    }
  }
  return out;
}

/**
 * Confirmed merges (aliases table, docs/ai-enrichment.md §6): a work whose key was merged into
 * another key joins that work, so the merge survives every scan. `aliases` maps a full work_key
 * ("Wicked|work|geral") to { to_key, to_name }. Chains (a→b→c) are followed. The target keeps its
 * own folder; when the target's files are gone the aliased work takes over its key and name.
 */
function applyAliases(works, aliases) {
  if (!aliases || !aliases.size) return works;
  const resolve = (k) => {
    let a = null, cur = k;
    for (let i = 0; i < 8; i++) { const n = aliases.get(cur); if (!n || n.to_key === cur) break; a = n; cur = n.to_key; }
    return a ? { ...a, to_key: cur } : null;
  };
  const byKey = new Map();
  const order = [];
  for (const w of works) {
    const a = resolve(w.key);
    if (a) { w.aliasedFrom = w.key; w.key = a.to_key; w.aliasName = a.to_name || null; }
    if (!byKey.has(w.key)) { byKey.set(w.key, []); order.push(w.key); }
    byKey.get(w.key).push(w);
  }
  const out = [];
  for (const k of order) {
    const list = byKey.get(k);
    if (list.length === 1 && !list[0].aliasedFrom) { out.push(list[0]); continue; }
    const base = list.find(w => !w.aliasedFrom) || list[0];
    base.homeDirs = [...new Set(base.files.map(f => f.dir))];
    for (const w of list) {
      if (w === base) continue;
      base.files.push(...w.files);
      if (w.roots) for (const [r, n] of w.roots) base.roots.set(r, (base.roots.get(r) || 0) + n);
      if (w.groupCandidates && base.groupCandidates) base.groupCandidates.push(...w.groupCandidates);
      if (!base.sidecar && w.sidecar) base.sidecar = w.sidecar;
    }
    if (base.aliasedFrom) {
      // the target itself is gone from disk: this work carries its key, kind and name
      const [creator, kind] = k.split('|');
      if (kind) base.kind = kind;
      if (creator) base.creator = creator;
      if (base.aliasName) { base.name = base.aliasName; if (base.layout === 'studio') base.character = base.aliasName; }
    }
    if (base.layout === 'studio') {
      const eds = new Set(base.files.map(f => f.edition).filter(Boolean));
      base.editions = EDITION_ORDER.filter(e => eds.has(e));
    }
    out.push(base);
  }
  return out;
}

// ── attribution ──────────────────────────────────────────────────────────────

/**
 * §5 precedence per field: model.json > manifest exact (name+size) > unique size > name/stem > Drive > path.
 * Mutates work.files (product, matched_by) and returns the attribution fields.
 */
function attributeWork(w, meta) {
  const fix = meta?.fix || naming.makeFixer();
  const prodStats = new Map(); // product → { matched: Set(file keys), by: Set }
  let strongHits = 0, nameHits = 0;
  for (const f of w.files) {
    f.product = null; f.matched_by = null;
    if (!meta || IMAGE_EXTS.has(extOf(f.name)) && !ARCHIVE_RE.test(f.name)) continue;
    const m = metaLib.matchFile(meta, f.name, f.size, { creator: w.creator, character: w.layout === 'studio' ? w.character : (w.character || w.name), edition: f.edition });
    if (!m) continue;
    f.product = m.product.name; f.matched_by = m.by; f._product = m.product;
    if (m.by === 'name') nameHits++; else strongHits++;
    let st = prodStats.get(m.product);
    if (!st) { st = { matched: new Set(), by: new Set() }; prodStats.set(m.product, st); }
    st.matched.add(`${m.file.key}|${m.file.size}`);
    st.by.add(m.by);
  }
  // Stem matching (creator + character + edition) when files were renamed/extracted; not for one
  // release of a character released several times (the stem would find the other releases' products)
  if (meta && w.layout === 'studio' && w.character && !w.releaseId) {
    const eds = w.kind === 'diorama' ? ['Diorama'] : (w.editions.length ? w.editions : [null]);
    for (const ed of eds) {
      const hits = metaLib.productsForStem(meta, w.creator, w.character, ed);
      for (const p of hits) {
        if (prodStats.has(p)) continue;
        if (ed === null && hits.length > 3) break; // too vague
        prodStats.set(p, { matched: new Set(), by: new Set(['stem']) });
      }
    }
    for (const f of w.files) {
      if (f.product) continue;
      const ed = w.kind === 'diorama' ? 'Diorama' : f.edition;
      const p = [...prodStats.keys()].find(x => (x.isDiorama ? 'Diorama' : x.edition) === ed && prodStats.get(x).by.has('stem'));
      if (p) { f.product = p.name; f.matched_by = 'stem'; f._product = p; nameHits++; }
    }
  }
  const fileKeys = new Set(w.files.map(f => metaLib.fileKey(f.name)));
  const fileSizes = new Set(w.files.map(f => f.size));
  const products = [...prodStats.entries()].map(([p, st]) => {
    const missing = p.files.filter(pf => !st.matched.has(`${pf.key}|${pf.size}`) && !fileKeys.has(pf.key) && !(pf.size >= metaLib.SIZE_MATCH_MIN && fileSizes.has(pf.size)));
    return {
      name: p.name, creator: p.creator, edition: p.isDiorama ? 'Diorama' : p.edition, genre: p.genre, term: p.term, termLabel: p.termLabel,
      productUrl: p.productUrl, libraryUrl: p.libraryUrl, claimed: p.claimed, status: p.status,
      matchedFiles: p.files.length - missing.length, totalFiles: p.files.length, missing: missing.map(x => x.name),
      matchedBy: [...st.by][0] || null,
    };
  }).sort((a, b) => b.matchedFiles - a.matchedFiles || (a.edition || '').localeCompare(b.edition || ''));

  const fields = {};
  const sc = w.sidecar;
  // Fields come from the work's own creator's products when there are any (a stray size match
  // with another creator's product must not relabel the work)
  const own = products.filter(p => !w.creator || !p.creator || p.creator === w.creator);
  const pool = own.length ? own : (w.layout === 'studio' ? [] : products);
  const strongProducts = pool.filter(p => p.matchedBy && p.matchedBy !== 'stem' && p.matchedBy !== 'name');
  const anyProducts = pool;
  const majority = (vals) => {
    const m = new Map();
    for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1);
    return m.size ? [...m.entries()].sort((a, b) => b[1] - a[1] || String(b[0]).localeCompare(String(a[0])))[0][0] : null;
  };
  // genre (franchise): model.json > the genre folder of a studio tree > manifest > Drive > genre_map
  const conflicts = [];
  const pathGenre = w.pathGenre && w.pathGenre !== '_Unsorted' ? w.pathGenre : null;
  const metaGenre = majority(strongProducts.map(p => p.genre)) || majority(anyProducts.map(p => p.genre));
  let genre = null;
  if (sc && sc.genre) { genre = sc.genre; fields.franchise = 'sidecar'; }
  if (!genre && pathGenre) { genre = pathGenre; fields.franchise = 'path'; }
  if (!genre && metaGenre) { genre = metaGenre; fields.franchise = 'manifest'; }
  if (pathGenre && metaGenre && naming.normKey(pathGenre) !== naming.normKey(metaGenre)) conflicts.push({ field: 'franchise', pathValue: pathGenre, metaValue: metaGenre });
  let drive = null;
  if (meta && w.layout === 'studio') {
    for (const f of w.files) { drive = metaLib.driveForFile(meta, f.name); if (drive) break; }
    // by character stem only when the character has one release (the stem can't tell releases apart)
    if (!drive && !w.releaseId) for (const ed of (w.editions.length ? w.editions : [null])) { drive = metaLib.driveForStem(meta, w.creator, w.character, ed); if (drive) break; }
  }
  if (!genre && drive && drive.genre) { genre = drive.genre; fields.franchise = 'drive'; }
  if (!genre && meta && w.layout === 'studio') {
    const g = metaLib.genreForCharacter(meta, w.character, w.group);
    if (g) { genre = g.genre; fields.franchise = g.by; }
  }
  if (!genre && naming.FIXED_GENRE[w.creator]) { genre = naming.FIXED_GENRE[w.creator]; fields.franchise = 'path'; }
  // character
  if (w.layout === 'studio') fields.character = sc && sc.character ? 'sidecar' : 'parse';
  // release term
  let term = null, termLabel = null;
  if (sc && sc.release_term) { term = sc.release_term; fields.release_term = 'sidecar'; }
  if (!term) {
    const withTerm = (strongProducts.length ? strongProducts : anyProducts).filter(p => p.term);
    term = majority(withTerm.map(p => p.term));
    if (term) { fields.release_term = 'manifest'; termLabel = (withTerm.find(p => p.term === term) || {}).termLabel || null; }
  }
  if (!term && drive && drive.term) { term = drive.term; termLabel = drive.label; fields.release_term = 'drive'; }
  if (!termLabel && drive) termLabel = drive.label;
  if (!term && w.termHint) { term = w.termHint; fields.release_term = 'path'; }
  if (!termLabel && w.releaseLabel) termLabel = w.releaseLabel;
  // source + public URL
  let source = 'unknown';
  if (sc && sc.source) source = sc.source;
  else if (products.length) source = 'gumroad';
  else if (drive) source = 'google-drive';
  else if (w.creator === 'ZEZ') source = 'patreon';
  let sourceUrl = sc && sc.claim_url ? sc.claim_url : null;
  if (!sourceUrl) { const p = products.find(x => x.productUrl); if (p) sourceUrl = p.productUrl; }
  if (!sourceUrl && meta && w.layout === 'studio') {
    for (const ed of (w.kind === 'diorama' ? ['Diorama'] : w.editions)) {
      const tr = metaLib.trackerForStem(meta, w.creator, w.character, ed);
      if (tr && tr.url) { sourceUrl = tr.url; break; }
    }
  }
  if (!sourceUrl) { const p = products.find(x => x.libraryUrl); if (p) sourceUrl = p.libraryUrl; }

  let confidence = 'none';
  if (sc) confidence = 'sidecar';
  else if (strongHits > 0) confidence = 'exact';
  else if (nameHits > 0 || products.length) confidence = 'name';
  else if (genre || term) confidence = 'path';
  const total = w.files.length;
  const matched = w.files.filter(f => f.product).length;
  // Display name: the manifest's spelling when a product of the same creator names the same character
  let character = null;
  if (w.layout === 'studio' && !(sc && sc.character)) {
    const ck = naming.compactKey(w.character, fix);
    for (const [p] of prodStats) {
      if (p.creator === w.creator && naming.compactKey(p.character, fix) === ck && p.character) { character = p.character; break; }
    }
  }
  for (const f of w.files) delete f._product;
  return {
    character,
    genre, release_term: term, release_label: termLabel, source, sourceUrl, products,
    attribution: { confidence, fields, matchedFiles: matched, totalFiles: total, conflicts },
  };
}

// ── finalize ─────────────────────────────────────────────────────────────────

function commonDir(dirs) {
  if (!dirs.length) return null;
  let parts = dirs[0].split(path.sep);
  for (const d of dirs.slice(1)) {
    const q = d.split(path.sep);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.sep;
}

/**
 * folder_path = the deepest folder holding all the work's files in its main
 * creator root; works sharing it get "<folder>#<slug>" (virtual). Also sets
 * libraries / library / file.library / hash.
 */
function finalizeWorks(works, { libraries = [], libraryOf }) {
  for (const w of works) {
    for (const f of w.files) f.library = libraryOf(f.abs, libraries);
    const libs = new Map();
    for (const f of w.files) if (f.library) libs.set(f.library, (libs.get(f.library) || 0) + 1);
    w.libraries = [...libs.keys()].sort((a, b) => libs.get(b) - libs.get(a) || a.localeCompare(b));
    w.library = w.libraries[0] || null;
    if (w.folders && w.folders.length === 1) { w.realFolder = w.folders[0]; }
    else if (w.homeDirs && w.homeDirs.length) { w.realFolder = commonDir(w.homeDirs); } // merged work: the target's own folder
    else {
      // main root = the creator root holding most of its files
      const byRoot = new Map();
      for (const f of w.files) {
        const r = [...(w.roots || new Map()).keys()].find(rt => f.abs.startsWith(rt + path.sep)) || '';
        if (!byRoot.has(r)) byRoot.set(r, []);
        byRoot.get(r).push(f.dir);
      }
      const main = [...byRoot.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      w.realFolder = commonDir([...new Set(main[1])]);
    }
    if (w.groupCandidates) {
      // a group only when the work's own folder sits under it (a misfiled copy elsewhere doesn't count)
      const g = w.groupCandidates.find(c => c.abs.some(a => w.realFolder === a || w.realFolder.startsWith(a + path.sep)));
      w.group = g ? g.name : null;
      delete w.groupCandidates;
    }
    const h = crypto.createHash('sha1');
    for (const f of [...w.files].sort((a, b) => (a.abs < b.abs ? -1 : 1))) h.update(`${f.abs}:${f.size}:${Math.round(f.mtimeMs)}|`);
    w.hash = h.digest('hex').slice(0, 16);
  }
  // Collisions on the same real folder → virtual paths; the work named like the folder keeps it
  const byFolder = new Map();
  for (const w of works) {
    if (!byFolder.has(w.realFolder)) byFolder.set(w.realFolder, []);
    byFolder.get(w.realFolder).push(w);
  }
  for (const [folder, list] of byFolder) {
    if (list.length === 1) { list[0].folderPath = folder; continue; }
    const base = naming.parseName(path.basename(folder));
    const baseKey = base.key || naming.normKey(path.basename(folder));
    const owner = list.find(w => naming.normKey(w.character || w.name) === baseKey && (w.kind === 'diorama') === !!base.isDiorama)
      || list.find(w => naming.normKey(w.character || w.name) === baseKey) || null;
    const used = new Set();
    for (const w of list.sort((a, b) => a.key.localeCompare(b.key))) {
      if (w === owner) { w.folderPath = folder; continue; }
      let slug = slugify(`${w.kind === 'diorama' ? 'diorama ' : ''}${w.name}`);
      let s = slug, i = 2;
      while (used.has(s)) s = `${slug}-${i++}`;
      used.add(s);
      w.folderPath = `${folder}#${s}`;
    }
  }
  return works;
}

/** Strip the virtual "#slug" suffix (docs §4). Real folders that contain '#' are left alone. */
function realFolder(p) {
  if (!p) return p;
  const m = String(p).match(/^(.*[^/\\])#([a-z0-9][a-z0-9-]*)$/);
  if (!m) return p;
  try { if (fs.existsSync(p)) return p; } catch {}
  return m[1];
}

module.exports = {
  walkTree, filesUnder, resolveRoots, planWorks, studioRecords, studioWorks, folderWorks, attributeWork,
  finalizeWorks, realFolder, editDistance, applyAliases, splitReleases, productRelease, releaseLabel, prettyName, inferModelName, releaseVariant, releaseItemName, commonDir, slugify,
  TRANSPARENT, SKIP_DIR,
};
