import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';
import { NoticeProvider } from '../components/Notices';
import { mockFetch } from '../testing/metaMock';
import { hanDetail } from '../testing/relMock';

jest.mock('../components/StlViewer', () => () => <div />);
jest.mock('../components/ClaudeAssistant', () => () => <div />);

const common = [['/api/queue', []], ['/status-log', []], ['/tag-suggestions', []], ['/collections', []], ['/detect-url', {}]];
let sent;
const setup = (detail, extraRoutes = [], props = {}) => {
  sent = [];
  const record = (body) => (u, o) => { sent.push([u, o && o.method, o && o.body ? JSON.parse(o.body) : undefined]); return typeof body === 'function' ? body(u, o) : body; };
  mockFetch([
    ...extraRoutes.map(([m, b]) => [m, record(b)]),
    [/\/api\/models\/\d+$/, detail],
    ...common,
  ], {});
  const onOpenModel = jest.fn();
  const utils = render(<NoticeProvider><ModelDetail modelId={detail.id} onBack={() => {}} collections={[]} onOpenModel={onOpenModel} {...props} /></NoticeProvider>);
  return { ...utils, onOpenModel };
};

describe('ModelDetail Related strip', () => {
  test('sections, set chips and the old siblings nav replaced', async () => {
    const onShowSet = jest.fn();
    const { onOpenModel } = setup(hanDetail, [], { onShowSet });
    const strip = await screen.findByRole('region', { name: 'Related' });
    expect(within(strip).getByRole('list', { name: 'Dioramas' })).toHaveTextContent('Han and Chewie');
    expect(within(strip).getByRole('list', { name: 'Other releases' })).toHaveTextContent('2024');
    const acc = within(strip).getByRole('list', { name: 'Accessories' });
    expect(within(acc).getByRole('img', { name: 'Linked by you' })).toBeInTheDocument();
    expect(within(acc).getByText('Accessory')).toBeInTheDocument();
    expect(within(strip).queryByRole('list', { name: 'Figures' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Other releases of this character' })).not.toBeInTheDocument();
    fireEvent.click(within(strip).getByRole('button', { name: 'Theme: Archduke Mousin' }));
    expect(onShowSet).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
    expect(within(strip).getByRole('button', { name: 'Release: The Tale of Archduke Mousin (2023-11)' })).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole('button', { name: 'Open Han and Chewie' }));
    expect(onOpenModel).toHaveBeenCalledWith(expect.objectContaining({ id: 40 }));
  });

  test('older backend without `related`: no strip, siblings nav stays', async () => {
    const { related, relatedPending, ...old } = hanDetail; // eslint-disable-line no-unused-vars
    setup(old);
    expect(await screen.findByRole('navigation', { name: 'Other releases of this character' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Related' })).not.toBeInTheDocument();
  });

  test('remove a link, then undo it inline', async () => {
    setup(hanDetail, [[/\/api\/relations\/\d+$/, { ok: true }], [/\/api\/relations$/, { relation: { id: 501 } }]]);
    const strip = await screen.findByRole('region', { name: 'Related' });
    fireEvent.click(within(strip).getByRole('button', { name: 'Remove link to Han and Chewie' }));
    const undo = await within(strip).findByRole('button', { name: 'Undo removing Han and Chewie' });
    expect(sent[0]).toEqual(['/api/relations/501', 'DELETE', undefined]);
    expect(within(strip).getByText('Removed')).toBeInTheDocument();
    fireEvent.click(undo);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual(['/api/relations', 'POST', { type: 'features', fromId: 40, toId: 41 }]);
    await waitFor(() => expect(within(strip).queryByText('Removed')).not.toBeInTheDocument());
  });

  test('Add link: search any card, pick a type, POST the relation', async () => {
    setup(hanDetail, [
      [/\/api\/models\?/, { models: [{ id: 41, name: 'Han Solo' }, { id: 70, name: 'Carbonite Block', creator_name: 'B3DSERK' }], total: 2 }],
      [/\/api\/relations$/, { relation: { id: 600 } }],
    ]);
    const strip = await screen.findByRole('region', { name: 'Related' });
    fireEvent.click(within(strip).getByRole('button', { name: '+ Add link' }));
    const picker = within(strip).getByRole('group', { name: 'Add link' });
    expect(within(picker).getByLabelText('Link type')).toHaveValue('in-diorama');
    fireEvent.change(within(picker).getByLabelText('Link type'), { target: { value: 'has-accessory' } });
    fireEvent.change(within(picker).getByLabelText('Find a card to link'), { target: { value: 'carb' } });
    const hit = await within(picker).findByRole('button', { name: 'Link Carbonite Block by B3DSERK' });
    expect(within(picker).queryByRole('button', { name: /Link Han Solo/ })).not.toBeInTheDocument(); // not itself
    fireEvent.click(hit);
    await waitFor(() => expect(sent.find(s => s[0] === '/api/relations')).toBeTruthy());
    expect(sent.find(s => s[0] === '/api/relations')).toEqual(['/api/relations', 'POST', { type: 'accessory-of', fromId: 70, toId: 41 }]);
  });

  test('pending suggestions accept and reject inline', async () => {
    setup(hanDetail, [['/api/suggestions/decide', { accepted: 1 }]]);
    const strip = await screen.findByRole('region', { name: 'Related' });
    const pending = within(strip).getByRole('list', { name: 'Suggested links' });
    expect(pending).toHaveTextContent('Appears in diorama Cantina Dio');
    expect(pending).toHaveTextContent('70%');
    fireEvent.click(within(pending).getByRole('button', { name: 'Accept: Appears in diorama Cantina Dio' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual(['/api/suggestions/decide', 'POST', { ids: [900], decision: 'accept' }]);
    fireEvent.click(within(pending).getByRole('button', { name: 'Reject: Appears in diorama Cantina Dio' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1][2]).toEqual({ ids: [900], decision: 'reject' });
  });

  test('Add to set: existing theme or a new theme', async () => {
    setup(hanDetail, [
      [/\/api\/sets\/9\/members$/, { added: 1 }],
      [/\/api\/sets\?/, { items: [{ id: 9, kind: 'theme', name: 'Archduke Mousin' }], total: 1 }],
      [/\/api\/sets$/, { id: 11, name: 'Smugglers' }],
    ]);
    const strip = await screen.findByRole('region', { name: 'Related' });
    fireEvent.click(within(strip).getByRole('button', { name: /Add to set/ }));
    fireEvent.click(await within(strip).findByRole('button', { name: 'Archduke Mousin' }));
    await waitFor(() => expect(sent.find(s => s[0] === '/api/sets/9/members')).toBeTruthy());
    expect(sent.find(s => s[0] === '/api/sets/9/members')[2]).toEqual({ ids: [41] });
    const setsQuery = sent.find(s => s[0].startsWith('/api/sets?'))[0];
    expect(setsQuery).toContain('kind=theme');
    expect(setsQuery).toContain('creator=SW3D');

    fireEvent.click(within(strip).getByRole('button', { name: /Add to set/ }));
    fireEvent.change(within(strip).getByLabelText('NEW THEME'), { target: { value: 'Smugglers' } });
    fireEvent.click(within(strip).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(sent.find(s => s[0] === '/api/sets')).toBeTruthy());
    expect(sent.find(s => s[0] === '/api/sets')[2]).toEqual({ name: 'Smugglers', creator: 'SW3D', ids: [41] });
  });
});
