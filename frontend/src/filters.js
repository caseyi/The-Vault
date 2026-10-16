// Gallery filter state shape + helpers shared by App, Sidebar and Gallery.

export const EMPTY_FILTERS = Object.freeze({
  search: '', creator: '', status: '', tags: '', franchise: '', collection: '', folder: '',
  has_thumbnail: false, recently_added: false, favorite: false,
});

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
  if (f.franchise) chips.push({ key: 'franchise', label: 'Franchise', value: f.franchise, clear: x => ({ ...x, franchise: '' }) });
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
