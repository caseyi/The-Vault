import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReviewTab, { clearReviewCardCache } from './ReviewTab';
import { clearValuesCache } from './ReviewExtras';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { summary, genreItems, runs } from '../testing/enrichMock';

// Review rework (Casey, Nov 2026): answer groups, edit instead of reject, "Teach the AI" rules.

const card = (id, name, creator = 'STL Archive', extra = {}) => ({ id, name, creator_name: creator, thumbnail_path: null, kind: 'model', ...extra });
const groupsBody = {
  type: 'field', field: 'franchise', total: 2, suggestions: 6, page: 1, pages: 1,
  items: [
    { key: '"Wildcard"', proposed: 'Wildcard', count: 4, fromEmpty: 4, minConfidence: 0.55, maxConfidence: 0.75, creators: [{ name: 'STL Archive', count: 4 }],
      samples: [{ id: 1, suggestionId: 101, name: 'Krampus', creator_name: 'STL Archive', current: null }, { id: 2, suggestionId: 102, name: 'Medusa', creator_name: 'STL Archive', current: null }] },
    { key: '"Mist of the Jungle"', proposed: 'Mist of the Jungle', count: 2, fromEmpty: 1, minConfidence: 0.6, maxConfidence: 0.6, creators: [], samples: [] },
  ],
};
const rulesBody = { items: [
  { id: 7, kind: 'set', field: 'franchise', value: 'Star Wars', path: '/library/STL Archive/Wicked Archive/Star Wars', applied: 12, label: 'Every card (in Star Wars/) has genre "Star Wars"' },
  { id: 8, kind: 'block', field: 'franchise', match: 'wildcard', applied: 3, label: 'Never propose "wildcard" as a genre' },
] };

let posts;
const setup = (overrides = []) => {
  posts = [];
  clearReviewCardCache();
  clearValuesCache();
  const record = (u, o) => { const b = o && o.body ? JSON.parse(o.body) : null; posts.push({ url: u, method: o && o.method, body: b }); return b; };
  return mockFetch([
    ...overrides,
    ['/api/suggestions/summary', { ...summary, maxConfidence: 0.75 }],
    ['/api/suggestions/groups', groupsBody],
    ['/api/suggestions/values', { field: 'franchise', values: ['Star Wars', 'Fantasy', 'Other Comics'] }],
    ['/api/suggestions/decide-filter', (u, o) => { const b = record(u, o); return { accepted: b.decision === 'accept' ? 4 : 0, rejected: b.decision === 'reject' ? 2 : 0, merged: 0, errors: [] }; }],
    ['/api/suggestions/decide', (u, o) => { const b = record(u, o); return { accepted: b.decision === 'accept' ? 1 : 0, rejected: b.decision === 'reject' ? 1 : 0, merged: 0, errors: [], ...(b.value ? { edited: 1 } : {}) }; }],
    ['/api/suggestions?', (u) => {
      const q = new URLSearchParams(u.split('?')[1]);
      let items = q.get('field') === 'franchise' ? genreItems.map(g => ({ ...g, model: { ...g.model, folder: `/library/STL Archive/Wicked Archive/Comics/${g.model.name}` } })) : [];
      if (q.get('proposed')) items = items.filter(i => JSON.stringify(i.proposed) === q.get('proposed'));
      return { total: items.length, page: 1, pages: 1, items };
    }],
    ['/api/review-rules/apply', (u, o) => { record(u, o); return { rejected: 0, rewritten: 0, superseded: 0, cardsSet: 5 }; }],
    [/\/api\/review-rules\/\d+/, (u, o) => { record(u, o); return { id: 7, reverted: 12 }; }],
    ['/api/review-rules', (u, o) => {
      if (o && o.method === 'POST') { const b = record(u, o); return { rule: { id: 9, ...b, label: 'x' }, applied: { rejected: 3, rewritten: 0, superseded: 0, cardsSet: 0 } }; }
      return rulesBody;
    }],
    ['/api/ai/enrich/runs', runs],
    ['/api/creators', [{ id: 1, name: 'STL Archive' }]],
  ], []);
};
const renderTab = () => render(<NoticeProvider><ReviewTab /></NoticeProvider>);
const openGenres = async () => fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));

