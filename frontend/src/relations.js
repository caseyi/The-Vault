// Related cards and sets (docs/relations.md sections 4, 5, 7.4): labels, filter
// pills, response parsing and small helpers shared by the sidebar, gallery,
// detail page and Review tab. Everything tolerates missing fields so the UI
// hides the feature against an older backend.
import { formatTerm } from './library';

/** Is this a usable GET /api/relations/summary body? Its presence switches the feature on. */
export function isRelationsSummary(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.error) return false;
  return ['byType', 'bySource', 'byStatus', 'dioramas', 'filters', 'sets'].some(k => d[k] != null);
}

/** Sidebar "Relations" pills: filter key, label. Each toggles its own boolean filter. */
export const RELATION_FILTERS = [
  { key: 'inDiorama', label: 'In a diorama' },
  { key: 'features', label: 'Dioramas with linked figures' },
  { key: 'hasReleases', label: 'Has other releases' },
  { key: 'hasAccessories', label: 'Has accessories' },
  { key: 'hasRelations', label: 'Any links' },
];

/** Sidebar "Sets" kind pills (inSet=...). */
export const SET_KIND_FILTERS = [
  { value: 'release', label: 'In a release' },
  { value: 'theme', label: 'In a theme' },
  { value: 'diorama', label: 'In a diorama set' },
  { value: 'any', label: 'In any set' },
];

export const SET_KIND_LABELS = { release: 'Release', theme: 'Theme', diorama: 'Diorama' };
export const setKindLabel = k => SET_KIND_LABELS[k] || (k ? String(k) : 'Set');

/** "Release: The Tale of Archduke Mousin (2023-11)", "Theme: Archduke Mousin". */
export function setChipLabel(set) {
  if (!set) return '';
  const name = set.name || (set.id != null ? `#${set.id}` : '');
  const term = set.kind === 'release' && set.term && !String(name).includes(String(set.term)) ? ` (${set.term})` : '';
  return `${setKindLabel(set.kind)}: ${name}${term}`;
}

/** Relation types: label for a link seen from the "from" card. */
export const RELATION_LABELS = {
  features: 'Diorama features',
  'release-of': 'Other release of',
  'accessory-of': 'Accessory for',
};
export const relationLabel = t => RELATION_LABELS[t] || (t ? String(t) : 'Related');

/** Detail "Related" strip sections, in display order. */
export const RELATED_SECTIONS = [
  { key: 'dioramas', label: 'Dioramas' },
  { key: 'characters', label: 'Figures' },
  { key: 'releases', label: 'Other releases' },
  { key: 'accessories', label: 'Accessories' },
  { key: 'accessoryOf', label: 'Accessory for' },
  { key: 'other', label: 'Related' },
];

/**
 * How to re-create a link from a strip section (undo after remove): the type and
 * which side this card is on. `other` keeps the item's own type when the server sent one.
 */
export function linkForSection(section, modelId, item) {
  const me = modelId; const it = item && item.id;
  switch (section) {
    case 'dioramas': return { type: 'features', fromId: it, toId: me };
    case 'characters': return { type: 'features', fromId: me, toId: it };
    case 'releases': return { type: 'release-of', fromId: Math.min(me, it), toId: Math.max(me, it) };
    case 'accessories': return { type: 'accessory-of', fromId: it, toId: me };
    case 'accessoryOf': return { type: 'accessory-of', fromId: me, toId: it };
    default: {
      const type = (item && (item.relationType || item.type)) || 'features';
      const reversed = item && (item.direction === 'in' || item.reversed);
      return reversed ? { type, fromId: it, toId: me } : { type, fromId: me, toId: it };
    }
  }
}

/** "Add link" picker types, phrased from the open card's point of view. */
export const LINK_OPTIONS = [
  { value: 'in-diorama', label: 'Appears in this diorama (pick the diorama)', type: 'features', self: 'to' },
  { value: 'features', label: 'This diorama features (pick a figure)', type: 'features', self: 'from' },
  { value: 'release-of', label: 'Same character, other release', type: 'release-of', self: 'from' },
  { value: 'accessory-of', label: 'This is an accessory for (pick a figure)', type: 'accessory-of', self: 'from' },
  { value: 'has-accessory', label: 'Has this accessory (pick the accessory)', type: 'accessory-of', self: 'to' },
];

export function linkBody(optionValue, selfId, otherId) {
  const o = LINK_OPTIONS.find(x => x.value === optionValue) || LINK_OPTIONS[0];
  return o.self === 'from'
    ? { type: o.type, fromId: selfId, toId: otherId }
    : { type: o.type, fromId: otherId, toId: selfId };
}

export const defaultLinkOption = kind => (kind === 'diorama' ? 'features' : 'in-diorama');

