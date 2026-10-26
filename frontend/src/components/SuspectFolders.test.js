import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import OrganizeModal from './OrganizeModal';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { suspects, dismissedSuspect, postsTo } from '../testing/rolesMock';

const health = {
  summary: { total: 3, crossCreatorDupes: 0, duplicatePairs: 0, noTags: 0, noThumbnail: 0, noFranchise: 0, emptyFolders: 0, noSource: 0 },
  crossCreatorDupes: [], duplicates: [], noTags: [], noThumbnail: [], noFranchise: [], emptyFolders: [], noSource: [],
};

const setup = (extra = []) => mockFetch([
  ...extra,
  ['/api/organize/health', health],
  ['/api/attribution/summary', { __status: 404 }],
  ['/api/folder-roles/suspects/dismiss', { ok: true }],
  ['/api/folder-roles/suspects?dismissed=1', { items: [...suspects.items, dismissedSuspect] }],
  ['/api/folder-roles/suspects', suspects],
  ['/api/folder-roles', { ok: true, rescan: true }],
  ['/api/scan', { message: 'Scan started' }],
], []);

const openSuspects = async (props = {}) => {
  render(<NoticeProvider><OrganizeModal onClose={() => {}} {...props} /></NoticeProvider>);
  fireEvent.click(screen.getByRole('tab', { name: /Health/ }));
  const tab = await screen.findByRole('tab', { name: /Suspect Folders/ });
  expect(within(tab).getByText('2')).toBeInTheDocument();
  fireEvent.click(tab);
  return screen.findByRole('list', { name: 'Suspect folders' });
};

describe('Health → Suspect folders', () => {
  test('lists reason, sample sub-folders and counts; one click marks the suggested role', async () => {
    const f = setup();
    const list = await openSuspects();
    const row = within(list).getByRole('listitem', { name: 'Suspect folder Misc' });
    expect(within(row).getByText('Card "Misc" holds 412 files from 23 sub-folders')).toBeInTheDocument();
    expect(within(row).getByText('Sub-folders: Bases, Trees, Rocks')).toBeInTheDocument();
    expect(within(row).getByText('412 files · 23 folders')).toBeInTheDocument();
    expect(within(row).getByText('Mixed card')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Mark Misc as Category' }));
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')).toEqual([{ path: '/library/STL Archive/Misc', role: 'category' }]));
    await waitFor(() => expect(within(list).queryByRole('listitem', { name: 'Suspect folder Misc' })).not.toBeInTheDocument());
    // toast offers a rescan
    fireEvent.click(await screen.findByRole('button', { name: 'Rescan now' }));
    await waitFor(() => expect(postsTo(f, '/api/scan')).toEqual([{}]));
  });

  test('the role menu sets any role; Dismiss hides a row; Show dismissed restores', async () => {
    const f = setup();
    const list = await openSuspects();
    const orc = within(list).getByRole('listitem', { name: 'Suspect folder Loot/Orc Warlord' });
    expect(within(orc).getByRole('button', { name: 'Mark Loot/Orc Warlord as Model' })).toBeInTheDocument();
    fireEvent.change(within(orc).getByLabelText('Role for Loot/Orc Warlord'), { target: { value: 'ignore' } });
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')).toEqual([{ path: '/library/STL Archive/Loot/Orc Warlord', role: 'ignore' }]));
    await waitFor(() => expect(within(list).queryByRole('listitem', { name: /Orc Warlord/ })).not.toBeInTheDocument());

    fireEvent.click(within(list).getByRole('button', { name: 'Dismiss Misc' }));
    await waitFor(() => expect(postsTo(f, '/api/folder-roles/suspects/dismiss')).toEqual([{ path: '/library/STL Archive/Misc' }]));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Suspect folder Misc' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Show dismissed'));
    const old = await screen.findByRole('listitem', { name: 'Suspect folder Old' });
    expect(f.mock.calls.some(([u]) => String(u).includes('/api/folder-roles/suspects?dismissed=1'))).toBe(true);
    fireEvent.click(within(old).getByRole('button', { name: 'Restore Old' }));
    await waitFor(() => expect(postsTo(f, '/api/folder-roles/suspects/dismiss')[1]).toEqual({ path: '/library/STL Archive/Old', undo: true }));
  });

  test('Open card goes to the card', async () => {
    setup();
    const onOpenModel = jest.fn();
    const list = await openSuspects({ onOpenModel });
    fireEvent.click(within(list).getByRole('button', { name: 'Open card Misc' }));
    expect(onOpenModel).toHaveBeenCalledWith({ id: 120, name: 'Misc' });
  });

  test('older backend: no section', async () => {
    mockFetch([
      ['/api/organize/health', health],
      ['/api/attribution/summary', { __status: 404 }],
      ['/api/folder-roles/suspects', { __status: 404 }],
    ], []);
    render(<NoticeProvider><OrganizeModal onClose={() => {}} /></NoticeProvider>);
    fireEvent.click(screen.getByRole('tab', { name: /Health/ }));
    await screen.findByText('Total');
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/api/folder-roles/suspects'))).toBe(true));
    expect(screen.queryByRole('tab', { name: /Suspect Folders/ })).not.toBeInTheDocument();
  });
});
