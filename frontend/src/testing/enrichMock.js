// Fixtures in the CONTRACT3 shapes (AI enrichment). Test-only.

export const estimate = {
  model: 'claude-haiku-4-5-20251001', toProcess: 812, unchanged: 3652, batches: 21,
  text: { inTokens: 410000, outTokens: 60000, usd: 0.71 },
  vision: { maxItems: 140, inTokens: 238000, outTokens: 9800, usd: 0.29, note: 'Only cards the text pass could not resolve' },
  totalUsd: 1.0, perCard: { evidenceTokens: 139, systemTokens: 1110 },
};

export const summary = {
  pending: 120, byType: { field: 100, merge: 15, rename: 5 },
  byField: { character: 30, franchise: 40, group_name: 20, name: 5, tags: 10 },
  byConfidence: { high: 60, medium: 50, low: 10 },
};

const card = (id, name, creator = 'Wicked', extra = {}) => ({ id, name, creator_name: creator, thumbnail_path: null, kind: 'work', ...extra });

export const mergeItem = {
  id: 10, type: 'merge', field: null, model: card(40, 'Geral'), target: card(41, 'Geralt'),
  confidence: 0.88, reason: 'typo of Geralt of Rivia; same creator and genre', source: 'text', runId: 3, status: 'pending',
};
export const mergeItem2 = {
  id: 11, type: 'merge', field: null, model: card(42, 'Doct Oct'), target: card(43, 'Doctor Octopus'),
  confidence: 0.7, reason: 'Doc Ock', source: 'vision', runId: 3, status: 'pending',
};
export const genreItems = [
  { id: 9, type: 'field', field: 'franchise', model: card(12, 'Alan Scott'), current: 'Star Wars', proposed: 'DC', confidence: 0.93, reason: 'Green Lantern (Golden Age) is a DC character', source: 'text', runId: 3, status: 'pending' },
  { id: 21, type: 'field', field: 'franchise', model: card(13, 'Ciri'), current: 'Movies', proposed: 'Video Games', confidence: 0.84, reason: 'Ciri is Video Games, not Movies', source: 'text', runId: 3, status: 'pending' },
  { id: 22, type: 'field', field: 'franchise', model: card(14, 'Angela'), current: 'Marvel', proposed: 'Other Comics', confidence: 0.6, reason: 'Image Comics', source: 'vision', runId: 3, status: 'pending' },
];
export const tagItem = { id: 30, type: 'field', field: 'tags', model: card(15, 'Ken'), current: ['type:bust'], proposed: ['type:bust', 'theme:movie'], confidence: 0.82, reason: 'Barbie movie', source: 'text', runId: 3, status: 'pending' };

export const modelDetails = {
  40: { id: 40, name: 'Geral', creator_name: 'Wicked', release_label: 'Netflix', release_term: null, file_count: 6, libraries: ['Endor'], editions: ['Bust'] },
  41: { id: 41, name: 'Geralt', creator_name: 'Wicked', release_label: 'GOOGLE DRIVE WICKED MARCH TERM 2026', release_term: '2026-03', file_count: 14, libraries: ['Dagobah', 'Endor'], editions: ['Sculpture', 'Bust'] },
};

export const runs = { runs: [
  { id: 3, startedAt: '2026-10-16 08:45:40', finishedAt: '2026-10-16 08:46:13', model: 'claude-haiku-4-5-20251001', scope: 'all', status: 'complete', toProcess: 812, applied: 412, suggested: 120, merges: 15, undone: false },
  { id: 2, startedAt: '2026-10-15 08:00:00', finishedAt: '2026-10-15 08:01:00', model: 'claude-haiku-4-5-20251001', scope: 'creator', status: 'complete', applied: 4, suggested: 1, merges: 0, undone: true },
] };

export const exportList = {
  generatedAt: '2026-10-16T08:47:54.333Z', since: null, cursor: '2026-10-16T08:47:54.333Z',
  files: [
    { name: 'genre_map.csv', url: '/api/organizer/export/genre_map.csv', rows: 31 },
    { name: 'filing_rules.csv', url: '/api/organizer/export/filing_rules.csv', rows: 341 },
    { name: 'model_json.ndjson', url: '/api/organizer/export/model_json.ndjson', rows: 397 },
    { name: 'moves.csv', url: '/api/organizer/export/moves.csv', rows: 237 },
  ],
};

/** Minimal EventSource stand-in; tests push events with `emit`. */
export class FakeEventSource {
  static instances = [];
  constructor(url) { this.url = url; this.closed = false; FakeEventSource.instances.push(this); }
  emit(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
  fail() { if (this.onerror) this.onerror(new Event('error')); }
  close() { this.closed = true; }
}
