// Labels and helpers for the library-metadata fields (works, editions, variants,
// libraries, release terms, attribution). Pure functions shared by the gallery,
// sidebar, detail page and Health tab. Everything tolerates missing fields so
// the UI still works against an older backend.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse a JSON-array column or pass an array through. */
export function asList(v) {
  if (Array.isArray(v)) return v.filter(x => x != null && x !== '');
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(x => x != null && x !== '') : []; } catch { return []; }
  }
  return v ? [v] : [];
}

/** "2026-03" -> "Mar 2026"; anything else is returned unchanged. */
export function formatTerm(term, { short = false } = {}) {
  if (!term) return '';
  const m = String(term).match(/^(\d{4})-(\d{2})/);
  if (!m) return String(term);
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return String(term);
  return short ? mon : `${mon} ${m[1]}`;
}

/**
 * Group term facets by year, newest first: [{ year, terms: [{name,count,label}] }].
 * Terms that are not YYYY-MM land in a trailing "Other" group.
 */
export function groupTermsByYear(terms = []) {
  const years = new Map();
  const other = [];
  for (const t of terms) {
    const name = typeof t === 'string' ? t : t && t.name;
    if (!name) continue;
    const count = typeof t === 'object' ? t.count : undefined;
    const m = String(name).match(/^(\d{4})-(\d{2})/);
    if (!m) { other.push({ name, count, label: String(name) }); continue; }
    if (!years.has(m[1])) years.set(m[1], []);
    years.get(m[1]).push({ name, count, label: formatTerm(name, { short: true }) });
  }
  const out = [...years.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, list]) => ({ year, terms: list.sort((a, b) => b.name.localeCompare(a.name)) }));
  if (other.length) out.push({ year: 'Other', terms: other });
  return out;
}

export const EDITION_ORDER = ['Sculpture', 'Bust', 'Diorama', 'Accessory'];

export function sortEditions(list) {
  const rank = e => { const i = EDITION_ORDER.indexOf(e); return i < 0 ? EDITION_ORDER.length : i; };
  return [...list].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
}

/** Editions to show on a card. Dioramas carry the "Diorama" chip even when editions is empty. */
export function cardEditions(model) {
  const eds = asList(model && model.editions);
  if (model && model.kind === 'diorama' && !eds.includes('Diorama')) eds.unshift('Diorama');
  return sortEditions([...new Set(eds)]);
}

export const VARIANT_LABELS = {
  unsupported: 'Non Supported',
  'one-piece': 'One Piece',
  'presupported-chitubox': 'Pre-supported (Chitubox)',
  'presupported-stl': 'Pre-supported (STL)',
  'presupported-lychee': 'Pre-supported (Lychee)',
  'x-pose': 'X Pose',
  images: 'Images',
  info: 'Info',
  supported: 'Supported',
  other: 'Other files',
};
const VARIANT_ORDER = Object.keys(VARIANT_LABELS);

export function variantLabel(v) {
  if (!v) return 'Other files';
  if (VARIANT_LABELS[v]) return VARIANT_LABELS[v];
  // Release-mode scales ("32mm", "75mm", "1-9-scale") and anything new
  return String(v).replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, (_, c) => c.toUpperCase()).replace(/(\d) ?Mm\b/g, '$1mm');
}

export function compareVariants(a, b) {
  const ra = VARIANT_ORDER.indexOf(a || 'other');
  const rb = VARIANT_ORDER.indexOf(b || 'other');
  const scale = v => { const m = String(v || '').match(/^(\d+(?:\.\d+)?)\s*mm\b/i); return m ? Number(m[1]) : null; };
  const sa = scale(a); const sb = scale(b);
  if (sa != null && sb != null) return sa - sb || String(a).localeCompare(String(b));
  if (sa != null) return -1; // scales first in release items
  if (sb != null) return 1;
  const ka = ra < 0 ? VARIANT_ORDER.length - 1.5 : ra;
  const kb = rb < 0 ? VARIANT_ORDER.length - 1.5 : rb;
  return ka - kb || String(a || '').localeCompare(String(b || ''));
}

export const KIND_OPTIONS = [
  { value: 'work', label: 'Works' },
  { value: 'diorama', label: 'Dioramas' },
  { value: 'release-item', label: 'Release items' },
  { value: 'model', label: 'Other models' },
  { value: 'tool', label: 'Tools' },
];
export const kindLabel = k => (KIND_OPTIONS.find(o => o.value === k) || {}).label || k;

export const SOURCE_LABELS = {
  gumroad: 'Gumroad', 'google-drive': 'Google Drive', patreon: 'Patreon', unknown: 'Unknown',
};
export const sourceLabel = s => SOURCE_LABELS[s] || (s ? String(s) : '');

export const ATTRIBUTION_OPTIONS = [
  { value: 'yes', label: 'Attributed' },
  { value: 'no', label: 'Unattributed' },
];

/** Confidence levels that tie a work to a purchase record (or a sidecar). */
const ATTRIBUTED = new Set(['sidecar', 'exact', 'name']);
export const isAttributed = c => ATTRIBUTED.has(c);

export const CONFIDENCE_LABELS = {
  sidecar: 'Sidecar', exact: 'Exact match', name: 'Name match', path: 'From folder', none: 'Unattributed',
};

/** Plain-language explanation of how a work was attributed. */
export function explainConfidence(attribution, { source } = {}) {
  const a = attribution || {};
  const c = a.confidence;
  const where = source === 'google-drive' ? 'your Google Drive listing'
    : source === 'patreon' ? 'your Patreon downloads'
      : 'your Gumroad purchases';
  const counted = a.totalFiles > 0 ? `${a.matchedFiles || 0} of ${a.totalFiles} files` : 'the files';
  switch (c) {
    case 'sidecar': return 'Set by hand in a model.json file next to the model.';
    case 'exact': return `Matched ${counted} to ${where} by exact size.`;
    case 'name': return `Matched ${counted} to ${where} by product name (sizes differ).`;
    case 'path': return 'No purchase matched; studio and character come from the folder names.';
    case 'none': return 'No purchase record matched these files yet.';
    default: return '';
  }
}

export const FIELD_SOURCE_LABELS = {
  sidecar: 'model.json', manifest: 'Gumroad manifest', drive: 'Drive listing', tracker: 'Gumroad tracker',
  parse: 'file names', path: 'folder path', genre_map: 'genre map', rules: 'filing rules',
};

/** "Dagobah + Endor" (or '' when the work lives in a single library). */
export function multiLibraryLabel(model) {
  const libs = [...new Set(asList(model && model.libraries))].sort();
  return libs.length > 1 ? libs.join(' + ') : '';
}

export function formatGB(gb) {
  if (gb == null || Number.isNaN(Number(gb))) return '';
  const n = Number(gb);
  return n >= 1 ? `${n.toFixed(1)} GB` : `${Math.round(n * 1024)} MB`;
}
