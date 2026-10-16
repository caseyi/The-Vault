import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AttributionPanel from './AttributionPanel';

const model = {
  id: 241, name: 'Harley Queen Zombie', studio: 'Wicked', creator_name: 'B3DSERK', franchise: 'DC', group_name: 'Suicide Squad',
  character: 'Harley Quinn', editions: ['Bust'], confidence: 'exact',
  attribution: { confidence: 'exact', fields: { franchise: 'path', group_name: 'ai', character: 'ai-reviewed', editions: 'parse' }, ai: { group_name: 0.86 } },
  enrichment: { at: '2026-10-16T08:46:08.445Z', model: 'claude-haiku-4-5-20251001', runId: 1 },
  suggestions: [
    { id: 123, type: 'rename', field: 'name', model: { id: 241 }, current: 'Harley Queen Zombie', proposed: 'Harley Quinn Zombie', confidence: 0.93, reason: 'the character is Harley Quinn', source: 'text', status: 'pending' },
    { id: 124, type: 'merge', model: { id: 241, name: 'Harley Queen Zombie' }, target: { id: 300, name: 'Harley Quinn Zombie' }, confidence: 0.81, reason: 'same sculpt', source: 'vision', status: 'pending' },
  ],
};

describe('AttributionPanel AI', () => {
  test('marks AI-filled fields; tooltip has confidence and run; reviewed ones say so', () => {
    render(<AttributionPanel model={model} />);
    const panel = screen.getByRole('region', { name: 'Attribution' });
    const marks = panel.querySelectorAll('.ai-mark');
    expect(marks).toHaveLength(2);
    const group = [...marks].find(m => !m.classList.contains('reviewed'));
    expect(group.textContent).toMatch(/^AI/);
    expect(group.getAttribute('title')).toMatch(/^Filled by AI · 86% confidence · run #1, Oct 16, 2026/);
    const reviewed = panel.querySelector('.ai-mark.reviewed');
    expect(reviewed).toHaveTextContent('AI ✓');
    expect(reviewed.getAttribute('title')).toMatch(/^AI, reviewed/);
    // fields from path/parse carry no marker
    expect(within(panel).getByText('Bust').parentElement.querySelector('.ai-mark')).toBeNull();
  });

  test('shows this card\'s pending suggestions inline with accept / reject', async () => {
    const onDecide = jest.fn(() => Promise.resolve());
    render(<AttributionPanel model={model} onDecide={onDecide} />);
    expect(screen.getByText('AI suggestions (2)')).toBeInTheDocument();
    expect(screen.getByText('Harley Quinn Zombie', { selector: 'ins' })).toBeInTheDocument();
    expect(screen.getByText('High 93%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept: Name Harley Quinn Zombie' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith([123], 'accept', model.suggestions[0]));
    expect(screen.getByText('Same character as')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject: Same character as Harley Quinn Zombie' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith([124], 'reject', model.suggestions[1]));
  });

  test('editing character and genre/group goes through onSaveField (PATCH)', async () => {
    const onSaveField = jest.fn(() => Promise.resolve(true));
    render(<AttributionPanel model={model} onSaveField={onSaveField} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit character' }));
    const input = screen.getByLabelText('Character');
    fireEvent.change(input, { target: { value: 'Harley Quinn (Zombie)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaveField).toHaveBeenCalledWith({ character: 'Harley Quinn (Zombie)' }));
    await waitFor(() => expect(screen.queryByLabelText('Character')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit genre and group' }));
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'Gotham City Sirens' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaveField).toHaveBeenLastCalledWith({ group_name: 'Gotham City Sirens' }));
  });

  test('no suggestions block or edit buttons without handlers (read-only use)', () => {
    render(<AttributionPanel model={model} />);
    expect(screen.queryByText(/AI suggestions/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });
});
