import {
  formatTerm, groupTermsByYear, explainConfidence, variantLabel, compareVariants,
  cardEditions, multiLibraryLabel, asList, isAttributed,
} from './library';
import { filterParams, activeFilterChips, EMPTY_FILTERS } from './filters';

describe('library helpers', () => {
  test('formatTerm renders YYYY-MM as "Mon YYYY" and passes other values through', () => {
    expect(formatTerm('2026-03')).toBe('Mar 2026');
    expect(formatTerm('2025-12', { short: true })).toBe('Dec');
    expect(formatTerm('Vol. IV')).toBe('Vol. IV');
    expect(formatTerm(null)).toBe('');
  });

  test('groupTermsByYear groups newest year first, newest month first, odd terms last', () => {
    const g = groupTermsByYear([{ name: '2025-11', count: 1 }, { name: '2026-01', count: 2 }, { name: 'Bundle', count: 3 }, { name: '2026-03', count: 4 }]);
    expect(g.map(x => x.year)).toEqual(['2026', '2025', 'Other']);
    expect(g[0].terms.map(t => t.label)).toEqual(['Mar', 'Jan']);
  });

  test('explainConfidence speaks plainly', () => {
    expect(explainConfidence({ confidence: 'exact', matchedFiles: 11, totalFiles: 14 }))
      .toBe('Matched 11 of 14 files to your Gumroad purchases by exact size.');
    expect(explainConfidence({ confidence: 'exact', matchedFiles: 2, totalFiles: 2 }, { source: 'google-drive' }))
      .toMatch(/Google Drive listing/);
    expect(explainConfidence({ confidence: 'none' })).toMatch(/No purchase record/);
    expect(explainConfidence(null)).toBe('');
  });

  test('variant labels and ordering', () => {
    expect(variantLabel('presupported-chitubox')).toBe('Pre-supported (Chitubox)');
    expect(variantLabel('unsupported')).toBe('Non Supported');
    expect(variantLabel('32mm')).toBe('32mm');
    expect(variantLabel(null)).toBe('Other files');
    const sorted = ['images', 'x-pose', 'unsupported', 'presupported-chitubox', 'one-piece'].sort(compareVariants);
    expect(sorted).toEqual(['unsupported', 'one-piece', 'presupported-chitubox', 'x-pose', 'images']);
    expect(['75mm', 'supported', '32mm-unsupported', '32mm'].sort(compareVariants)).toEqual(['32mm', '32mm-unsupported', '75mm', 'supported']);
  });

  test('card editions, libraries, attribution helpers tolerate missing fields', () => {
    expect(cardEditions({ editions: ['Bust', 'Sculpture'] })).toEqual(['Sculpture', 'Bust']);
    expect(cardEditions({ kind: 'diorama' })).toEqual(['Diorama']);
    expect(cardEditions({ editions: '["Accessory"]' })).toEqual(['Accessory']);
    expect(cardEditions({})).toEqual([]);
    expect(multiLibraryLabel({ libraries: ['Dagobah', 'Endor'] })).toBe('Dagobah + Endor');
    expect(multiLibraryLabel({ libraries: ['Dagobah'] })).toBe('');
    expect(multiLibraryLabel({})).toBe('');
    expect(asList(undefined)).toEqual([]);
    expect(isAttributed('exact')).toBe(true);
    expect(isAttributed('path')).toBe(false);
  });
});

describe('metadata filters', () => {
  test('filterParams maps every new facet to its query param', () => {
    const p = filterParams({ ...EMPTY_FILTERS, library: 'Endor', studio: 'Wicked', franchise: 'Movies', term: '2026-03', kind: 'diorama', source: 'gumroad', attributed: 'no' });
    expect(p).toEqual({ library: 'Endor', studio: 'Wicked', franchise: 'Movies', term: '2026-03', kind: 'diorama', source: 'gumroad', attributed: 'no' });
    expect(filterParams(EMPTY_FILTERS)).toEqual({});
  });

  test('chips label the new facets in plain words and clear one at a time', () => {
    const f = { ...EMPTY_FILTERS, library: 'Endor', term: '2026-03', kind: 'release-item', attributed: 'no', source: 'google-drive', studio: 'SW3D' };
    const chips = activeFilterChips(f);
    const text = chips.map(c => `${c.label}:${c.value}`);
    expect(text).toEqual(expect.arrayContaining(['Library:Endor', 'Term:Mar 2026', 'Kind:Release items', 'Attribution:Unattributed', 'Source:Google Drive', 'Studio:SW3D']));
    const termChip = chips.find(c => c.key === 'term');
    expect(termChip.clear(f)).toEqual({ ...f, term: '' });
  });
});
