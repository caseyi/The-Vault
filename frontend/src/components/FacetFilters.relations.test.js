import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Sidebar from './Sidebar';
import { EMPTY_FILTERS } from '../filters';
import { mockFetch } from '../testing/metaMock';
import { relSummary } from '../testing/relMock';

const base = {
  open: true, onToggle: jest.fn(), stats: { total: 1, byStatus: [] }, creators: [], tags: [],
  onScanClick: jest.fn(), onHomeClick: jest.fn(), facets: null,
};

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('Sidebar Relations and Sets filters', () => {
  test('hidden when the server has no /api/relations/summary', () => {
    render(<Sidebar {...base} filters={{ ...EMPTY_FILTERS }} onFilterChange={jest.fn()} relations={null} />);
    expect(screen.queryByRole('group', { name: 'Relations' })).not.toBeInTheDocument();
    expect(screen.queryByText('In a diorama')).not.toBeInTheDocument();
  });

  test('relation pills toggle their own filter keys and show counts', () => {
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} filters={{ ...EMPTY_FILTERS, features: true }} onFilterChange={onFilterChange} relations={relSummary} />);
    const pill = screen.getByRole('button', { name: /^In a diorama\s*\d/ });
    expect(pill).toHaveTextContent('210');
    fireEvent.click(pill);
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ inDiorama: true, features: true }));
    const feat = screen.getByRole('button', { name: /Dioramas with linked figures/ });
    expect(feat).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(feat);
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ features: false }));
    for (const l of ['Has other releases', 'Has accessories', 'Any links']) expect(screen.getByRole('button', { name: new RegExp(l) })).toBeInTheDocument();
  });

  test('Sets section: kind pills, Not in a theme, and the set picker', async () => {
    mockFetch([['/api/sets', { items: [{ id: 9, kind: 'theme', name: 'Archduke Mousin', creator: 'Lord of the Print' }], total: 1 }]]);
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} filters={{ ...EMPTY_FILTERS, creator: 'Lord of the Print' }} onFilterChange={onFilterChange} relations={relSummary} />);
    fireEvent.click(screen.getByRole('button', { name: /^In a theme/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ inSet: 'theme' }));
    fireEvent.click(screen.getByRole('button', { name: /Not in a theme/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ noTheme: true }));
    fireEvent.change(screen.getByLabelText('Find a set'), { target: { value: 'mousin' } });
    const hit = await screen.findByRole('button', { name: /Theme: Archduke Mousin/ });
    const url = global.fetch.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/api/sets?'));
    expect(url).toContain('search=mousin');
    expect(url).toContain('creator=Lord+of+the+Print');
    fireEvent.click(hit);
    await waitFor(() => expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ set: '9', setName: 'Theme: Archduke Mousin' })));
  });
});
