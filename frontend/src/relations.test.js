import {
  parseSetDetail, setChipLabel, relationBadges, linkForSection, linkBody, relatedSections,
  isRelationsSummary, pendingLabel, setName,
} from './relations';
import { filterParams, activeFilterChips, EMPTY_FILTERS } from './filters';
import { themeDetail, relSummary, hanDio, hanCard, hanDetail } from './testing/relMock';

describe('relations helpers', () => {
  test('parseSetDetail keeps releases {id,name,term,members} and the loose list', () => {
    const d = parseSetDetail(themeDetail);
    expect(d.releases.map(r => r.name)).toEqual(['The Tale of Archduke Mousin', 'Mousin v2']);
    expect(d.releases[0].term).toBe('2023-11');
    expect(d.releases[1].members).toHaveLength(2);
    expect(d.loose.map(c => c.name)).toEqual(['Mice Danger']);
    expect(parseSetDetail(null)).toEqual({ releases: [], loose: [], pending: [], members: [] });
    expect(parseSetDetail({ releases: [{ name: 'X' }] }).releases[0]).toEqual({ id: 'r0', name: 'X', term: '', members: [] });
  });

  test('set chip labels', () => {
    expect(setChipLabel({ kind: 'release', name: 'The Tale of Archduke Mousin', term: '2023-11' })).toBe('Release: The Tale of Archduke Mousin (2023-11)');
    expect(setChipLabel({ kind: 'release', name: '2023-11 - Tale', term: '2023-11' })).toBe('Release: 2023-11 - Tale');
    expect(setChipLabel({ kind: 'theme', name: 'Archduke Mousin' })).toBe('Theme: Archduke Mousin');
  });

  test('badges: dioramas show Features N, figures show In N dioramas', () => {
    expect(relationBadges(hanDio).map(b => b.label)).toEqual(['Features 2']);
    expect(relationBadges(hanCard).map(b => b.label)).toEqual(['In 1 diorama']);
    expect(relationBadges({ id: 1 })).toEqual([]);
  });

  test('undo bodies follow the section direction', () => {
    expect(linkForSection('dioramas', 41, { id: 40 })).toEqual({ type: 'features', fromId: 40, toId: 41 });
    expect(linkForSection('characters', 40, { id: 41 })).toEqual({ type: 'features', fromId: 40, toId: 41 });
    expect(linkForSection('releases', 44, { id: 41 })).toEqual({ type: 'release-of', fromId: 41, toId: 44 });
    expect(linkForSection('accessories', 41, { id: 45 })).toEqual({ type: 'accessory-of', fromId: 45, toId: 41 });
    expect(linkForSection('accessoryOf', 45, { id: 41 })).toEqual({ type: 'accessory-of', fromId: 45, toId: 41 });
    expect(linkBody('in-diorama', 41, 40)).toEqual({ type: 'features', fromId: 40, toId: 41 });
    expect(linkBody('features', 40, 41)).toEqual({ type: 'features', fromId: 40, toId: 41 });
  });

  test('sections, summary detection, pending labels', () => {
    expect(relatedSections(hanDetail.related).map(s => s.label)).toEqual(['Dioramas', 'Other releases', 'Accessories']);
    expect(isRelationsSummary(relSummary)).toBe(true);
    expect(isRelationsSummary({})).toBe(false);
    expect(isRelationsSummary({ error: 'Not found' })).toBe(false);
    expect(pendingLabel(hanDetail.relatedPending[0], 41)).toBe('Appears in diorama Cantina Dio');
    expect(setName({ type: 'set', set: { id: 9, name: 'Tavern' } })).toBe('Tavern');
    expect(setName({ type: 'set-member', set: 'Tavern' })).toBe('Tavern');
  });

  test('relation filters map to query params and chips', () => {
    const f = { ...EMPTY_FILTERS, inDiorama: true, features: true, hasReleases: true, hasAccessories: true, hasRelations: true,
      relatedTo: '41', relatedToName: 'Han Solo', set: '9', setName: 'Theme: Archduke Mousin', inSet: 'theme', noTheme: true };
    const p = filterParams(f);
    expect(p).toMatchObject({ inDiorama: '1', features: '1', hasReleases: '1', hasAccessories: '1', hasRelations: '1', relatedTo: '41', set: '9', inSet: 'theme', noTheme: '1' });
    expect(p.relatedToName).toBeUndefined();
    expect(p.setName).toBeUndefined();
    const chips = activeFilterChips(f);
    const rel = chips.find(c => c.key === 'relatedTo');
    expect(`${rel.label}: ${rel.value}`).toBe('Related to: Han Solo');
    expect(rel.clear(f)).toMatchObject({ relatedTo: '', relatedToName: '' });
    expect(chips.find(c => c.key === 'set').value).toBe('Theme: Archduke Mousin');
    expect(chips.find(c => c.key === 'inDiorama').clear(f).inDiorama).toBe(false);
    expect(Object.keys(filterParams(EMPTY_FILTERS))).toEqual([]);
  });
});
