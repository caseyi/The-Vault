import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';
import { NoticeProvider } from '../components/Notices';
import { mockFetch } from '../testing/metaMock';
import { modelWithFolders, postsTo } from '../testing/rolesMock';

jest.mock('../components/StlViewer', () => () => <div />);
jest.mock('../components/ClaudeAssistant', () => () => <div />);

const renderDetail = (model) => {
  const f = mockFetch([
    ['/api/folder-roles', { ok: true, rescan: true, fileOverrides: false }],
    [/\/api\/models\/\d+$/, model], ['/api/queue', []], ['/status-log', []], ['/tag-suggestions', []], ['/collections', []],
  ], {});
  render(<NoticeProvider><ModelDetail modelId={model.id} onBack={() => {}} collections={[]} /></NoticeProvider>);
  return f;
};

describe('Card detail → Folders breadcrumb', () => {
  test('shows library root to card folder, each with a role menu; _Meta marks are read-only', async () => {
    renderDetail(modelWithFolders);
    const nav = await screen.findByRole('navigation', { name: 'Card folders' });
    const items = within(nav).getAllByRole('listitem');
    expect(items.map(li => li.querySelector('.folder-crumb-name').textContent)).toEqual(['STL Archive', 'Minis', 'Heroes']);
    expect(items[2]).toHaveAttribute('aria-current', 'location');
    expect(within(nav).getByLabelText('Role for STL Archive')).toHaveValue('passthrough');
    expect(within(nav).getByLabelText('Role for Heroes')).toHaveValue('');
    expect(within(items[1]).getByText('from _Meta')).toBeInTheDocument();
    expect(within(items[1]).queryByRole('combobox')).not.toBeInTheDocument();
  });

  test('"this card is really the Heroes category" is one change from the card', async () => {
    const f = renderDetail(modelWithFolders);
    const sel = await screen.findByLabelText('Role for Heroes');
    fireEvent.change(sel, { target: { value: 'category' } });
    await waitFor(() => expect(postsTo(f, '/api/folder-roles')).toEqual([
      { path: '/library/STL Archive/Minis/Heroes', role: 'category', genre: '', group: '', tags: [] },
    ]));
    expect(await screen.findByText('Heroes marked as Category. It applies on the next scan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescan now' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Category values for Heroes' })).toBeInTheDocument();
  });

  test('no folderRoles (older backend): no Folders section', async () => {
    renderDetail({ ...modelWithFolders, folderRoles: undefined, files: [{ id: 1, filename: 'a.stl', filetype: 'stl', filesize: 10 }] });
    expect(await screen.findByText('a.stl')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Card folders' })).not.toBeInTheDocument();
  });
});
