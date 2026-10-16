import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReviewTab, { clearReviewCardCache } from './ReviewTab';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { summary, mergeItem, mergeItem2, genreItems, tagItem, modelDetails, runs } from '../testing/enrichMock';

const listFor = (url) => {
  const q = new URLSearchParams(url.split('?')[1]);
  let items = [];
  if (q.get('type') === 'merge') items = [mergeItem, mergeItem2];
  else if (q.get('field') === 'franchise') items = genreItems;
  else if (q.get('field') === 'tags') items = [tagItem];
  if (q.get('band') === 'high') items = items.filter(i => i.confidence >= 0.8);
  if (q.get('minConfidence')) items = items.filter(i => i.confidence >= Number(q.get('minConfidence')));
  if (q.get('creator')) items = items.filter(i => i.model.creator_name === q.get('creator'));
  return { total: items.length, page: 1, pages: 1, items };
};

let decideBodies;
const setup = (overrides = []) => {
  decideBodies = [];
  clearReviewCardCache();
  return mockFetch([
    ...overrides,
    ['/api/suggestions/summary', summary],
    ['/api/suggestions/decide-filter', (u, o) => { decideBodies.push({ url: u, ...JSON.parse(o.body) }); return { accepted: 1, rejected: 0, merged: 0, errors: [] }; }],
    ['/api/suggestions/decide', (u, o) => {
      const b = JSON.parse(o.body); decideBodies.push({ url: u, ...b });
      const merged = b.ids.includes(10) && b.decision === 'accept' ? 1 : 0;
      return { accepted: b.decision === 'accept' ? b.ids.length - merged : 0, rejected: b.decision === 'reject' ? b.ids.length : 0, merged, errors: [] };
    }],
    ['/api/suggestions?', (u) => listFor(u)],
    [/\/api\/models\/(40|41)$/, (u) => modelDetails[u.match(/(\d+)$/)[1]]],
    ['/api/ai/enrich/runs/3/undo', { reverted: 410, skipped: 2 }],
    ['/api/ai/enrich/runs', runs],
    ['/api/creators', [{ id: 1, name: 'Wicked' }, { id: 2, name: 'ZEZ' }]],
  ], []);
};
const renderTab = (props = {}) => render(<NoticeProvider><ReviewTab {...props} /></NoticeProvider>);
const listUrls = () => global.fetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/suggestions?'));

