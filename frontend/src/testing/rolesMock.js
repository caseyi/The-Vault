// Fixtures in the CONTRACT4 / docs/folder-roles.md §6 shapes. Test-only.

const L = '/library/STL Archive';

export const fsTree = {
  path: '/library', name: 'library', dirCount: 1, fileCount: 0, role: null,
  children: [
    {
      path: L, name: 'STL Archive', dirCount: 3, fileCount: 0, role: 'passthrough', source: 'app',
      children: [
        { path: `${L}/Misc`, name: 'Misc', dirCount: 23, fileCount: 412, role: null, children: [] },
        {
          path: `${L}/Terrain`, name: 'Terrain', dirCount: 4, fileCount: 30, role: 'category', source: 'file',
          conflict: { role: 'ignore' }, genre: null, group: null, tags: ['terrain'], children: [],
        },
        { path: `${L}/Gumroad Downloads`, name: 'Gumroad Downloads', dirCount: 9, fileCount: 0, role: null, truncated: true, children: [] },
      ],
    },
  ],
};

export const lazyChildren = {
  path: `${L}/Gumroad Downloads`, name: 'Gumroad Downloads',
  children: [{ path: `${L}/Gumroad Downloads/Some Creator`, name: 'Some Creator', dirCount: 2, fileCount: 8, role: null, children: [] }],
};

export const folderRoles = {
  roles: [
    { path: `${L}/Terrain`, library: 'Dagobah', rel: 'Terrain', role: 'category', genre: null, group: null, tags: ['terrain'], note: '', source: 'file', conflict: { role: 'ignore' } },
    { path: L, library: 'Dagobah', rel: '', role: 'passthrough', genre: null, group: null, tags: [], note: '', source: 'app' },
  ],
  files: [{ library: 'Dagobah', path: `${L}/_Meta/folder_roles.csv`, rows: 5, errors: ['row 4: path not found: Misc/Old'] }],
};

export const suspects = {
  items: [
    {
      path: `${L}/Misc`, library: 'Dagobah', rel: 'Misc', name: 'Misc',
      reason: 'Card "Misc" holds 412 files from 23 sub-folders', rule: 'mixed',
      suggestedRole: 'category', confidence: 0.8, cardId: 120, cardName: 'Misc',
      files: 412, folders: 23, sample: ['Bases', 'Trees', 'Rocks'], dismissed: false,
    },
    {
      path: `${L}/Loot/Orc Warlord`, library: 'Dagobah', rel: 'Loot/Orc Warlord', name: 'Orc Warlord',
      reason: '7 cards with 1-2 part files (Arm L, Head, Base)', rule: 'tiny-siblings',
      suggestedRole: 'model', confidence: 0.7, files: 12, folders: 7, sample: ['Arm L', 'Head'], dismissed: false,
    },
  ],
};

export const dismissedSuspect = {
  path: `${L}/Old`, library: 'Dagobah', rel: 'Old', name: 'Old', reason: 'Card "Old" looks like a category',
  rule: 'category-name', suggestedRole: 'category', confidence: 0.6, files: 3, folders: 1, sample: [], dismissed: true,
};

export const roleSuggestion = {
  id: 77, type: 'role', field: 'folder_role', current: null, proposed: 'category',
  path: `${L}/Misc/Terrain`, rel: 'Misc/Terrain',
  model: { id: 120, name: 'Terrain', creator_name: 'Unsorted', thumbnail_path: null },
  confidence: 0.86, reason: 'Holds 30 unrelated terrain pieces', source: 'text', runId: 4, status: 'pending',
};

export const modelWithFolders = {
  id: 120, name: 'Heroes', creator_name: 'Unsorted', tags: [], images: [], file_count: 40, files: [],
  folderRoles: [
    { path: L, rel: '', name: 'STL Archive', role: 'passthrough', source: 'app' },
    { path: `${L}/Minis`, rel: 'Minis', name: 'Minis', role: 'category', source: 'file' },
    { path: `${L}/Minis/Heroes`, rel: 'Minis/Heroes', name: 'Heroes', role: null, source: null },
  ],
};

/** Parsed JSON bodies of POSTs to a URL substring. */
export const postsTo = (fetchMock, part) => fetchMock.mock.calls
  .filter(([u, o]) => String(u).includes(part) && o && o.method === 'POST')
  .map(([, o]) => (o.body ? JSON.parse(o.body) : undefined));
