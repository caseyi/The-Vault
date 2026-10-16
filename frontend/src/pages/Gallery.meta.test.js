import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';
import { EMPTY_FILTERS } from '../filters';
import { mockFetch, workItem, dioramaItem, releaseItem, legacyItem } from '../testing/metaMock';

const models = { models: [workItem, dioramaItem, releaseItem, legacyItem], total: 4, pages: 1, page: 1 };
const props = { onFilterChange: jest.fn(), onModelClick: jest.fn(), showHidden: false, onRefreshStats: jest.fn() };
const cardFor = (name) => screen.getByRole('button', { name: `Open ${name}` }).closest('.model-card');
const modelUrls = () => global.fetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/models?'));

describe('Gallery work cards', () => {
  beforeEach(() => { mockFetch([['/api/models', models]]); });

  test('cards show editions, a multi-library badge and the release term', async () => {
    render(<Gallery {...props} filters={{ ...EMPTY_FILTERS }} />);
    await screen.findByText('Alan Grant');
    const work = within(cardFor('Alan Grant'));
    expect(work.getByText('Sculpture')).toBeInTheDocument();
    expect(work.getByText('Bust')).toBeInTheDocument();
    expect(work.getByText('Dagobah + Endor')).toBeInTheDocument();
    expect(work.getByText('Mar 2026')).toBeInTheDocument();
    // Editions sorted Sculpture before Bust
    const chips = cardFor('Alan Grant').querySelectorAll('.edition-chip');
    expect([...chips].map(c => c.textContent)).toEqual(['Sculpture', 'Bust']);
  });

  test('dioramas get a Diorama chip; single-library works have no library badge', async () => {
    render(<Gallery {...props} filters={{ ...EMPTY_FILTERS }} />);
    await screen.findByText('Jurassic Park Gate');
    const d = within(cardFor('Jurassic Park Gate'));
    expect(d.getByText('Diorama')).toBeInTheDocument();
    expect(cardFor('Jurassic Park Gate').querySelector('.library-badge')).toBeNull();
    expect(within(cardFor('Orc Warlord')).getByText('Release item')).toBeInTheDocument();
  });

  test('legacy models (no metadata fields) render without chips', async () => {
    render(<Gallery {...props} filters={{ ...EMPTY_FILTERS }} />);
    await screen.findByText('Plain Folder Model');
    expect(cardFor('Plain Folder Model').querySelector('.card-meta')).toBeNull();
  });

  test('confidence stays hidden unless the Attribution filter is on', async () => {
    const { unmount } = render(<Gallery {...props} filters={{ ...EMPTY_FILTERS }} />);
    await screen.findByText('Jurassic Park Gate');
    expect(screen.queryByText(/unattributed/)).not.toBeInTheDocument();
    unmount();
    render(<Gallery {...props} filters={{ ...EMPTY_FILTERS, attributed: 'no' }} />);
    await screen.findByText('Jurassic Park Gate');
    expect(within(cardFor('Jurassic Park Gate')).getByText(/unattributed/)).toBeInTheDocument();
    expect(within(cardFor('Orc Warlord')).getByText(/unattributed/)).toBeInTheDocument();
    expect(within(cardFor('Alan Grant')).queryByText(/unattributed/)).not.toBeInTheDocument();
    expect(within(cardFor('Plain Folder Model')).queryByText(/unattributed/)).not.toBeInTheDocument();
  });

  test('metadata filters are sent as query params (and in the CSV export link)', async () => {
    const filters = { ...EMPTY_FILTERS, library: 'Endor', studio: 'Wicked', franchise: 'Movies', term: '2026-03', kind: 'work', source: 'gumroad', attributed: 'yes' };
    render(<Gallery {...props} filters={filters} />);
    await waitFor(() => expect(modelUrls().length).toBeGreaterThan(0));
    const qs = new URLSearchParams(modelUrls()[0].split('?')[1]);
    expect(qs.get('library')).toBe('Endor');
    expect(qs.get('studio')).toBe('Wicked');
    expect(qs.get('franchise')).toBe('Movies');
    expect(qs.get('term')).toBe('2026-03');
    expect(qs.get('kind')).toBe('work');
    expect(qs.get('source')).toBe('gumroad');
    expect(qs.get('attributed')).toBe('yes');
    expect(screen.getByText('⬇ CSV').getAttribute('href')).toContain('library=Endor');
    const bar = screen.getByLabelText('Active filters');
    expect(bar).toHaveTextContent('Mar 2026');
    expect(bar).toHaveTextContent('Attributed');
  });

  test('no metadata params when no metadata filter is set', async () => {
    render(<Gallery {...props} filters={{ ...EMPTY_FILTERS }} />);
    await waitFor(() => expect(modelUrls().length).toBeGreaterThan(0));
    const qs = new URLSearchParams(modelUrls()[0].split('?')[1]);
    for (const k of ['library', 'studio', 'term', 'kind', 'source', 'attributed']) expect(qs.has(k)).toBe(false);
  });
});