/** Source marker for a link: icon + accessible label. */
export const SOURCE_INFO = {
  auto: { icon: '⚙', label: 'Linked automatically by the scan' },
  'auto-reviewed': { icon: '✓', label: 'Suggested by the scan, accepted by you' },
  user: { icon: '✎', label: 'Linked by you' },
};
export const sourceInfo = s => SOURCE_INFO[s] || { icon: '•', label: s ? `Source: ${s}` : 'Linked' };

const asArr = v => (Array.isArray(v) ? v.filter(Boolean) : []);

/** Non-empty strip sections from a detail `related` object: [{ key, label, items }]. */
export function relatedSections(related) {
  if (!related || typeof related !== 'object') return [];
  return RELATED_SECTIONS
    .map(s => ({ ...s, items: asArr(related[s.key]) }))
    .filter(s => s.items.length);
}

export const hasRelated = related => !!related && typeof related === 'object' && !Array.isArray(related);

/** Gallery badges from a list item's `rel`: [{ key, label, title }]. */
export function relationBadges(model) {
  const rel = model && model.rel;
  if (!rel || typeof rel !== 'object') return [];
  const out = [];
  const n = k => Number(rel[k]) || 0;
  if (model.kind === 'diorama' && n('features') > 0) {
    out.push({ key: 'features', label: `Features ${n('features')}`, title: `Show the ${n('features')} figure${n('features') !== 1 ? 's' : ''} in this diorama` });
  }
  if (n('dioramas') > 0) {
    out.push({ key: 'dioramas', label: `In ${n('dioramas')} diorama${n('dioramas') !== 1 ? 's' : ''}`, title: 'Show the dioramas and figures related to this card' });
  }
  return out;
}

/** Set chips from a list item's `rel.sets` (max 3). */
export function cardSetChips(model) {
  const rel = model && model.rel;
  return asArr(rel && rel.sets).slice(0, 3).filter(s => s.id != null);
}

/** Parse GET /api/sets/:id: releases (`{id,name,term,members}`) and the theme's loose list. */
export function parseSetDetail(d) {
  if (!d || typeof d !== 'object') return { releases: [], loose: [], pending: [], members: [] };
  const releases = asArr(d.releases).map((r, i) => ({
    id: r.id != null ? r.id : `r${i}`,
    name: r.name || r.label || 'Release',
    term: r.term || '',
    members: asArr(r.members),
  }));
  return {
    ...d,
    releases,
    loose: asArr(d.loose),
    pending: asArr(d.pending),
    members: asArr(d.members),
  };
}

/** One-line description of a set row: "Wicked · 2023-11 · 12 cards · 2 releases". */
export function setSummaryLine(set) {
  if (!set) return '';
  const c = set.counts || {};
  const parts = [];
  if (set.creator) parts.push(set.creator);
  if (set.term) parts.push(formatTerm(set.term));
  if (c.cards != null) parts.push(`${c.cards} card${Number(c.cards) !== 1 ? 's' : ''}`);
  if (Number(c.releases) > 0) parts.push(`${c.releases} release${Number(c.releases) !== 1 ? 's' : ''}`);
  if (Number(c.loose) > 0) parts.push(`${c.loose} loose`);
  return parts.join(' · ');
}

/** The "other" card of a relation suggestion, seen from card `selfId`. */
export function suggestionOther(s, selfId) {
  if (!s) return null;
  if (s.model && s.model.id === selfId) return s.target || null;
  return s.model || null;
}

/** Plain description of a pending relation/set suggestion for card `selfId`. */
export function pendingLabel(s, selfId) {
  if (!s) return '';
  if (s.type === 'set-member' || s.type === 'set') {
    const name = setName(s);
    return `Add to theme ${name}`;
  }
  const other = suggestionOther(s, selfId);
  const name = other ? other.name : '?';
  const t = s.field || s.proposed;
  const fromSelf = s.model && s.model.id === selfId;
  if (t === 'features') return fromSelf ? `Features ${name}` : `Appears in diorama ${name}`;
  if (t === 'accessory-of') return fromSelf ? `Accessory for ${name}` : `Has accessory ${name}`;
  if (t === 'release-of') return `Other release: ${name}`;
  return `Related to ${name}`;
}

/** Theme name of a set / set-member suggestion (`set` may be an object or a name). */
export function setName(s) {
  if (!s) return '';
  if (s.set && typeof s.set === 'object') return s.set.name || s.proposed || '';
  if (typeof s.set === 'string' && s.set) return s.set;
  return s.proposed != null ? String(s.proposed) : '';
}

export const suggestionSetId = s => (s && (s.setId != null ? s.setId : (s.set && typeof s.set === 'object' ? s.set.id : null)));
