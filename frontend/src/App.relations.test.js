import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';
import { mockFetch } from './testing/metaMock';
import { relSummary } from './testing/relMock';

const routes = (summary) => [
  ['/api/relations/summary', summary],
  ['/api/stats', { total: 3, creators: 1, withImages: 0, byStatus: [] }],
  ['/api/creators', []],
  ['/api/tags', []],
  ['/api/collections', []],
  ['/api/queue', []],
  ['/api/wishlist', []],
  ['/api/scan', { inProgress: false }],
  ['/api/models', { models: [{ id: 1, name: 'Dragon', creator_name: 'A', print_status: 'unprinted', images: [] }], total: 1, page: 1, pages: 1 }],
];

beforeEach(() => { try { localStorage.clear(); localStorage.setItem('vault_onboarded', '1'); } catch {} });

describe('App relations feature switch', () => {
  test('an older server (404 on /api/relations/summary) shows no Relations UI', async () => {
    mockFetch(routes({ __status: 404 }), {});
    render(<App />);
    await screen.findByText('Dragon');
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/api/relations/summary'))).toBe(true));
    expect(screen.queryByRole('group', { name: 'Relations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Gallery view' })).not.toBeInTheDocument();
  });

  test('a server with the summary shows the sidebar sections and the Cards | Sets toggle', async () => {
    mockFetch(routes(relSummary), {});
    render(<App />);
    await screen.findByText('Dragon');
    expect(await screen.findByRole('group', { name: 'Relations' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Gallery view' })).toBeInTheDocument();
  });
});
