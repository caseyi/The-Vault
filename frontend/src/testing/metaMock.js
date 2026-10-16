// Fixtures in the CONTRACT2 / docs/library-metadata.md shapes, plus a tiny
// URL-routing fetch mock. Test-only: nothing in the app imports this file.

export const workItem = {
  id: 12, name: 'Alan Grant', character: 'Alan Grant', kind: 'work',
  studio: 'Wicked', creator_name: 'Wicked', franchise: 'Movies', group_name: 'Jurassic Park',
  editions: ['Bust', 'Sculpture'], libraries: ['Dagobah', 'Endor'],
  release_term: '2026-03', source: 'gumroad', confidence: 'exact',
  print_status: 'unprinted', has_stl: 1, images: [], thumbnail_path: null, hidden: 0,
};

export const dioramaItem = {
  id: 13, name: 'Jurassic Park Gate', kind: 'diorama', studio: 'Wicked', creator_name: 'Wicked',
  editions: [], libraries: ['Dagobah'], release_term: '2025-11', source: 'google-drive', confidence: 'none',
  print_status: 'unprinted', images: [], hidden: 0,
};

export const releaseItem = {
  id: 14, name: 'Orc Warlord', kind: 'release-item', creator_name: 'Loot Studios',
  libraries: ['Endor'], release_term: '2024-07', source: 'patreon', confidence: 'path',
  print_status: 'printed', images: [], hidden: 0,
};

export const legacyItem = { id: 15, name: 'Plain Folder Model', creator_name: 'Someone', print_status: 'unprinted', images: [], hidden: 0 };

export const workDetail = {
  ...workItem,
  file_count: 6, tags: [], notes: '', images: [],
  products: [
    {
      name: 'Wicked Movies Alan Grant Sculpture', edition: 'Sculpture', term: '2026-03',
      termLabel: 'GOOGLE DRIVE WICKED MOVIES MARCH TERM 2026',
      productUrl: 'https://wickedart.gumroad.com/l/xyz', libraryUrl: 'https://gumroad.com/d/f079abc',
      claimed: '2026-03-01', status: 'Claimed (Sep 2 2026)',
      matchedFiles: 6, totalFiles: 8,
      missing: ['Wicked - Alan Grant Sculpture (X Pose Images).zip', 'Wicked - Alan Grant Sculpture (Size and Printing Information).zip'],
    },
    {
      name: 'Wicked Movies Alan Grant Bust', edition: 'Bust', term: '2026-03',
      productUrl: 'https://wickedart.gumroad.com/l/abc', libraryUrl: 'https://gumroad.com/d/b22',
      claimed: '2026-03-02', status: 'Claimed (Sep 2 2026)', matchedFiles: 5, totalFiles: 6, missing: [],
    },
  ],
  attribution: { confidence: 'exact', fields: { franchise: 'manifest', character: 'parse', release_term: 'drive' }, matchedFiles: 11, totalFiles: 14 },
  files: [
    { id: 1, filename: 'Wicked - Alan Grant Sculpture (Chitubox Pre Supported).zip', filetype: 'zip', filesize: 2.5e9, library: 'Endor', variant: 'presupported-chitubox', edition: 'Sculpture' },
    { id: 2, filename: 'Wicked - Alan Grant Sculpture (Non Supported).zip', filetype: 'zip', filesize: 1.2e9, library: 'Dagobah', variant: 'unsupported', edition: 'Sculpture' },
    { id: 3, filename: 'Wicked - Alan Grant Sculpture (X Pose).zip', filetype: 'zip', filesize: 3e8, library: 'Dagobah', variant: 'x-pose', edition: 'Sculpture' },
    { id: 4, filename: 'Wicked - Alan Grant Bust (One Piece).zip', filetype: 'zip', filesize: 8e8, library: 'Endor', variant: 'one-piece', edition: 'Bust' },
    { id: 5, filename: 'Wicked - Alan Grant Bust (Images).zip', filetype: 'zip', filesize: 2e7, library: 'Endor', variant: 'images', edition: 'Bust' },
    { id: 6, filename: 'Wicked - Alan Grant Bust (Non Supported).zip', filetype: 'zip', filesize: 9e8, library: 'Endor', variant: 'unsupported', edition: 'Bust' },
  ],
};

export const facets = {
  libraries: [{ name: 'Dagobah', count: 4100 }, { name: 'Endor', count: 1300 }],
  studios: [{ name: 'Wicked', count: 900 }, { name: 'B3DSERK', count: 120 }, { name: 'SW3D', count: 80 }],
  creators: [{ name: 'Wicked', count: 900 }],
  genres: [{ name: 'Movies', count: 300 }, { name: 'Marvel', count: 250 }],
  terms: [{ name: '2025-11', count: 20 }, { name: '2026-03', count: 31 }, { name: '2026-01', count: 25 }, { name: '2024-07', count: 9 }],
  kinds: [{ name: 'work', count: 1000 }, { name: 'diorama', count: 40 }, { name: 'release-item', count: 800 }, { name: 'tool', count: 12 }],
  sources: [{ name: 'gumroad', count: 700 }, { name: 'google-drive', count: 300 }],
  confidence: [{ name: 'exact', count: 600 }, { name: 'name', count: 100 }, { name: 'sidecar', count: 5 }, { name: 'path', count: 200 }, { name: 'none', count: 95 }],
};

export const attributionSummary = {
  total: 1000,
  byConfidence: { exact: 600, name: 100, sidecar: 5, path: 200, none: 95 },
  byLibrary: [{ name: 'Dagobah', total: 700, attributed: 520 }, { name: 'Endor', total: 300, attributed: 185 }],
  byStudio: [{ name: 'Wicked', total: 800, attributed: 650 }, { name: 'ZEZ', total: 50, attributed: 10 }],
  gaps: 2,
};

export const attributionGaps = {
  products: [
    { creator: 'Wicked', name: 'Wicked Marvel Conan Bust', term: '2026-03', libraryUrl: 'https://gumroad.com/d/zz1', productUrl: 'https://wickedart.gumroad.com/l/conan', files: 7, sizeGB: 4.2 },
    { creator: 'ZEZ', name: 'ZEZ Boba Fett', term: '2025-12', productUrl: 'https://zez.gumroad.com/l/boba', files: 3, sizeGB: 0.5 },
  ],
};

export const metaStatus = {
  dirs: ['/library/STL Archive/_Meta'], loadedAt: '2026-10-15T10:00:00.000Z',
  counts: { products: 1520, productFiles: 9800, tracker: 300, driveFiles: 4000, genreMap: 220, rules: 80, sidecars: 3 },
  errors: [],
};

export const jsonResponse = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

/**
 * Install a fetch mock. `routes` is a list of [matcher, body | (url, opts) => body]
 * where matcher is a string (substring) or RegExp. Unmatched URLs answer `fallback`.
 * A body of `{ __status: 404 }` answers with that status.
 */
export function mockFetch(routes, fallback = {}) {
  global.fetch = jest.fn((url, opts) => {
    const u = String(url);
    for (const [m, body] of routes) {
      const hit = typeof m === 'string' ? u.includes(m) : m.test(u);
      if (!hit) continue;
      const b = typeof body === 'function' ? body(u, opts) : body;
      if (b && b.__status) return jsonResponse({ error: 'Not found' }, b.__status);
      return jsonResponse(b);
    }
    return jsonResponse(fallback);
  });
  return global.fetch;
}
