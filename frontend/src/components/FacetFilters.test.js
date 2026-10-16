import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import Sidebar from './Sidebar';
import { EMPTY_FILTERS } from '../filters';
import { facets } from '../testing/metaMock';

const base = {
  open: true, onToggle: jest.fn(), stats: { total: 10, creators: 3, withImages: 7, byStatus: [] },
  creators: [], tags: [], filters: { ...EMPTY_FILTERS }, onScanClick: jest.fn(), onHomeClick: jest.fn(),
  franchises: [{ franchise: 'Star Wars', count: 4 }],
};

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('Sidebar facet filters', () => {
  test('library, kind, studio, genre and term options come from /api/facets with counts', () => {
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} facets={facets} onFilterChange={onFilterChange} />);
    const libs = screen.getByRole('group', { name: 'Library' });
    expect(within(libs).getByRole('button', { name: /Dagobah/ })).toHaveTextContent('4,100');
    fireEvent.click(within(libs).getByRole('button', { name: /Endor/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ library: 'Endor' }));

    fireEvent.click(within(screen.getByRole('group', { name: 'Studio' })).getByRole('button', { name: /B3DSERK/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ studio: 'B3DSERK' }));

    // facet genres win over the legacy franchise list
    const genres = screen.getByRole('group', { name: 'Genre' });
    expect(within(genres).queryByText('Star Wars')).not.toBeInTheDocument();
    fireEvent.click(within(genres).getByRole('button', { name: /Marvel/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ franchise: 'Marvel' }));

    const kinds = screen.getByRole('group', { name: 'Kind' });
    expect(within(kinds).getAllByRole('button').map(b => b.textContent.replace(/[\d,]/g, ''))).toEqual(['Works', 'Dioramas', 'Release items', 'Tools']);
    fireEvent.click(within(kinds).getByRole('button', { name: /Tools/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tool' }));
  });

  test('terms are grouped by year, newest first; the newest year starts open', () => {
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} facets={facets} onFilterChange={onFilterChange} />);
    const years = screen.getAllByRole('button', { name: /^\d{4}/ });
    expect(years.map(y => y.textContent.slice(2, 6))).toEqual(['2026', '2025', '2024']);
    expect(years[0]).toHaveAttribute('aria-expanded', 'true');
    expect(years[1]).toHaveAttribute('aria-expanded', 'false');
    const months2026 = screen.getByRole('group', { name: 'Release terms 2026' });
    expect(within(months2026).getAllByRole('button').map(b => b.title)).toEqual(['Mar 2026', 'Jan 2026']);
    fireEvent.click(within(months2026).getByRole('button', { name: /Mar 2026/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ term: '2026-03' }));
    fireEvent.click(years[1]);
    expect(screen.getByRole('group', { name: 'Release terms 2025' })).toBeInTheDocument();
  });

  test('attribution counts sum the confidence levels; clicking again clears', () => {
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} facets={facets} filters={{ ...EMPTY_FILTERS, attributed: 'no' }} onFilterChange={onFilterChange} />);
    // section is collapsed by default; open it
    fireEvent.click(screen.getByRole('button', { name: /^Attribution/, expanded: false }));
    const grp = screen.getByRole('group', { name: 'Attribution' });
    expect(within(grp).getByRole('button', { name: /^Attributed/ })).toHaveTextContent('705');
    const un = within(grp).getByRole('button', { name: /Unattributed/ });
    expect(un).toHaveTextContent('295');
    expect(un).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(un);
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ attributed: '' }));
  });

  test('collapsed state is remembered', () => {
    const { unmount } = render(<Sidebar {...base} facets={facets} onFilterChange={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Studio/, expanded: true }));
    expect(screen.queryByRole('group', { name: 'Studio' })).not.toBeInTheDocument();
    unmount();
    render(<Sidebar {...base} facets={facets} onFilterChange={jest.fn()} />);
    expect(screen.queryByRole('group', { name: 'Studio' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Studio/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('without /api/facets (older backend) only the Genre list shows, built from franchises', () => {
    const onFilterChange = jest.fn();
    render(<Sidebar {...base} facets={null} onFilterChange={onFilterChange} />);
    expect(screen.queryByRole('group', { name: 'Library' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Kind' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: 'Genre' })).getByRole('button', { name: /Star Wars/ }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ franchise: 'Star Wars' }));
  });

  test('a single library hides the Library filter', () => {
    render(<Sidebar {...base} facets={{ ...facets, libraries: [{ name: 'Dagobah', count: 5 }] }} onFilterChange={jest.fn()} />);
    expect(screen.queryByRole('group', { name: 'Library' })).not.toBeInTheDocument();
  });
});
