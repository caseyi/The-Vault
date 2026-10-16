'use strict';
/**
 * lib/meta.js — attribution sources from `<library>/_Meta/` (docs/library-metadata.md §5).
 *
 *   gumroad_manifest*.json        products (creator, name, library link, files with byte sizes)
 *   gumroad_unclaimed_tracker.csv public product URL, status, first seen
 *   tracker_claimed.tsv           creator<TAB>product of claimed items
 *   drive_listing.csv             Drive term label per delivered file
 *   drive_links_all.csv           label → email date (term month for labels without a month)
 *   genre_map.csv                 character → genre (also read from each library root)
 *   filing_rules.csv              organizer rules: fix / genre / group / guess
 *   vault.json                    optional: { studioAliases, containers, libraryLabels }
 *
 * Read-only: The Vault never writes to the library. loadMeta() never throws; every
 * problem lands in status.errors.
 */
const fs = require('fs');
const path = require('path');
const naming = require('./naming');

const SIZE_MATCH_MIN = 64 * 1024; // tiny txt files collide by chance; never size-match them

// ── tiny CSV reader (quoted fields, embedded commas/newlines) ─────────────────
function parseCSV(text, delim = ',') {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
}
function readCSVObjects(file, delim) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parseCSV(text, delim);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** File-name key for exact/name matching: no ext, no Drive stamp, punctuation collapsed. */
function fileKey(name) {
  return naming.cleanStem(name).toLowerCase().replace(/_/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const ymd = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? s.slice(0, 10) : null);

function emptyMeta() {
  return {
    dirs: [], loadedAt: null, ms: 0, errors: [],
    products: [], productFiles: 0, tracker: [], driveFiles: 0, genreMap: new Map(), rules: { fix: {}, genre: {}, group: {}, guess: {}, members: {}, folder: {} },
    ruleCount: 0, sidecars: 0, vault: {},
    bySize: new Map(), byName: new Map(), byStem: new Map(), byCompact: new Map(), driveByName: new Map(), driveByStem: new Map(),
    trackerByStem: new Map(), fix: naming.makeFixer(),
  };
}

/**
 * Load and merge every _Meta source.
 * @param {{ dirs?: string[], roots?: string[], log?: Function }} opts
 *   dirs  — _Meta directories (every library's `_Meta`)
 *   roots — library roots (for genre_map.csv / vault.json at the root)
 */
function loadMeta({ dirs = [], roots = [], log = () => {} } = {}) {
  const t0 = Date.now();
  const meta = emptyMeta();
  meta.dirs = dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  const err = (file, e) => meta.errors.push(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${e.message || e}`);
  const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

  // vault.json (optional, from _Meta or a library root)
  for (const d of [...meta.dirs, ...roots]) {
    const f = path.join(d, 'vault.json');
    if (!fs.existsSync(f)) continue;
    try { Object.assign(meta.vault, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { err(f, e); }
  }

  // filing_rules.csv → typo fixes first (they affect every key below)
  for (const d of meta.dirs) {
    const f = path.join(d, 'filing_rules.csv');
    if (!fs.existsSync(f)) continue;
    try {
      for (const r of readCSVObjects(f)) {
        const kind = (r.kind || '').toLowerCase();
        if (!kind || !r.key) continue;
        (meta.rules[kind] = meta.rules[kind] || {})[r.key.toLowerCase()] = r.value;
        meta.ruleCount++;
      }
    } catch (e) { err(f, e); }
  }
  meta.fix = naming.makeFixer(meta.rules.fix);
  const fix = meta.fix;

  // genre_map.csv (in _Meta and at library roots)
  for (const d of [...meta.dirs, ...roots]) {
    const f = path.join(d, 'genre_map.csv');
    if (!fs.existsSync(f)) continue;
    try {
      for (const r of readCSVObjects(f)) if (r.character && r.genre) meta.genreMap.set(naming.normKey(r.character, fix), r.genre.trim());
    } catch (e) { err(f, e); }
  }

  // Gumroad manifests — merged, deduped by download_url (files unioned by name+size)
  const byUrl = new Map();
  for (const d of meta.dirs) {
    for (const name of listDir(d).filter(n => /^gumroad_manifest.*\.json$/i.test(n)).sort()) {
      const f = path.join(d, name);
      let list;
      try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { err(f, e); continue; }
      if (!Array.isArray(list)) list = list?.products || [];
      for (const p of list) {
        if (!p || !p.product_name) continue;
        const id = p.download_url || `${p.creator}|${p.product_name}`;
        let prod = byUrl.get(id);
        const unknown = /^unknown/i.test(String(p.product_name)) || /^unknown$/i.test(String(p.creator || ''));
        if (prod && prod.unknown && !unknown) { byUrl.delete(id); prod = null; } // a later manifest has the real name
        if (!prod) {
          const parsed = naming.parseProductName(p.product_name, p.creator, fix);
          prod = {
            id, rawCreator: p.creator || '', creator: parsed.creator || p.creator || null,
            studio: naming.studioOf(parsed.creator), name: cleanProductName(p.product_name),
            libraryUrl: p.download_url || null, genre: parsed.genre, term: parsed.term, termMonth: parsed.termMonth,
            termLabel: null, character: parsed.character, key: parsed.key, edition: parsed.edition,
            isDiorama: parsed.isDiorama, files: [], productUrl: null, claimed: null, status: null, unknown,
          };
          byUrl.set(id, prod);
        }
        const seen = new Set(prod.files.map(x => `${x.key}|${x.size}`));
        for (const fl of p.files || []) {
          const full = fl.extension ? `${fl.file_name}.${fl.extension}` : fl.file_name;
          const rec = { name: full, key: fileKey(full), size: Number(fl.file_size) || 0, variant: naming.parseName(fl.file_name || '', { fix }).variant };
          if (seen.has(`${rec.key}|${rec.size}`)) continue;
          seen.add(`${rec.key}|${rec.size}`);
          prod.files.push(rec);
        }
      }
    }
  }
  meta.products = [...byUrl.values()];

  // Indexes
  const sizeCount = new Map();
  for (const prod of meta.products) {
    for (const file of prod.files) {
      meta.productFiles++;
      if (file.size >= SIZE_MATCH_MIN) {
        const k = file.size;
        const prev = sizeCount.get(k);
        // the same (name,size) in two products is still one physical file → not unique
        sizeCount.set(k, prev ? { n: prev.n + 1, pf: prev.pf } : { n: 1, pf: { product: prod, file } });
      }
      if (!meta.byName.has(file.key)) meta.byName.set(file.key, []);
      meta.byName.get(file.key).push({ product: prod, file });
    }
    const sk = stemKey(prod.creator, prod.key, prod.isDiorama ? 'Diorama' : prod.edition);
    if (!meta.byStem.has(sk)) meta.byStem.set(sk, []);
    meta.byStem.get(sk).push(prod);
    const ck = `${prod.creator}|${naming.compactKey(prod.character, fix)}`;
    if (!meta.byCompact.has(ck)) meta.byCompact.set(ck, []);
    meta.byCompact.get(ck).push(prod);
  }
  for (const [size, v] of sizeCount) if (v.n === 1) meta.bySize.set(size, v.pf);

  // Drive: links (label → email date) and listing (file → label/term)
  const labelDate = new Map();
  for (const d of meta.dirs) {
    const f = path.join(d, 'drive_links_all.csv');
    if (!fs.existsSync(f)) continue;
    try { for (const r of readCSVObjects(f)) if (r.label) labelDate.set(r.label.trim().toUpperCase(), ymd(r.email_date)); } catch (e) { err(f, e); }
  }
  meta.labelTerm = (label) => termForLabel(label, labelDate);
  for (const d of meta.dirs) {
    const f = path.join(d, 'drive_listing.csv');
    if (!fs.existsSync(f)) continue;
    try {
      for (const r of readCSVObjects(f)) {
        if (!r.name) continue;
        meta.driveFiles++;
        const parts = r.name.split('/');
        const base = parts[parts.length - 1];
        const lab = naming.parseDriveLabel(r.label);
        const rec = { label: r.label, term: meta.labelTerm(r.label), genre: lab.genre, franchise: lab.franchise, creator: naming.canonicalCreator(r.creator) || lab.creator };
        const k = fileKey(base);
        if (!meta.driveByName.has(k)) meta.driveByName.set(k, rec);
        // item folder → stem (term for works whose files were renamed or extracted)
        const item = naming.parseName(parts[0], { fix });
        if (item.key) {
          const sk = stemKey(rec.creator, item.key, item.isDiorama ? 'Diorama' : item.edition);
          if (!meta.driveByStem.has(sk)) meta.driveByStem.set(sk, rec);
          const ck = `${rec.creator}|${naming.compactKey(item.character, fix)}`;
          if (!meta.driveByStem.has(ck)) meta.driveByStem.set(ck, rec);
        }
      }
    } catch (e) { err(f, e); }
  }

  // Trackers: public product URL / status / first seen
  for (const d of meta.dirs) {
    const f = path.join(d, 'gumroad_unclaimed_tracker.csv');
    if (fs.existsSync(f)) {
      try {
        for (const r of readCSVObjects(f)) {
          if (!r.Product) continue;
          const creator = naming.canonicalCreator(r.Creator) || r.Creator;
          const p = naming.parseName(r.Product, { fix });
          meta.tracker.push({ creator, product: r.Product, status: r.Status || null, firstSeen: ymd(r['First Seen']), url: r.URL || null, key: p.key, edition: p.isDiorama ? 'Diorama' : p.edition, character: p.character });
        }
      } catch (e) { err(f, e); }
    }
    const t = path.join(d, 'tracker_claimed.tsv');
    if (fs.existsSync(t)) {
      try {
        for (const line of fs.readFileSync(t, 'utf8').split(/\r?\n/)) {
          const [c, prod] = line.split('\t');
          if (!c || !prod || /^creator$/i.test(c)) continue;
          const creator = naming.canonicalCreator(c) || c;
          const p = naming.parseName(prod, { fix });
          const sk = stemKey(creator, p.key, p.isDiorama ? 'Diorama' : p.edition);
          const known = meta.tracker.find(x => stemKey(x.creator, x.key, x.edition) === sk);
          if (known) { if (!/^claimed/i.test(known.status || '')) known.status = known.status || 'Claimed'; }
          else meta.tracker.push({ creator, product: prod, status: 'Claimed', firstSeen: null, url: null, key: p.key, edition: p.isDiorama ? 'Diorama' : p.edition, character: p.character });
        }
      } catch (e) { err(t, e); }
    }
  }
  for (const tr of meta.tracker) {
    for (const k of [stemKey(tr.creator, tr.key, tr.edition), `${tr.creator}|${naming.compactKey(tr.character, fix)}|${tr.edition || ''}`]) {
      if (!meta.trackerByStem.has(k)) meta.trackerByStem.set(k, tr);
    }
  }
  // Tracker → manifest products (fuzzy by creator + character + edition)
  for (const prod of meta.products) {
    const tr = trackerForProduct(meta, prod);
    if (tr) { prod.productUrl = tr.url; prod.status = tr.status; prod.claimed = tr.firstSeen; }
    // Drive label + term for products delivered through Drive terms
    if (!prod.term || !prod.termLabel) {
      for (const f of prod.files) {
        const dr = meta.driveByName.get(f.key);
        if (dr) { prod.termLabel = prod.termLabel || dr.label; prod.term = prod.term || dr.term; break; }
      }
    }
    if (!prod.term && prod.termMonth && prod.claimed) {
      // "B3DSERK June Term" (no year): the year of the first sighting
      prod.term = `${prod.claimed.slice(0, 4)}-${String(prod.termMonth).padStart(2, '0')}`;
    }
  }

  meta.loadedAt = new Date().toISOString();
  meta.ms = Date.now() - t0;
  log('info', `_Meta loaded in ${meta.ms} ms: ${meta.products.length} products, ${meta.productFiles} product files, ${meta.tracker.length} tracker rows, ${meta.driveFiles} Drive files${meta.errors.length ? `, ${meta.errors.length} error(s)` : ''}`);
  return meta;
}

function cleanProductName(n) {
  return String(n || '')
    .replace(/\s*:\s*(?:tested|stls?|ready)\b.*$/i, '')
    .replace(/\s+-\s+tested and ready.*$/i, '')
    .replace(/\s+(?:\d\/\d+\s+)?(?:stls?\s+)?(?:3d\s+)?(?:tested\s+and\s+)?ready\s+for\s+(?:3d\s+)?printing\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
function stemKey(creator, key, edition) { return `${creator || ''}|${key || ''}|${edition || ''}`; }

function termForLabel(label, labelDate) {
  const lab = naming.parseDriveLabel(label);
  if (lab.month && lab.year) return `${lab.year}-${String(lab.month).padStart(2, '0')}`;
  const d = labelDate.get(String(label || '').trim().toUpperCase());
  return d ? d.slice(0, 7) : null;
}

function trackerForProduct(meta, prod) {
  const ed = prod.isDiorama ? 'Diorama' : prod.edition;
  return meta.trackerByStem.get(stemKey(prod.creator, prod.key, ed))
    || meta.trackerByStem.get(`${prod.creator}|${naming.compactKey(prod.character, meta.fix)}|${ed || ''}`)
    || null;
}

/**
 * Match one library file against the manifests.
 * @returns {{ product, file, by: 'exact'|'size'|'name' } | null}
 */
function matchFile(meta, filename, size) {
  if (!meta || !meta.products.length) return null;
  const k = fileKey(filename);
  const named = meta.byName.get(k);
  if (named && size) {
    const hit = named.find(x => x.file.size === size);
    if (hit) return { product: hit.product, file: hit.file, by: 'exact' };
  }
  if (size >= SIZE_MATCH_MIN) {
    const pf = meta.bySize.get(size);
    if (pf) return { product: pf.product, file: pf.file, by: 'size' };
  }
  // Name alone only for distinctive names: "Cape_Full.stl", "R_Leg.stl", "Sword.chitubox" are
  // part names shared by many products and once matched a Star Wars product to Alan Scott
  if (named && named.length && isDistinctiveName(filename)) {
    const prods = new Set(named.map(x => x.product));
    if (prods.size === 1) return { product: named[0].product, file: named[0].file, by: 'name' };
  }
  return null;
}

/** A file name that identifies a product on its own: a studio prefix or an edition word, not a part name. */
function isDistinctiveName(filename) {
  const p = naming.parseName(filename);
  return !p.generic && (p.prefixed || !!p.edition);
}

/** Products of a creator/character (optionally one edition) — stem matching. */
function productsForStem(meta, creator, character, edition) {
  if (!meta || !character) return [];
  const key = naming.normKey(character, meta.fix);
  if (edition) {
    const hit = meta.byStem.get(stemKey(creator, key, edition));
    if (hit) return hit;
  }
  const out = [];
  for (const ed of ['Sculpture', 'Bust', 'Accessory', 'Diorama', '']) {
    if (edition && ed !== edition) continue;
    out.push(...(meta.byStem.get(stemKey(creator, key, ed)) || []));
  }
  if (!out.length) {
    const ck = `${creator}|${naming.compactKey(character, meta.fix)}`;
    for (const p of meta.byCompact.get(ck) || []) if (!edition || (p.isDiorama ? 'Diorama' : p.edition) === edition) out.push(p);
  }
  return out;
}

function driveForFile(meta, filename) { return meta ? meta.driveByName.get(fileKey(filename)) || null : null; }
function driveForStem(meta, creator, character, edition) {
  if (!meta || !character) return null;
  return meta.driveByStem.get(stemKey(creator, naming.normKey(character, meta.fix), edition))
    || meta.driveByStem.get(`${creator}|${naming.compactKey(character, meta.fix)}`) || null;
}
function trackerForStem(meta, creator, character, edition) {
  if (!meta || !character) return null;
  return meta.trackerByStem.get(stemKey(creator, naming.normKey(character, meta.fix), edition))
    || meta.trackerByStem.get(`${creator}|${naming.compactKey(character, meta.fix)}|${edition || ''}`) || null;
}

/** genre_map.csv, then filing_rules `genre` rows, then `guess` rows (word subset, organizer rule). */
function genreForCharacter(meta, character, group) {
  if (!meta || !character) return null;
  for (const name of [character, group].filter(Boolean)) {
    const k = naming.normKey(name, meta.fix);
    if (meta.genreMap.has(k)) return { genre: meta.genreMap.get(k), by: 'genre_map' };
    const rk = String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (meta.rules.genre && meta.rules.genre[rk]) return { genre: meta.rules.genre[rk], by: 'rules' };
  }
  const st = naming.stems(character, meta.fix);
  for (const [gk, g] of Object.entries(meta.rules.guess || {})) {
    const gs = naming.stems(gk, meta.fix);
    if (!gs.size) continue;
    const ok = gs.size === 1 ? (st.size === 1 && [...gs][0] === [...st][0]) : [...gs].every(x => st.has(x));
    if (ok) return { genre: g, by: 'rules' };
  }
  return null;
}

/** A genre name: the organizer's list (Marvel, DC, Star Wars, …) or any genre in genre_map / filing_rules. */
function isKnownGenre(meta, name) {
  if (!name) return false;
  if (naming.canonicalGenre(name)) return true;
  const l = String(name).trim().toLowerCase();
  if (!meta) return false;
  for (const g of meta.genreMap.values()) if (String(g).toLowerCase() === l) return true;
  for (const kind of ['genre', 'guess']) for (const g of Object.values(meta.rules[kind] || {})) if (String(g).toLowerCase() === l) return true;
  return false;
}

/** Public status for /api/meta/status. */
function metaStatus(meta) {
  if (!meta) return { dirs: [], loadedAt: null, counts: { products: 0, productFiles: 0, tracker: 0, driveFiles: 0, genreMap: 0, rules: 0, sidecars: 0 }, errors: [] };
  return {
    dirs: meta.dirs, loadedAt: meta.loadedAt, ms: meta.ms,
    counts: {
      products: meta.products.length, productFiles: meta.productFiles, tracker: meta.tracker.length,
      driveFiles: meta.driveFiles, genreMap: meta.genreMap.size, rules: meta.ruleCount, sidecars: meta.sidecars || 0,
    },
    errors: meta.errors.slice(0, 50),
  };
}

/** Read a model.json sidecar (never throws). */
function readSidecar(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      studio: s(j.studio), creator: naming.canonicalCreator(s(j.creator)) || s(j.creator), genre: s(j.genre),
      character: s(j.character), type: s(j.type), source: s(j.source), claim_url: s(j.claim_url),
      release_term: /^\d{4}-\d{2}/.test(s(j.release_term) || '') ? s(j.release_term).slice(0, 7) : null,
      file,
    };
  } catch { return null; }
}

module.exports = {
  loadMeta, matchFile, productsForStem, driveForFile, driveForStem, trackerForStem, genreForCharacter, metaStatus,
  readSidecar, fileKey, parseCSV, stemKey, SIZE_MATCH_MIN, emptyMeta, isDistinctiveName, isKnownGenre,
};
