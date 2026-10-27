// Fixtures in the docs/relations.md shapes (sections 4 and 7.4). Test-only.

export const relSummary = {
  byType: { features: 217, 'release-of': 86, 'accessory-of': 49 },
  bySource: { auto: 300, 'auto-reviewed': 40, user: 12 },
  byStatus: { active: 352, removed: 3, stale: 1 },
  dioramas: { total: 163, linked: 127 },
  filters: { inDiorama: 210, features: 127, hasReleases: 86, hasAccessories: 40, hasRelations: 400, noTheme: 900 },
  sets: { release: 104, theme: 4, suggested: 2 },
};

const card = (id, name, extra = {}) => ({
  id, name, kind: 'work', creator_name: 'SW3D', thumb_url: null, editions: ['Sculpture'], release_label: '',
  relationId: id * 10, source: 'auto', confidence: 0.95, ...extra,
});

export const hanDio = { id: 40, name: 'Han and Chewie', kind: 'diorama', creator_name: 'SW3D', editions: [], print_status: 'unprinted', images: [], hidden: 0,
  rel: { dioramas: 0, features: 2, releases: 0, accessories: 0, sets: [{ id: 'diorama-40', kind: 'diorama', name: 'Han and Chewie' }] } };
export const hanCard = { id: 41, name: 'Han Solo', kind: 'work', creator_name: 'SW3D', editions: ['Sculpture', 'Bust'], print_status: 'unprinted', images: [], hidden: 0,
  rel: { dioramas: 1, features: 0, releases: 1, accessories: 0, sets: [{ id: 7, kind: 'release', name: 'The Tale of Archduke Mousin', term: '2023-11' }, { id: 9, kind: 'theme', name: 'Archduke Mousin' }] } };
export const plainCard = { id: 42, name: 'Lonely Figure', creator_name: 'SW3D', print_status: 'unprinted', images: [], hidden: 0 };

export const hanDetail = {
  id: 41, name: 'Han Solo', kind: 'work', creator_name: 'SW3D', tags: [], images: [], files: [], file_count: 0, notes: '',
  siblings: [{ id: 44, name: 'Han Solo', release_label: '2024' }],
  related: {
    dioramas: [card(40, 'Han and Chewie', { kind: 'diorama', editions: [], relationId: 501 })],
    characters: [],
    releases: [card(44, 'Han Solo', { release_label: '2024', relationId: 502 })],
    accessories: [card(45, 'Han Blaster', { editions: ['Accessory'], relationId: 503, source: 'user' })],
    accessoryOf: [],
    other: [],
    sets: [{ id: 7, kind: 'release', name: 'The Tale of Archduke Mousin', term: '2023-11' }, { id: 9, kind: 'theme', name: 'Archduke Mousin' }],
  },
  relatedPending: [
    { id: 900, type: 'relation', field: 'features', proposed: 'features', confidence: 0.7, reason: "'Han' is a first name",
      model: { id: 46, name: 'Cantina Dio', creator_name: 'SW3D' }, target: { id: 41, name: 'Han Solo', creator_name: 'SW3D' } },
  ],
};

export const setsList = {
  items: [
    { id: 'diorama-40', kind: 'diorama', name: 'Han and Chewie', creator: 'SW3D', counts: { cards: 3 },
      diorama: { id: 40, name: 'Han and Chewie', kind: 'diorama' },
      members: [{ id: 41, name: 'Han Solo' }, { id: 43, name: 'Chewbacca' }], accessories: [{ id: 45, name: 'Han Blaster', editions: ['Accessory'] }] },
    { id: 7, kind: 'release', name: 'The Tale of Archduke Mousin', creator: 'Lord of the Print', term: '2023-11', counts: { cards: 2, releases: 1 },
      members: [{ id: 60, name: 'Archduke Mousin' }, { id: 61, name: 'Great Owl' }] },
    { id: 9, kind: 'theme', name: 'Archduke Mousin', creator: 'Lord of the Print', counts: { cards: 5, releases: 2, loose: 1 },
      members: [{ id: 60, name: 'Archduke Mousin' }] },
  ],
  total: 3, page: 1, pages: 1,
};

export const themeDetail = {
  id: 9, kind: 'theme', name: 'Archduke Mousin', creator: 'Lord of the Print',
  releases: [
    { id: 7, name: 'The Tale of Archduke Mousin', term: '2023-11', members: [{ id: 60, name: 'Archduke Mousin' }, { id: 61, name: 'Great Owl' }] },
    { id: 8, name: 'Mousin v2', term: '', members: [{ id: 62, name: 'Weasel Rider' }, { id: 63, name: 'Mousin House' }] },
  ],
  loose: [{ id: 64, name: 'Mice Danger' }],
  pending: [],
};
