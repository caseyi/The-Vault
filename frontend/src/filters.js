// Gallery filter state shape + helpers shared by App, Sidebar and Gallery.
import { formatTerm, kindLabel, sourceLabel } from './library';

export const EMPTY_FILTERS = Object.freeze({
  search: '', creator: '', status: '', tags: '', franchise: '', collection: '', folder: '',
  has_thumbnail: false, recently_added: false, favorite: false,
  // Library metadata (works / attribution)
  library: '', studio: '', term: '', kind: '', source: '', attributed: '',
});

/** Query params for /api/models (and the CSV export) from the filter state. */
export function filterParams(filters = {}, { showHidden = false } = {}) {
  const f = filters;
  return {
    ...(f.search && { search: f.search }),
    ...(f.creator && { creator: f.creator }),
    ...(f.status && { status: f.status }),
    ...(f.tags && { tags: f.tags }),
    ...(f.has_thumbnail && { has_thumbnail: '1' }),
    ...(f.recently_added && { recently_added: '1' }),
    ...(f.franchise && { franchise: f.franchise }),
    ...(f.collection && { collection: f.collection }),
    ...(f.folder && { folder: f.folder }),
    ...(f.favorite && { favorite: '1' }),
    ...(f.library && { library: f.library }),
    ...(f.studio && { studio: f.studio }),
    ...(f.term && { term: f.term }),
    ...(f.kind && { kind: f.kind }),
    ...(f.source && { source: f.source }),
    ...(f.attributed && { attributed: f.attributed }),
    ...(showHidden && { show_hidden: '1' }),
  };
}

const lastSegment = (p) => (p || '').split('/').filter(Boolean).slice(-1)[0] || p;

/**
 * List every active filter as a chip: { key, label, value, clear(filters) -> filters }.
 * `collections` resolves collection ids to names.
 */
export function activeFilterChips(filters = {}, { collections = [] } = {}) {
  const chips = [];
  const f = { ...EMPTY_FILTERS, ...filters };
  if (f.search && f.search.trim()) chips.push({ key: 'search', label: 'Search', value: `"${f.search.trim()}"`, clear: x => ({ ...x, search: '' }) });
  if (f.status) chips.push({ key: 'status', label: 'Status', value: f.status, clear: x => ({ ...x, status: '' }) });
  if (f.creator) chips.push({ key: 'creator', label: 'Creator', value: f.creator, clear: x => ({ ...x, creator: '' }) });
  if (f.library) chips.push({ key: 'library', label: 'Library', value: f.library, clear: x => ({ ...x, library: '' }) });
  if (f.studio) chips.push({ key: 'studio', label: 'Studio', value: f.studio, clear: x => ({ ...x, studio: '' }) });
  if (f.franchise) chips.push({ key: 'franchise', label: 'Genre', value: f.franchise, clear: x => ({ ...x, franchise: '' }) });
  if (f.term) chips.push({ key: 'term', label: 'Term', value: formatTerm(f.term), title: f.term, clear: x => ({ ...x, term: '' }) });
  if (f.kind) chips.push({ key: 'kind', label: 'Kind', value: kindLabel(f.kind), clear: x => ({ ...x, kind: '' }) });
  if (f.source) chips.push({ key: 'source', label: 'Source', value: sourceLabel(f.source), clear: x => ({ ...x, source: '' }) });
  if (f.attributed) chips.push({ key: 'attributed', label: 'Attribution', value: f.attributed === 'no' ? 'Unattributed' : 'Attributed', clear: x => ({ ...x, attributed: '' }) });
  if (f.collection) {
    const c = collections.find(c => String(c.id) === String(f.collection));
    chips.push({ key: 'collection', label: 'Collection', value: c ? c.name : `#${f.collection}`, clear: x => ({ ...x, collection: '' }) });
  }
  if (f.folder) chips.push({ key: 'folder', label: 'Folder', value: lastSegment(f.folder), title: f.folder, clear: x => ({ ...x, folder: '' }) });
  for (const tag of (f.tags || '').split(',').filter(Boolean)) {
    chips.push({
      key: `tag:${tag}`, label: 'Tag', value: tag,
      clear: x => ({ ...x, tags: (x.tags || '').split(',').filter(t => t && t !== tag).join(',') }),
    });
  }
  if (f.favorite) chips.push({ key: 'favorite', label: 'Favorites', value: '★', clear: x => ({ ...x, favorite: false }) });
  if (f.has_thumbnail) chips.push({ key: 'has_thumbnail', label: 'Has thumbnail', value: '', clear: x => ({ ...x, has_thumbnail: false }) });
  if (f.recently_added) chips.push({ key: 'recently_added', label: 'New this scan', value: '', clear: x => ({ ...x, recently_added: false }) });
  return chips;
}

export function hasActiveFilters(filters) {
  return activeFilterChips(filters).length > 0;
}
