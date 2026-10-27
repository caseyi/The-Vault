import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';
import { NoticeProvider } from '../components/Notices';
import { EMPTY_FILTERS } from '../filters';
import { mockFetch } from '../testing/metaMock';
import { relSummary, hanDio, hanCard, plainCard, setsList, themeDetail } from '../testing/relMock';

const models = { models: [hanDio, hanCard, plainCard], total: 3, pages: 1, page: 1 };
const props = { onModelClick: jest.fn(), showHidden: false, onRefreshStats: jest.fn() };
const cardFor = (name) => screen.getByRole('button', { name: `Open ${name}` }).closest('.model-card');
const renderGallery = (extra = {}) => render(
  <NoticeProvider><Gallery {...props} filters={{ ...EMPTY_FILTERS }} onFilterChange={jest.fn()} relations={relSummary} {...extra} /></NoticeProvider>,
);

beforeEach(() => { try { localStorage.clear(); } catch {} jest.clearAllMocks(); });

describe('Gallery relation badges and set chips', () => {
  beforeEach(() => { mockFetch([['/api/models', models]]); });

  test('dioramas show Features N, figures In N dioramas; clicking sets relatedTo', async () => {
    const onFilterChange = jest.fn();
    renderGallery({ onFilterChange });
    await screen.findByText('Lonely Figure');
    const dio = within(cardFor('Han and Chewie'));
    fireEvent.click(dio.getByRole('button', { name: /Features 2/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ relatedTo: '40', relatedToName: 'Han and Chewie' }));
    expect(props.onModelClick).not.toHaveBeenCalled();
    fireEvent.click(within(cardFor('Han Solo')).getByRole('button', { name: /In 1 diorama/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ relatedTo: '41' }));
    expect(cardFor('Lonely Figure').querySelector('.card-rel-badges')).toBeNull();
  });

  test('set chips filter the gallery to the set', async () => {
    const onFilterChange = jest.fn();
    renderGallery({ onFilterChange });
    await screen.findByText('Han Solo');
    const han = within(cardFor('Han Solo'));
    expect(han.getByText('Release: The Tale of Archduke Mousin (2023-11)')).toBeInTheDocument();
    fireEvent.click(han.getByRole('button', { name: 'Show set Theme: Archduke Mousin' }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ set: '9', setName: 'Theme: Archduke Mousin' }));
  });

  test('relation chips appear in the active filter bar and as query params', async () => {
    renderGallery({ filters: { ...EMPTY_FILTERS, relatedTo: '41', relatedToName: 'Han Solo', inDiorama: true } });
    await screen.findByText('Han Solo');
    const bar = screen.getByLabelText('Active filters');
    expect(bar).toHaveTextContent('Related to');
    expect(bar).toHaveTextContent('In a diorama');
    const url = global.fetch.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/api/models?'));
    expect(url).toContain('relatedTo=41');
    expect(url).toContain('inDiorama=1');
    expect(screen.getByText('⬇ CSV').getAttribute('href')).toContain('relatedTo=41');
  });

  test('no Cards | Sets toggle or bulk Add to set without the relations summary', async () => {
    render(<NoticeProvider><Gallery {...props} filters={{ ...EMPTY_FILTERS }} onFilterChange={jest.fn()} relations={null} /></NoticeProvider>);
    await screen.findByText('Han Solo');
    expect(screen.queryByRole('group', { name: 'Gallery view' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '⊡ Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Han Solo' }));
    expect(screen.queryByRole('button', { name: /Add to set/ })).not.toBeInTheDocument();
  });
});