describe('Review tab: answers', () => {
  test('says when nothing is high-confidence', async () => {
    setup();
    renderTab();
    expect(await screen.findByText(/None is above 80% \(the best is 75%\)/)).toBeInTheDocument();
  });

  test('Genres opens by answer: value, card count, empties, confidence range and sample cards', async () => {
    setup();
    renderTab();
    await openGenres();
    const g = await screen.findByRole('listitem', { name: 'Wildcard: 4 cards' });
    expect(within(g).getByText('all fill an empty genre')).toBeInTheDocument();
    expect(within(g).getByText('55%–75%')).toBeInTheDocument();
    expect(within(g).getByText('Krampus')).toBeInTheDocument();
    expect(within(g).getByText('+2 more')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Mist of the Jungle: 2 cards' })).getByText('1 change an existing genre')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'By answer' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('accept a whole answer: confirms, then decide-filter with its key', async () => {
    setup();
    renderTab();
    await openGenres();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Wildcard for 4 cards' }));
    const dlg = await screen.findByRole('dialog', { name: 'Accept “Wildcard” for 4 cards?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Accept 4' }));
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/suggestions/decide-filter',
      body: { decision: 'accept', filter: { type: 'field', field: 'franchise', proposed: '"Wildcard"' } } }));
    expect(await screen.findByText('4 accepted')).toBeInTheDocument();
  });

  test('reject a whole answer and never propose it again (a block rule)', async () => {
    setup();
    renderTab();
    await openGenres();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Mist of the Jungle for 2 cards' }));
    const dlg = await screen.findByRole('dialog', { name: 'Reject “Mist of the Jungle” for 2 cards?' });
    expect(within(dlg).getByLabelText(/Never propose “Mist of the Jungle” as a genre/)).toBeChecked();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reject 2' }));
    await waitFor(() => expect(posts.map(p => p.url)).toEqual(['/api/suggestions/decide-filter', '/api/review-rules']));
    expect(posts[1].body).toEqual({ kind: 'block', field: 'franchise', match: 'Mist of the Jungle' });
    expect(await screen.findByText('Rule saved: 3 pending suggestions rejected.')).toBeInTheDocument();
  });

  test('use a different value for a whole answer, remembered as a map rule', async () => {
    setup();
    renderTab();
    await openGenres();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a different genre than Wildcard' }));
    const input = screen.getByLabelText('New genre');
    fireEvent.change(input, { target: { value: 'Fantasy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const dlg = await screen.findByRole('dialog', { name: 'Use “Fantasy” for 4 cards?' });
    expect(dlg).toHaveTextContent('use “Fantasy” whenever the AI says “Wildcard”');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Accept 4' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].body).toMatchObject({ decision: 'accept', value: 'Fantasy', filter: { proposed: '"Wildcard"' } });
    expect(posts[1].body).toEqual({ kind: 'map', field: 'franchise', match: 'Wildcard', value: 'Fantasy' });
  });

  test('"One by one" opens one answer as a filtered list, with a way back', async () => {
    setup();
    renderTab();
    await openGenres();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Mist of the Jungle one by one' }));
    expect(await screen.findByText(/one by one\./)).toBeInTheDocument();
    await waitFor(() => expect(global.fetch.mock.calls.map(c => String(c[0])).some(u => u.startsWith('/api/suggestions?') && u.includes('proposed='))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '‹ Back to answers' }));
    expect(await screen.findByRole('listitem', { name: 'Wildcard: 4 cards' })).toBeInTheDocument();
  });

  test('an older backend without the groups route falls back to the list', async () => {
    setup([['/api/suggestions/groups', { __status: 404 }]]);
    renderTab();
    await openGenres();
    expect(await screen.findByRole('listitem', { name: 'Genre: Alan Scott' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'By answer' })).not.toBeInTheDocument();
  });
});

