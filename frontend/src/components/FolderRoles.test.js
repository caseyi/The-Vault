import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import FolderRoles from './FolderRoles';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { fsTree, lazyChildren, folderRoles, postsTo } from '../testing/rolesMock';

const setup = (extra = []) => mockFetch([
  ...extra,
  ['/api/organize/fs-tree?path=', lazyChildren],
  ['/api/organize/fs-tree', fsTree],
  ['/api/folder-roles', (u, o) => (o && o.method === 'POST' ? { ok: true, rescan: true, fileOverrides: false } : folderRoles)],
  ['/api/scan', { message: 'Scan started' }],
], {});

const renderPanel = () => render(<NoticeProvider><FolderRoles /></NoticeProvider>);
const tree = () => screen.getByRole('list', { name: 'Library folders' });
const openArchive = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Expand STL Archive' }));
  return within(tree()).findByLabelText('Role for Misc');
};

describe('Folder Roles panel', () => {
  test('offers every role in a labelled menu and saves plain roles to /api/folder-roles', async () => {
    const f = setup();
    renderPanel();
    const sel = await openArchive();
    expect([...sel.options].map(o => o.textContent)).toEqual(['Auto', 'Creator', 'Container', 'Category', 'Model', 'Ignore']);
    expect(within(tree()).getByLabelText('Role for STL Archive')).toHaveValue('passthrough');
    fireEvent.change(sel, { target: { value: 'model' } });
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')).toEqual([{ path: '/library/STL Archive/Misc', role: 'model' }]));
    expect(await screen.findByText(/Misc marked as Model\. It applies on the next scan\./)).toBeInTheDocument();
    // back to Auto clears the app mark
    fireEvent.change(sel, { target: { value: '' } });
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')[1]).toEqual({ path: '/library/STL Archive/Misc', role: null }));
  });

  test('Category saves at once, then genre / group / tags inputs refine it', async () => {
    const f = setup();
    renderPanel();
    const sel = await openArchive();
    fireEvent.change(sel, { target: { value: 'category' } });
    const form = await screen.findByRole('form', { name: 'Category values for Misc' });
    expect(postsTo(f, '/api/folder-roles')[0]).toEqual({ path: '/library/STL Archive/Misc', role: 'category', genre: '', group: '', tags: [] });
    fireEvent.change(within(form).getByLabelText('Genre'), { target: { value: 'Fantasy' } });
    fireEvent.change(within(form).getByLabelText('Group'), { target: { value: 'Heroes' } });
    fireEvent.change(within(form).getByLabelText('Tags'), { target: { value: 'terrain | scenery, bases' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')[1]).toEqual({
      path: '/library/STL Archive/Misc', role: 'category', genre: 'Fantasy', group: 'Heroes', tags: ['terrain', 'scenery', 'bases'],
    }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Category values for Misc' })).not.toBeInTheDocument());
    expect(screen.getByText('genre: Fantasy')).toBeInTheDocument();
    expect(screen.getByText('tags: terrain, scenery, bases')).toBeInTheDocument();
    // the edit button reopens the form
    fireEvent.click(screen.getByRole('button', { name: 'Edit category values for Misc' }));
    expect(screen.getByRole('form', { name: 'Category values for Misc' })).toBeInTheDocument();
  });

  test('a mark from _Meta is read-only, badged, and shows the conflicting app value', async () => {
    setup();
    renderPanel();
    await openArchive();
    const row = within(tree()).getByTitle('/library/STL Archive/Terrain').closest('.role-tree-row');
    expect(within(row).getByText('from _Meta')).toBeInTheDocument();
    expect(within(row).getByText('Category')).toBeInTheDocument();
    expect(within(row).getByText('app: Ignore')).toBeInTheDocument();
    expect(within(row).getByText('tags: terrain')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Edit category/ })).not.toBeInTheDocument();
  });

  test('truncated folders load their children on expand', async () => {
    const f = setup();
    renderPanel();
    await openArchive();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Gumroad Downloads' }));
    expect(await within(tree()).findByLabelText('Role for Some Creator')).toBeInTheDocument();
    expect(f.mock.calls.map(c => String(c[0]))).toContain(`/api/organize/fs-tree?path=${encodeURIComponent('/library/STL Archive/Gumroad Downloads')}&depth=2`);
  });

  test('after a change: Rescan now starts a scan; marked folders and _Meta warnings are listed; export link', async () => {
    const f = setup();
    renderPanel();
    const sel = await openArchive();
    fireEvent.change(sel, { target: { value: 'ignore' } });
    const bar = await screen.findByText(/1 change saved/);
    fireEvent.click(within(bar.closest('.role-rescan-bar')).getByRole('button', { name: /Rescan now/ }));
    await waitFor(() => expect(postsTo(f, '/api/scan')).toEqual([{}]));
    expect(await screen.findByText('Scan started. Progress shows in the sidebar.')).toBeInTheDocument();

    expect(screen.getByText('row 4: path not found: Misc/Old')).toBeInTheDocument();
    expect(screen.getByText('Marked folders')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Export app marks/ })).toHaveAttribute('href', '/api/organizer/export/folder_roles.csv');
  });

  test('Rescan now while a scan runs says so', async () => {
    setup([['/api/scan', { __status: 409 }]]);
    renderPanel();
    fireEvent.change(await openArchive(), { target: { value: 'ignore' } });
    const bar = (await screen.findByText(/1 change saved/)).closest('.role-rescan-bar');
    fireEvent.click(within(bar).getByRole('button', { name: /Rescan now/ }));
    expect(await screen.findByText(/A scan is already running/)).toBeInTheDocument();
  });
});
