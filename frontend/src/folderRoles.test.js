import { roleLabel, roleValue, splitTags, saveFolderRole, roleSuggestionText, savedMessage } from './folderRoles';
import { mockFetch } from './testing/metaMock';
import { postsTo } from './testing/rolesMock';

describe('folderRoles helpers', () => {
  test('labels, the container alias and tag splitting', () => {
    expect(roleLabel(null)).toBe('Auto');
    expect(roleLabel('passthrough')).toBe('Container');
    expect(roleLabel('container')).toBe('Container');
    expect(roleValue('container')).toBe('passthrough');
    expect(splitTags('a | b, c,,')).toEqual(['a', 'b', 'c']);
    expect(splitTags(['x', ' y '])).toEqual(['x', 'y']);
    expect(roleSuggestionText({ rel: 'Misc/Terrain', proposed: 'category' })).toBe('Mark Misc/Terrain as Category');
    expect(roleSuggestionText({ path: '/library/A/B/C', proposed: 'model' })).toBe('Mark B/C as Model');
    expect(savedMessage('Misc', 'ignore', { fileOverrides: true })).toMatch(/the file wins/);
    expect(savedMessage('Misc', null, {})).toBe('Misc set back to Auto. It applies on the next scan.');
  });

  test('only category marks carry genre / group / tags', async () => {
    const f = mockFetch([['/api/folder-roles', { ok: true, rescan: true }]]);
    await saveFolderRole({ path: '/p', role: 'model', genre: 'X', tags: 'a' });
    await saveFolderRole({ path: '/p', role: 'category', genre: 'Marvel', group: '', tags: 'a|b' });
    expect(postsTo(f, '/api/folder-roles')).toEqual([
      { path: '/p', role: 'model' },
      { path: '/p', role: 'category', genre: 'Marvel', group: '', tags: ['a', 'b'] },
    ]);
  });

  test('older backend without /api/folder-roles falls back to folder-overrides', async () => {
    global.fetch = jest.fn((url) => Promise.resolve(String(url) === '/api/folder-roles'
      ? { ok: false, status: 404, headers: { get: () => 'text/html' }, text: () => Promise.resolve('Cannot POST'), json: () => Promise.reject(new Error('x')) }
      : { ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ ok: true }) }));
    const r = await saveFolderRole({ path: '/p', role: 'ignore' });
    expect(r).toEqual({ ok: true, rescan: true });
    expect(postsTo(global.fetch, '/api/organize/folder-overrides')).toEqual([{ path: '/p', role: 'ignore' }]);
  });
});