describe('Review tab', () => {
  test('groups by type with counts; opens on the first non-empty group (Merges)', async () => {
    setup();
    const onSummary = jest.fn();
    renderTab({ onSummary });
    const tabs = await screen.findByRole('tablist', { name: 'Suggestion groups' });
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map(t => t.textContent)).toEqual(['Merges15', 'Characters30', 'Genres40', 'Groups20', 'Names5', 'Tags10']));
    expect(within(tabs).getByRole('tab', { name: /Merges/ })).toHaveAttribute('aria-selected', 'true');
    expect(onSummary).toHaveBeenCalledWith(summary);
    await waitFor(() => expect(listUrls().some(u => u.includes('type=merge'))).toBe(true));
  });

  test('merge rows show both cards side by side with release labels and file counts', async () => {
    setup();
    renderTab();
    const row = (await screen.findByRole('listitem', { name: 'Same character: Geral' }));
    expect(within(row).getByText('Fold this card')).toBeInTheDocument();
    expect(within(row).getByText('into this card')).toBeInTheDocument();
    expect(await within(row).findByText('Release: Netflix')).toBeInTheDocument();
    expect(within(row).getByText('6 files')).toBeInTheDocument();
    expect(await within(row).findByText('14 files')).toBeInTheDocument();
    expect(within(row).getByText('Release: GOOGLE DRIVE WICKED MARCH TERM 2026')).toBeInTheDocument();
    expect(within(row).getByText('Dagobah + Endor')).toBeInTheDocument();
    expect(within(row).getByText('High 88%')).toBeInTheDocument();
    expect(within(row).getByText('typo of Geralt of Rivia; same creator and genre')).toBeInTheDocument();
    // accepting a merge says so
    fireEvent.click(within(row).getByRole('button', { name: /Accept Same character for Geral/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Merge "Geral" into "Geralt"?' });
    expect(dlg).toHaveTextContent('1 merge will fold cards (a DB snapshot is taken first)');
    expect(decideBodies).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText(/Merged "Geral" into "Geralt"/)).toBeInTheDocument();
    expect(decideBodies[0]).toEqual(expect.objectContaining({ ids: [10], decision: 'accept' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Same character: Geral' })).not.toBeInTheDocument());
  });

  test('field rows show current → proposed, confidence, reason and source; accept / reject one', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    const row = await screen.findByRole('listitem', { name: 'Genre: Alan Scott' });
    expect(within(row).getByText('Star Wars').tagName).toBe('DEL');
    expect(within(row).getByText('DC').tagName).toBe('INS');
    expect(within(row).getByText('High 93%')).toBeInTheDocument();
    expect(within(row).getByText('text')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Genre: Angela' })).getByText('👁 vision')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Genre: Angela' })).getByText('Low 60%')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Reject Genre for Alan Scott/ }));
    await waitFor(() => expect(decideBodies[0]).toEqual(expect.objectContaining({ ids: [9], decision: 'reject' })));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Genre: Alan Scott' })).not.toBeInTheDocument());
    expect(await screen.findByText('1 rejected')).toBeInTheDocument();
  });

  test('filters: creator and confidence band go to the API', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    await screen.findByRole('listitem', { name: 'Genre: Angela' });
    fireEvent.change(screen.getByLabelText('Filter suggestions by confidence'), { target: { value: 'high' } });
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Genre: Angela' })).not.toBeInTheDocument());
    const q = new URLSearchParams(listUrls().slice(-1)[0].split('?')[1]);
    expect(q.get('band')).toBe('high');
    expect(q.get('field')).toBe('franchise');
    fireEvent.change(screen.getByLabelText('Filter suggestions by creator'), { target: { value: 'ZEZ' } });
    await waitFor(() => expect(new URLSearchParams(listUrls().slice(-1)[0].split('?')[1]).get('creator')).toBe('ZEZ'));
    expect(await screen.findByText(/Nothing pending in Genres for ZEZ/)).toBeInTheDocument();
  });

  test('tags rows show only the added tags as additions', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Tags/ }));
    const row = await screen.findByRole('listitem', { name: 'Tags: Ken' });
    expect(within(row).getByText('type:bust').tagName).toBe('SPAN');
    expect(within(row).getByText('+ theme:movie').tagName).toBe('INS');
  });

  test('multi-select then accept selected', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    await screen.findByRole('listitem', { name: 'Genre: Ciri' });
    fireEvent.click(screen.getByLabelText('Select suggestion for Alan Scott'));
    fireEvent.click(screen.getByLabelText('Select suggestion for Ciri'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Accept 2' }));
    const dlg = await screen.findByRole('dialog', { name: 'Accept 2 selected suggestions?' });
    expect(dlg).toHaveTextContent('Accepts 2 field changes.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Accept 2' }));
    await waitFor(() => expect(decideBodies[0]).toEqual(expect.objectContaining({ ids: [9, 21], decision: 'accept' })));
    expect(await screen.findByText('2 accepted')).toBeInTheDocument();
  });

  test('"Accept all high-confidence" confirms with counts and uses decide-filter', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    await screen.findByRole('listitem', { name: 'Genre: Ciri' });
    fireEvent.click(screen.getByRole('button', { name: /Accept all high-confidence in Genres/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Accept 2 high-confidence genres?' });
    expect(dlg).toHaveTextContent('1 lower-confidence suggestion stays in the list.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Accept 2' }));
    await waitFor(() => expect(decideBodies[0]).toEqual(expect.objectContaining({
      url: '/api/suggestions/decide-filter', decision: 'accept',
      filter: { type: 'field', field: 'franchise', minConfidence: 0.8, status: 'pending' },
    })));
  });

  test('keyboard: j/k move, a accepts, r rejects, x selects', async () => {
    setup();
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    const first = await screen.findByRole('listitem', { name: 'Genre: Alan Scott' });
    expect(screen.getByText(/move/).closest('.review-help')).toHaveTextContent('Keys: j/k move · a accept · r reject · x select');
    first.focus();
    fireEvent.keyDown(first, { key: 'j' });
    const second = screen.getByRole('listitem', { name: 'Genre: Ciri' });
    expect(second).toHaveFocus();
    expect(second).toHaveClass('active');
    fireEvent.keyDown(second, { key: 'x' });
    expect(screen.getByLabelText('Select suggestion for Ciri')).toBeChecked();
    fireEvent.keyDown(second, { key: 'k' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'a' });
    await waitFor(() => expect(decideBodies[0]).toEqual(expect.objectContaining({ ids: [9], decision: 'accept' })));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Genre: Alan Scott' })).not.toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Genre: Ciri' }), { key: 'r' });
    await waitFor(() => expect(decideBodies[1]).toEqual(expect.objectContaining({ ids: [21], decision: 'reject' })));
  });

  test('runs history: Undo asks first, then reports what was reverted', async () => {
    setup();
    renderTab();
    const undo = await screen.findByRole('button', { name: 'Undo run 3' });
    expect(screen.getByText('undone')).toBeInTheDocument(); // run #2 already undone
    fireEvent.click(undo);
    const dlg = await screen.findByRole('dialog', { name: 'Undo run #3?' });
    expect(dlg).toHaveTextContent('Reverts the 412 values this run filled in automatically.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Undo run' }));
    expect(await screen.findByText('Run #3 undone: 410 reverted, 2 kept (changed since)')).toBeInTheDocument();
    expect(global.fetch.mock.calls.some(([u, o]) => u === '/api/ai/enrich/runs/3/undo' && o.method === 'POST')).toBe(true);
  });

  test('nothing pending: an empty state instead of groups', async () => {
    setup([['/api/suggestions/summary', { pending: 0, byType: {}, byField: {}, byConfidence: {} }]]);
    renderTab();
    expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument();
  });

  test('pressing a on a merge row asks first; a bulk accept with merges says cards will fold', async () => {
    setup();
    renderTab();
    const row = await screen.findByRole('listitem', { name: 'Same character: Geral' });
    row.focus();
    fireEvent.keyDown(row, { key: 'a' });
    const dlg = await screen.findByRole('dialog', { name: 'Merge "Geral" into "Geralt"?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(decideBodies).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Select suggestion for Geral'));
    fireEvent.click(screen.getByLabelText('Select suggestion for Doct Oct'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Accept 2' }));
    const bulk = await screen.findByRole('dialog', { name: 'Accept 2 selected suggestions?' });
    expect(bulk).toHaveTextContent('2 merges will fold cards (a DB snapshot is taken first)');
  });

  test('rows that changed since are reported and leave the pending list', async () => {
    setup([['/api/suggestions/decide', (u, o) => {
      const b = JSON.parse(o.body); decideBodies.push(b);
      return { accepted: 0, rejected: 0, merged: 0, superseded: 2, errors: b.ids.map(id => ({ id, error: 'changed since: the value is not the one this proposal was made for' })) };
    }]]);
    renderTab();
    fireEvent.click(await screen.findByRole('tab', { name: /Genres/ }));
    await screen.findByRole('listitem', { name: 'Genre: Ciri' });
    fireEvent.click(screen.getByLabelText('Select suggestion for Alan Scott'));
    fireEvent.click(screen.getByLabelText('Select suggestion for Ciri'));
    fireEvent.click(screen.getByRole('button', { name: '✓ Accept 2' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Accept 2' }));
    expect(await screen.findByText('2 skipped: value changed since the suggestion')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Genre: Ciri' })).not.toBeInTheDocument());
    expect(screen.queryByRole('listitem', { name: 'Genre: Alan Scott' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Genre: Angela' })).toBeInTheDocument();
  });

  test('accepted merges can be unmerged (with confirmation); the result is reported', async () => {
    const accepted = { ...mergeItem, id: 50, status: 'accepted', decidedAt: '2026-10-16 09:00:00' };
    setup([
      ['/api/suggestions?status=accepted&type=merge', { total: 1, page: 1, pages: 1, items: [accepted] }],
      ['/api/suggestions/50/unmerge', { restored: { files: 6, collections: 1, queue: false, alias: true }, notReverted: ['tags, notes and print status merged into the target stay on it'] }],
    ]);
    renderTab();
    const btn = await screen.findByRole('button', { name: 'Unmerge Geral from Geralt' });
    fireEvent.click(btn);
    const dlg = await screen.findByRole('dialog', { name: 'Unmerge "Geral" from "Geralt"?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Unmerge' }));
    expect(await screen.findByText('Unmerged: restored 6 files, 1 collection; alias removed. Not reverted: tags, notes and print status merged into the target stay on it.')).toBeInTheDocument();
    expect(global.fetch.mock.calls.some(([u, o]) => u === '/api/suggestions/50/unmerge' && o.method === 'POST')).toBe(true);
  });

  test('unmerge on an older backend (route missing) degrades gracefully', async () => {
    const accepted = { ...mergeItem, id: 51, status: 'accepted' };
    setup([
      ['/api/suggestions?status=accepted&type=merge', { total: 1, page: 1, pages: 1, items: [accepted] }],
    ]);
    const base = global.fetch;
    global.fetch = jest.fn((u, o) => (String(u) === '/api/suggestions/51/unmerge'
      ? Promise.resolve({ ok: false, status: 404, headers: { get: () => 'text/html' }, text: () => Promise.resolve('<pre>Cannot POST</pre>'), json: () => Promise.reject(new Error('html')) })
      : base(u, o)));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Unmerge Geral from Geralt' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unmerge' }));
    expect(await screen.findByText(/Unmerge needs a newer backend/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unmerge Geral from Geralt' })).not.toBeInTheDocument());
  });

  test('runs show actual tokens and USD when present', async () => {
    setup([['/api/ai/enrich/runs', { runs: [{ ...runs.runs[0], actualInTokens: 674627, actualOutTokens: 172726, actualUsd: 1.54 }, runs.runs[1]] }]]);
    renderTab();
    expect(await screen.findByText('$1.54 · 675k in / 173k out')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Actual cost' })).toBeInTheDocument();
  });
});
