// Shared helpers for AI enrichment (docs/ai-enrichment.md): review groups,
// confidence bands, field labels and small formatters.

export const REVIEW_GROUPS = [
  { id: 'merges', label: 'Merges', filter: { type: 'merge' }, count: s => s?.byType?.merge },
  { id: 'characters', label: 'Characters', filter: { type: 'field', field: 'character' }, count: s => s?.byField?.character },
  { id: 'genres', label: 'Genres', filter: { type: 'field', field: 'franchise' }, count: s => s?.byField?.franchise },
  { id: 'groups', label: 'Groups', filter: { type: 'field', field: 'group_name' }, count: s => s?.byField?.group_name },
  { id: 'names', label: 'Names', filter: { type: 'rename' }, count: s => s?.byType?.rename },
  { id: 'editions', label: 'Editions', filter: { type: 'field', field: 'editions' }, count: s => s?.byField?.editions, optional: true },
  { id: 'tags', label: 'Tags', filter: { type: 'field', field: 'tags' }, count: s => s?.byField?.tags },
];

export const FIELD_LABELS = {
  character: 'Character', franchise: 'Genre', group_name: 'Group', editions: 'Editions', name: 'Name', tags: 'Tags',
  studio: 'Studio', release_term: 'Term',
};

export const HIGH_MIN = 0.8;
export const MEDIUM_MIN = 0.65;

export function band(conf) {
  const c = Number(conf);
  if (!Number.isFinite(c)) return null;
  return c >= HIGH_MIN ? 'high' : c >= MEDIUM_MIN ? 'medium' : 'low';
}
export const BAND_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

export function pct(conf) {
  const c = Number(conf);
  return Number.isFinite(c) ? `${Math.round(c * 100)}%` : '';
}

export function usd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/** Normalise a current/proposed value (string, array or null) to a display list. */
export function asValues(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

/** Values in `proposed` that are not in `current` (tags are additive). */
export function addedValues(current, proposed) {
  const have = new Set(asValues(current).map(x => x.toLowerCase()));
  return asValues(proposed).filter(x => !have.has(x.toLowerCase()));
}

export function formatRunDate(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Tooltip for an AI-filled field. */
export function aiTooltip(prov, conf, enrichment) {
  const parts = [prov === 'ai-reviewed' ? 'AI, reviewed' : 'Filled by AI'];
  if (conf != null && Number.isFinite(Number(conf))) parts.push(`${pct(conf)} confidence`);
  if (enrichment && (enrichment.runId || enrichment.at)) {
    parts.push([enrichment.runId ? `run #${enrichment.runId}` : '', enrichment.at ? formatRunDate(enrichment.at) : ''].filter(Boolean).join(', '));
  }
  return parts.join(' · ');
}

export const isAiProv = p => p === 'ai' || p === 'ai-reviewed';

/** Human description of what a decide call did. */
export function decideSummary(r) {
  if (!r) return '';
  const parts = [];
  if (r.accepted) parts.push(`${r.accepted} accepted`);
  if (r.merged) parts.push(`${r.merged} merged`);
  if (r.rejected) parts.push(`${r.rejected} rejected`);
  const errs = Array.isArray(r.errors) ? r.errors.length : 0;
  if (errs) parts.push(`${errs} failed`);
  return parts.join(', ') || 'Nothing changed';
}

/** Is a release label just the Drive term (already shown as the term)? */
export function isTermLabel(label) {
  return /google\s*drive|\bterm\b\s*\d{4}/i.test(String(label || ''));
}
