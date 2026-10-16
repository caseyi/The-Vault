import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';
import { NoticeProvider } from '../components/Notices';
import { EMPTY_FILTERS } from '../filters';
import { mockFetch } from '../testing/metaMock';

const folded = { id: 21, name: 'Old Ken Card', creator_name: 'Wicked', print_status: 'unprinted', images: [], hidden: 1 };
const list = { models: [folded], total: 1, pages: 1, page: 1 };
const MSG = 'This card was folded into card #4 when the library was regrouped into works.';
const props = { onFilterChange: jest.fn(), onModelClick: jest.fn(), showHidden: true, onToggleHidden: jest.fn(), onRefreshStats: jest.fn() };
const renderG = (extra = {}) => render(<NoticeProvider><Gallery {...props} filters={{ ...EMPTY_FILTERS }} {...extra} /></NoticeProvider>);

describe('folded rows', () => {
  test('unhiding a folded card shows the server 409 message and keeps the card hidden', async () => {
    mockFetch([
      [/\/api\/models\/21$/, () => ({ __status: 409 })],
      ['/api/models?', list],
    ]);
    // 409 body carries the server's explanation
    const base = global.fetch;
    global.fetch = jest.fn((url, opts) => (String(url) === '/api/models/21'
      ? Promise.resolve({ ok: false, status: 409, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ error: MSG, folded_into: 4 }) })
      : base(url, opts)));
    renderG();
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide Old Ken Card' }));
    expect(await screen.findByText(MSG)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide Old Ken Card' })).toBeInTheDocument();
    expect(screen.getByText('HIDDEN')).toBeInTheDocument();
  });

  test('bulk unhide reports skipped folded cards', async () => {
    mockFetch([['/api/models/bulk', { success: true, updated: 0, skippedFolded: 1 }], ['/api/models?', list]]);
    renderG();
    await screen.findByText('Old Ken Card');
    fireEvent.click(screen.getByRole('button', { name: '⊡ Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Old Ken Card' }));
    fireEvent.click(screen.getByRole('button', { name: '👁 Unhide' }));
    expect(await screen.findByText(/1 card was folded into a work/)).toBeInTheDocument();
  });

  test('a collection with a description shows it above the grid', async () => {
    mockFetch([['/api/models?', list]]);
    renderG({ filters: { ...EMPTY_FILTERS, collection: '3' }, collections: [{ id: 3, name: 'Was: DC', color: '#5b9bd5', description: 'Tags: dc, bust · Favorite · Notes: print at 0.05' }] });
    await waitFor(() => expect(screen.getByRole('note', { name: 'About collection Was: DC' })).toHaveTextContent('Tags: dc, bust'));
  });
});
