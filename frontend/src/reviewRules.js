// Review rules (docs/ai-enrichment.md §11): helpers shared by the Review tab's answer groups,
// nudge bar and rules panel. Everything tolerates an older backend (no rules / no groups routes).

/** Groups that open "by answer": few distinct values, many cards (genres, tags, groups, editions). */
export const GROUPED_BY_DEFAULT = new Set(['genres', 'groups', 'editions', 'tags']);
/** Review groups that can be shown by answer at all (field / rename proposals). */
export const groupable = (groupDef) => !!groupDef && (groupDef.filter.type === 'field' || groupDef.filter.type === 'rename');

/** Singular, lowercase field word for sentences: "genre", "character". */
export const FIELD_WORD = { character: 'character', franchise: 'genre', group_name: 'group', editions: 'edition', name: 'name', tags: 'tag' };
export const fieldWord = f => FIELD_WORD[f] || f || 'value';
export const fieldOf = (groupDef) => (groupDef ? (groupDef.filter.type === 'rename' ? 'name' : groupDef.filter.field) : null);

/** Fields each rule kind supports (mirrors backend lib/review-rules.js FIELDS). */
export const RULE_FIELDS = {
  block: ['character', 'franchise', 'group_name', 'tags', 'name'],
  map: ['character', 'franchise', 'group_name', 'tags'],
  set: ['franchise', 'group_name', 'tags'],
};
export const canRule = (kind, field) => (RULE_FIELDS[kind] || []).includes(field);

/** A value for display: arrays joined, empty shown as "empty". */
export function showValue(v) {
  if (v == null || v === '') return 'empty';
  return Array.isArray(v) ? (v.length ? v.join(', ') : 'empty') : String(v);
}

/** Parse GET /api/review-rules → rules array (older backend: []). */
export function parseRules(d) {
  const items = d && Array.isArray(d.items) ? d.items : [];
  return items.filter(r => r && r.id != null);
}

/** Parse GET /api/suggestions/groups. Null when the backend has no groups route. */
export function parseGroups(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.items)) return null;
  return {
    total: Number(d.total) || 0, suggestions: Number(d.suggestions) || 0, page: Number(d.page) || 1, pages: Number(d.pages) || 1,
    items: d.items.filter(Boolean).map(g => ({
      ...g,
      samples: Array.isArray(g.samples) ? g.samples : [],
      creators: Array.isArray(g.creators) ? g.creators : [],
    })),
  };
}

/** Last folder names of an absolute path: ".../Star Wars/Sculptures and Busts". */
export function shortFolder(p, n = 2) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  return parts.slice(-n).join('/');
}
export const parentFolder = p => (p ? String(p).replace(/\/[^/]+\/?$/, '') || null : null);

/** "Rule saved: 12 pending rejected, 3 rewritten, 40 cards set." */
export function appliedMessage(a) {
  if (!a || typeof a !== 'object') return 'Rule saved.';
  const parts = [];
  if (a.rejected) parts.push(`${a.rejected} pending suggestion${a.rejected !== 1 ? 's' : ''} rejected`);
  if (a.rewritten) parts.push(`${a.rewritten} rewritten`);
  if (a.superseded) parts.push(`${a.superseded} cleared`);
  if (a.cardsSet) parts.push(`${a.cardsSet} card${a.cardsSet !== 1 ? 's' : ''} set`);
  return parts.length ? `Rule saved: ${parts.join(', ')}.` : 'Rule saved. It applies to future suggestions.';
}

/**
 * Rules worth offering after a decision (the nudge bar). Each option is { label, rule }.
 * @param {{ decision:'reject'|'edit'|'accept', field, proposed, value?, card? }} d
 */
export function nudgeOptions(d) {
  const { decision, field } = d;
  const out = [];
  const creator = d.card && d.card.creator_name;
  const folder = d.card && d.card.folder ? parentFolder(d.card.folder) : null;
  const one = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : null) : v);
  const proposed = one(d.proposed);
  const word = fieldWord(field);
  if (decision === 'reject' && proposed != null && proposed !== '' && canRule('block', field)) {
    out.push({ label: `Never propose “${proposed}” as a ${word}`, rule: { kind: 'block', field, match: proposed } });
    if (creator) out.push({ label: `…only for ${creator}`, rule: { kind: 'block', field, match: proposed, creator } });
  }
  if (decision === 'edit' && proposed != null && d.value != null && canRule('map', field)) {
    const v = one(d.value);
    if (v != null && String(v).toLowerCase() !== String(proposed).toLowerCase()) {
      out.push({ label: `Always use “${v}” when the AI says “${proposed}”`, rule: { kind: 'map', field, match: proposed, value: v } });
    }
  }
  if ((decision === 'edit' || decision === 'accept') && canRule('set', field) && field !== 'tags') {
    const v = one(decision === 'edit' ? d.value : d.proposed);
    if (v != null && v !== '' && folder) out.push({ label: `Every card in ${shortFolder(folder)}/ gets ${word} “${v}”`, rule: { kind: 'set', field, value: v, path: folder } });
  }
  return out;
}
