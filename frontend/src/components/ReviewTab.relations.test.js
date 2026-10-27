import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReviewTab, { clearReviewCardCache } from './ReviewTab';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { summary } from '../testing/enrichMock';
import { postsTo } from '../testing/rolesMock';

const relSummary = { ...summary, pending: summary.pending + 4, byType: { ...summary.byType, relation: 2, set: 1, 'set-member': 1 } };

const relation = {
  id: 301, type: 'relation', field: 'features', proposed: 'features', confidence: 0.8, source: 'scan',
  reason: "'Mando' is a nickname of Mandalorian; same folder Boba and Mando",
  model: { id: 50, name: 'Boba and Mando', creator_name: 'SW3D' }, target: { id: 51, name: 'Mandalorian', creator_name: 'SW3D' },
};
const theme = {
  id: 302, type: 'set', setId: 9, set: { id: 9, name: 'Archduke Mousin' }, proposed: 'Archduke Mousin', confidence: 0.7,
  model: { id: 60, name: 'Archduke Mousin', creator_name: 'Lord of the Print' },
  members: [{ id: 60, name: 'Archduke Mousin', release_label: 'The Tale of Archduke Mousin' }, { id: 61, name: 'Great Owl' }, { id: 64, name: 'Mice Danger' }],
  counts: { cards: 20, releases: 2, loose: 1 }, reason: 'mousin in 2 packs and 1 loose card',
};
const member = {
  id: 303, type: 'set-member', setId: 9, set: 'Archduke Mousin', proposed: 'Archduke Mousin', confidence: 0.65,
  model: { id: 65, name: 'Mouse Knight', creator_name: 'Lord of the Print' },
};

const setup = (sum = relSummary) => {
  clearReviewCardCache();
  return mockFetch([
    ['/api/suggestions/summary', sum],
    ['/api/suggestions/decide', (u, o) => {
      const b = JSON.parse(o.body);
      return { accepted: b.decision === 'accept' ? b.ids.length : 0, rejected: b.decision === 'reject' ? b.ids.length : 0, merged: 0, errors: [] };
    }],
    [/\/api\/sets\/9\/members\/\d+$/, { ok: true }],
    ['/api/suggestions?', (u) => {
      const t = new URLSearchParams(u.split('?')[1]).get('type');
      const items = t === 'relation' ? [relation] : t === 'set' ? [theme] : t === 'set-member' ? [member] : [];
      return { total: items.length, page: 1, pages: 1, items };
    }],
    ['/api/ai/enrich/runs', { runs: [] }],
    ['/api/creators', []],
  ], []);
};

describe('Review tab: related cards and themes', () => {
  test('groups are hidden when the server reports none', async () => {
    setup(summary);
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    await within(tabs).findByRole('tab', { name: /Merges/ });
    expect(within(tabs).queryByRole('tab', { name: /Related cards/ })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole('tab', { name: /Themes/ })).not.toBeInTheDocument();
  });

  test('Related cards rows show from, relation and to; accept decides', async () => {
    const f = setup();
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    fireEvent.click(await within(tabs).findByRole('tab', { name: /Related cards/ }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('type=relation'))).toBe(true));
    const row = await screen.findByRole('listitem', { name: 'Related card: Boba and Mando' });
    expect(row).toHaveTextContent('Boba and Mando diorama features Mandalorian');
    expect(row).toHaveTextContent('nickname of Mandalorian');
    fireEvent.click(within(row).getByRole('button', { name: 'Accept Related card for Boba and Mando' }));
    await waitFor(() => expect(postsTo(f, '/api/suggestions/decide')).toEqual([{ ids: [301], decision: 'accept' }]));
  });

  test('Themes: one row per theme with members, Leave out, then accept', async () => {
    const f = setup();
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    fireEvent.click(await within(tabs).findByRole('tab', { name: /^Themes/ }));
    const row = await screen.findByRole('listitem', { name: 'Theme: Archduke Mousin' });
    expect(row).toHaveTextContent('20 cards');
    expect(row).toHaveTextContent('2 releases');
    expect(row).toHaveTextContent('and 17 more');
    const members = within(row).getByRole('list', { name: 'Members of Archduke Mousin' });
    fireEvent.click(within(members).getByRole('button', { name: 'Leave Mice Danger out of Archduke Mousin' }));
    await waitFor(() => expect(within(members).queryByText('Mice Danger')).not.toBeInTheDocument());
    const del = f.mock.calls.find(([u, o]) => String(u).startsWith('/api/sets/') && o && o.method === 'DELETE');
    expect(String(del[0])).toBe('/api/sets/9/members/64');
    expect(row).toHaveTextContent('19 cards');
    fireEvent.click(within(row).getByRole('button', { name: 'Accept Theme for Archduke Mousin' }));
    await waitFor(() => expect(postsTo(f, '/api/suggestions/decide')).toEqual([{ ids: [302], decision: 'accept' }]));
  });

  test('Theme members read "Add to theme"', async () => {
    const f = setup();
    render(<NoticeProvider><ReviewTab /></NoticeProvider>);
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    fireEvent.click(await within(tabs).findByRole('tab', { name: /Theme members/ }));
    const row = await screen.findByRole('listitem', { name: 'Theme member: Mouse Knight' });
    expect(row).toHaveTextContent('Add to theme Archduke Mousin');
    fireEvent.click(within(row).getByRole('button', { name: 'Reject Theme member for Mouse Knight' }));
    await waitFor(() => expect(postsTo(f, '/api/suggestions/decide')).toEqual([{ ids: [303], decision: 'reject' }]));
  });
});