describe('Review tab: edit and teach', () => {
  const toList = async () => {
    await openGenres();
    fireEvent.click(await screen.findByRole('button', { name: 'One by one' }));
    return screen.findByRole('listitem', { name: 'Genre: Ciri' });
  };

  test('edit a row: the typed value is accepted, then "Teach the AI" offers a map rule', async () => {
    setup();
    renderTab();
    const row = await toList();
    fireEvent.click(within(row).getByRole('button', { name: 'Edit Genre for Ciri' }));
    const input = within(row).getByLabelText('New genre');
    expect(input).toHaveValue('Video Games');
    fireEvent.change(input, { target: { value: 'Fantasy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/suggestions/decide', body: { ids: [21], decision: 'accept', value: 'Fantasy' } }));
    const bar = await screen.findByRole('status', { name: 'Teach the AI' });
    expect(bar).toHaveTextContent('Set genre “Fantasy” instead of “Video Games” for Ciri.');
    fireEvent.click(within(bar).getByRole('button', { name: 'Always use “Fantasy” when the AI says “Video Games”' }));
    await waitFor(() => expect(posts[1].body).toEqual({ kind: 'map', field: 'franchise', match: 'Video Games', value: 'Fantasy' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Teach the AI' })).not.toBeInTheDocument());
  });

  test('reject a row: offers never / never for this creator; e opens the editor from the keyboard', async () => {
    setup();
    renderTab();
    const row = await toList();
    fireEvent.click(within(row).getByRole('button', { name: 'Reject Genre for Ciri' }));
    const bar = await screen.findByRole('status', { name: 'Teach the AI' });
    expect(within(bar).getByRole('button', { name: 'Never propose “Video Games” as a genre' })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: '…only for Wicked' }));
    await waitFor(() => expect(posts[1].body).toEqual({ kind: 'block', field: 'franchise', match: 'Video Games', creator: 'Wicked' }));
    // saving a rule reloads the list (the mock still returns Ciri)
    await screen.findByRole('listitem', { name: 'Genre: Ciri' });
    const first = screen.getByRole('listitem', { name: 'Genre: Alan Scott' });
    first.focus();
    fireEvent.keyDown(first, { key: 'e' });
    expect(within(first).getByLabelText('New genre')).toHaveValue('DC');
    // Escape closes the editor without deciding
    fireEvent.keyDown(within(first).getByLabelText('New genre'), { key: 'Escape' });
    expect(within(first).queryByLabelText('New genre')).not.toBeInTheDocument();
    expect(posts).toHaveLength(2);
  });

  test('accepting one genre offers to set it for the whole folder above the card', async () => {
    setup();
    renderTab();
    const row = await toList();
    fireEvent.click(within(row).getByRole('button', { name: 'Accept Genre for Ciri' }));
    const bar = await screen.findByRole('status', { name: 'Teach the AI' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Every card in Wicked Archive/Comics/ gets genre “Video Games”' }));
    await waitFor(() => expect(posts[1].body).toEqual({ kind: 'set', field: 'franchise', value: 'Video Games', path: '/library/STL Archive/Wicked Archive/Comics' }));
  });
});

describe('Review tab: rules and history', () => {
  test('rules list; removing a set rule asks and can clear its values', async () => {
    setup();
    renderTab();
    const panel = (await screen.findByText('Rules')).closest('details');
    expect(within(panel).getByText('Never propose "wildcard" as a genre')).toBeInTheDocument();
    expect(within(panel).getByText('12×')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /Remove rule: Every card/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove this rule?' });
    expect(within(dlg).getByLabelText(/Also clear the values it set/)).toBeChecked();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Remove rule' }));
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/review-rules/7?revert=1', method: 'DELETE' }));
    expect(await screen.findByText('Rule removed; 12 values cleared.')).toBeInTheDocument();
  });

  test('accepted merges and Enrich runs sit in a collapsed History', async () => {
    setup();
    renderTab();
    const hist = (await screen.findByText('History')).closest('details');
    expect(hist).not.toHaveAttribute('open');
    await waitFor(() => expect(within(hist).getByRole('button', { name: 'Undo run 3' })).toBeInTheDocument());
  });
});
