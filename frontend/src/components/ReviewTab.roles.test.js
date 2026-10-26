import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReviewTab, { clearReviewCardCache } from './ReviewTab';
import AttributionPanel from './AttributionPanel';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { summary } from '../testing/enrichMock';
import { roleSuggestion, postsTo } from '../testing/rolesMock';

const roleSummary = { ...summary, pending: 121, byType: { ...summary.byType, role: 1 } };

const setup = () => {
  clearReviewCardCache();
  return mockFetch([
    ['/api/suggestions/summary', roleSummary],
    ['/api/suggestions/decide', (u, o) => {
      const b = JSON.parse(o.body);
      return { accepted: b.decision === 'accept' ? b.ids.length : 0, rejected: b.decision === 'reject' ? b.ids.length : 0, merged: 0, errors: [] };
    }],
    ['/api/suggestions?', (u) => {
      const q = new URLSearchParams(u.split('?')[1]);
      const items = q.get('type') === 'role' ? [roleSuggestion] : [];
      return { total: items.length, page: 1, pages: 1, items };
    }],
    ['/api/scan', { message: 'Scan started' }],
    ['/api/ai/enrich/runs', { runs: [] }],
    ['/api/creators', []],
  ], []);
};

describe('Review tab → Folder roles', () => {
  test('role suggestions get their own group and read "Mark <folder> as <role>"', async () => {
    const f = setup();
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    const tab = await within(tabs).findByRole('tab', { name: /Folder roles/ });
    expect(tab).toHaveTextContent('Folder roles1');
    fireEvent.click(tab);
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('type=role'))).toBe(true));
    const row = await screen.findByRole('listitem', { name: 'Folder role: Terrain' });
    expect(row).toHaveTextContent('Mark Misc/Terrain as Category (now Auto)');
    expect(within(row).getByTitle('/library/STL Archive/Misc/Terrain')).toHaveTextContent('Misc/Terrain');

    fireEvent.click(within(row).getByRole('button', { name: 'Accept Folder role for Terrain' }));
    await waitFor(() => expect(postsTo(f, '/api/suggestions/decide')).toEqual([{ ids: [77], decision: 'accept' }]));
    expect(await screen.findByText('Folder roles saved. They apply on the next scan.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan now' }));
    await waitFor(() => expect(postsTo(f, '/api/scan')).toEqual([{}]));
  });

  test('rejecting a role suggestion offers no rescan', async () => {
    const f = setup();
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: /Folder roles/ }));
    const row = await screen.findByRole('listitem', { name: 'Folder role: Terrain' });
    fireEvent.click(within(row).getByRole('button', { name: 'Reject Folder role for Terrain' }));
    await waitFor(() => expect(postsTo(f, '/api/suggestions/decide')).toEqual([{ ids: [77], decision: 'reject' }]));
    await screen.findByText('1 rejected');
    expect(screen.queryByRole('button', { name: 'Rescan now' })).not.toBeInTheDocument();
  });

  test('a role suggestion on the card detail panel reads the same way', () => {
    render(<AttributionPanel model={{ id: 120, name: 'Terrain', studio: 'X', suggestions: [roleSuggestion] }} onDecide={() => {}} />);
    expect(screen.getByText('Folder role')).toBeInTheDocument();
    expect(screen.getByTitle('/library/STL Archive/Misc/Terrain')).toHaveTextContent('Misc/Terrain');
    expect(screen.getByText('Category')).toBeInTheDocument();
  });
});