describe('Gallery bulk Add to set', () => {
  test('adds the selection to an existing theme or a new one', async () => {
    const calls = [];
    mockFetch([
      ['/api/models', models],
      [/\/api\/sets\/9\/members$/, (u, o) => { calls.push([u, o]); return { added: 2 }; }],
      [/\/api\/sets\?/, { items: [{ id: 9, kind: 'theme', name: 'Archduke Mousin' }], total: 1 }],
      [/\/api\/sets$/, (u, o) => { calls.push([u, o]); return { id: 12, name: 'Tavern' }; }],
    ]);
    renderGallery();
    await screen.findByText('Han Solo');
    fireEvent.click(screen.getByRole('button', { name: '⊡ Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Han Solo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Lonely Figure' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    fireEvent.click(within(bar).getByRole('button', { name: /Add to set/ }));
    fireEvent.click(await within(bar).findByRole('button', { name: 'Archduke Mousin' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0][1].method).toBe('POST');
    expect(JSON.parse(calls[0][1].body)).toEqual({ ids: [41, 42] });

    fireEvent.click(within(bar).getByRole('button', { name: /Add to set/ }));
    fireEvent.change(within(bar).getByLabelText('NEW THEME'), { target: { value: 'Tavern' } });
    fireEvent.click(within(bar).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1][0]).toBe('/api/sets');
    expect(JSON.parse(calls[1][1].body)).toEqual({ name: 'Tavern', ids: [41, 42] });
  });
});

describe('Gallery Sets view', () => {
  test('Cards | Sets toggle shows diorama, release and theme rows (theme grouped by release, then loose)', async () => {
    mockFetch([['/api/models', models], [/\/api\/sets\/9$/, themeDetail], [/\/api\/sets\?/, setsList]]);
    const onModelClick = jest.fn();
    renderGallery({ onModelClick });
    await screen.findByText('Han Solo');
    fireEvent.click(within(screen.getByRole('group', { name: 'Gallery view' })).getByRole('button', { name: 'Sets' }));

    const dio = await screen.findByRole('region', { name: 'Han and Chewie' });
    const dioCards = within(dio).getAllByRole('button', { name: /^Open / }).map(b => b.getAttribute('aria-label'));
    expect(dioCards).toEqual(['Open Han and Chewie', 'Open Han Solo', 'Open Chewbacca', 'Open Han Blaster']);
    expect(dio.querySelector('.set-row-head .set-chip')).toHaveTextContent('Diorama');

    const rel = screen.getByRole('region', { name: 'The Tale of Archduke Mousin' });
    expect(rel).toHaveTextContent('Lord of the Print');
    expect(rel).toHaveTextContent('Nov 2023');
    expect(within(rel).getAllByRole('button', { name: /^Open / })).toHaveLength(2);

    const theme = screen.getByRole('region', { name: 'Archduke Mousin' });
    expect(await within(theme).findByText('Loose cards')).toBeInTheDocument();
    expect(within(theme).getByRole('list', { name: 'Mousin v2 cards' })).toBeInTheDocument();
    expect(within(theme).getByRole('list', { name: 'Archduke Mousin loose cards' })).toHaveTextContent('Mice Danger');
    expect(theme).toHaveTextContent('2 releases');

    fireEvent.click(within(theme).getByRole('button', { name: 'Open Mice Danger' }));
    expect(onModelClick).toHaveBeenCalledWith(expect.objectContaining({ id: 64 }));
    // the bulk Select is not offered on the Sets view
    expect(screen.queryByRole('button', { name: '⊡ Select' })).not.toBeInTheDocument();
  });

  test('kind filter and "Show figures without a diorama" are sent to /api/sets', async () => {
    mockFetch([['/api/models', models], [/\/api\/sets\?/, (u) => (u.includes('includeSolo')
      ? { ...setsList, items: [setsList.items[0]], solo: [{ id: 42, name: 'Lonely Figure' }], soloTotal: 1 }
      : { ...setsList, items: [setsList.items[0]] })]]);
    try { localStorage.setItem('vault_gallery_view', 'sets'); } catch {}
    renderGallery({ filters: { ...EMPTY_FILTERS, creator: 'SW3D' } });
    await screen.findByRole('region', { name: 'Han and Chewie' });
    fireEvent.change(screen.getByLabelText('Set kind'), { target: { value: 'diorama' } });
    fireEvent.click(screen.getByLabelText('Show figures without a diorama'));
    const solo = await screen.findByRole('region', { name: 'Figures without a diorama' });
    expect(solo).toHaveTextContent('Lonely Figure');
    const urls = global.fetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/sets?'));
    const last = new URLSearchParams(urls[urls.length - 1].split('?')[1]);
    expect(last.get('kind')).toBe('diorama');
    expect(last.get('includeSolo')).toBe('1');
    expect(last.get('creator')).toBe('SW3D');
  });
});
