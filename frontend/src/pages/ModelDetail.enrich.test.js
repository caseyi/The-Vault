import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';
import { NoticeProvider } from '../components/Notices';
import { mockFetch } from '../testing/metaMock';

jest.mock('../components/StlViewer', () => () => <div />);
jest.mock('../components/ClaudeAssistant', () => () => <div />);

const daredevil = {
  id: 3751, name: 'Daredevil (2026)', creator_name: 'Wicked', studio: 'Wicked', character: 'Daredevil', franchise: 'Marvel',
  editions: ['Sculpture', 'Bust'], release_label: 'GOOGLE DRIVE WICKED MARCH TERM 2026', release_term: '2026-03', tags: ['type:statue'], images: [], files: [], file_count: 0,
  attribution: { confidence: 'exact', fields: { franchise: 'ai', tags: 'ai' }, ai: { franchise: 0.91 } },
  enrichment: { at: '2026-10-16T08:46:08.445Z', runId: 1 },
  siblings: [{ id: 3752, name: 'Daredevil (Netflix)', release_term: null, release_label: 'Netflix', editions: ['Bust'] }],
  suggestions: [{ id: 77, type: 'field', field: 'group_name', model: { id: 3751 }, current: null, proposed: 'Defenders', confidence: 0.7, reason: 'Netflix Defenders', source: 'text', status: 'pending' }],
};

const setup = (decided = false) => {
  let after = false;
  return mockFetch([
    ['/api/suggestions/decide', () => { after = true; return { accepted: 1, rejected: 0, merged: 0, errors: [] }; }],
    [/\/api\/models\/3751$/, (u, o) => (o && o.method === 'PATCH' ? { success: true } : (after || decided ? { ...daredevil, group_name: 'Defenders', suggestions: [], attribution: { ...daredevil.attribution, fields: { ...daredevil.attribution.fields, group_name: 'ai-reviewed' } } } : daredevil))],
    ['/api/queue', []], ['/status-log', []], ['/tag-suggestions', []], ['/collections', []],
  ], {});
};

describe('ModelDetail: AI enrichment', () => {
  test('other releases (siblings) link to their cards', async () => {
    setup();
    const onOpenModel = jest.fn();
    render(<NoticeProvider><ModelDetail modelId={3751} onBack={() => {}} collections={[]} onOpenModel={onOpenModel} /></NoticeProvider>);
    const nav = await screen.findByRole('navigation', { name: 'Other releases of this character' });
    const link = screen.getByRole('button', { name: /Daredevil \(Netflix\)/ });
    expect(nav).toContainElement(link);
    expect(link).toHaveTextContent('Netflix');
    expect(link).toHaveTextContent('Bust');
    fireEvent.click(link);
    expect(onOpenModel).toHaveBeenCalledWith(expect.objectContaining({ id: 3752 }));
  });

  test('AI markers on Genre and Tags; accepting an inline suggestion posts decide and refreshes the card', async () => {
    const f = setup();
    const onSuggestionsChange = jest.fn();
    render(<NoticeProvider><ModelDetail modelId={3751} onBack={() => {}} collections={[]} onSuggestionsChange={onSuggestionsChange} /></NoticeProvider>);
    await screen.findByRole('region', { name: 'Attribution' });
    expect(document.querySelectorAll('.ai-mark').length).toBe(2); // genre + tags
    fireEvent.click(screen.getByRole('button', { name: 'Accept: Group Defenders' }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => u === '/api/suggestions/decide' && JSON.parse(o.body).ids[0] === 77)).toBe(true));
    expect(await screen.findByText('1 accepted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/AI suggestions/)).not.toBeInTheDocument());
    expect(document.querySelector('.ai-mark.reviewed')).toBeInTheDocument();
    expect(onSuggestionsChange).toHaveBeenCalled();
  });

  test('editing the character in the panel PATCHes the model', async () => {
    const f = setup();
    render(<NoticeProvider><ModelDetail modelId={3751} onBack={() => {}} collections={[]} /></NoticeProvider>);
    await screen.findByRole('region', { name: 'Attribution' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit character' }));
    fireEvent.change(screen.getByLabelText('Character'), { target: { value: 'Matt Murdock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => u === '/api/models/3751' && o && o.method === 'PATCH' && JSON.parse(o.body).character === 'Matt Murdock')).toBe(true));
    expect(await screen.findByText(/Scans and AI will keep your value/)).toBeInTheDocument();
  });
});
