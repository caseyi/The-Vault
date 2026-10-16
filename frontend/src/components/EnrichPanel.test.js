import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import EnrichPanel from './EnrichPanel';
import { mockFetch } from '../testing/metaMock';
import { estimate, FakeEventSource } from '../testing/enrichMock';
import { EMPTY_FILTERS } from '../filters';

const estimateUrls = () => global.fetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/ai/enrich/estimate'));
const lastEstimate = () => new URLSearchParams(estimateUrls().slice(-1)[0].split('?')[1]);

beforeEach(() => {
  FakeEventSource.instances = [];
  global.EventSource = FakeEventSource;
  mockFetch([
    ['/api/ai/models', { models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }, { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }], default: 'claude-haiku-4-5-20251001' }],
    ['/api/creators', [{ id: 1, name: 'Wicked', model_count: 900 }, { id: 2, name: 'ZEZ', model_count: 108 }]],
    ['/api/ai/enrich/estimate', estimate],
    ['/api/models?', { models: [{ id: 5 }, { id: 6 }], total: 2, pages: 1, page: 1 }],
  ]);
});

describe('EnrichPanel', () => {
  test('shows a live estimate: cards to process vs unchanged, text cost; vision adds its cost', async () => {
    render(<EnrichPanel apiKey="sk-ant-x" />);
    expect(await screen.findByText(/cards? to process/)).toHaveTextContent('812 cards to process');
    expect(screen.getByText(/3,652 unchanged/)).toBeInTheDocument();
    expect(screen.getByText('Text').parentElement || screen.getByText(/Text/)).toBeTruthy();
    expect(screen.getAllByText('≈$0.71').length).toBeGreaterThan(0);
    expect(screen.getByText('approximate')).toBeInTheDocument();
    expect(lastEstimate().get('scope')).toBe('all');
    expect(lastEstimate().get('vision')).toBeNull();

    fireEvent.click(screen.getByLabelText('Use renders for hard cases'));
    await waitFor(() => expect(lastEstimate().get('vision')).toBe('1'));
    expect(await screen.findByText(/up to 140 cards/)).toBeInTheDocument();
    expect(screen.getByText('≈$1.00')).toBeInTheDocument();
    expect(screen.getByText('Only cards the text pass could not resolve')).toBeInTheDocument();
  });

  test('scopes: creator needs a creator; current filter and selection send ids', async () => {
    const { unmount } = render(<EnrichPanel apiKey="sk-ant-x" filters={{ ...EMPTY_FILTERS, studio: 'Wicked' }} />);
    await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '812 cards to process');
    fireEvent.click(screen.getByRole('button', { name: 'This creator' }));
    expect(await screen.findByText('Choose a creator to see the estimate.')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('CREATOR'), { target: { value: 'ZEZ' } });
    await waitFor(() => expect(lastEstimate().get('creator')).toBe('ZEZ'));
    expect(lastEstimate().get('scope')).toBe('creator');

    fireEvent.click(screen.getByRole('button', { name: 'Current filter' }));
    await waitFor(() => expect(lastEstimate().get('ids')).toBe('5,6'));
    expect(lastEstimate().get('scope')).toBe('ids');
    unmount();

    render(<EnrichPanel apiKey="sk-ant-x" presetIds={[7, 8, 9]} />);
    expect(screen.getByRole('button', { name: 'Selection (3)' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastEstimate().get('ids')).toBe('7,8,9'));
  });

  test('run streams progress and log lines, then a summary linking to Review', async () => {
    const onDone = jest.fn();
    const onOpenReview = jest.fn();
    render(<EnrichPanel apiKey="sk-ant-x" onDone={onDone} onOpenReview={onOpenReview} />);
    const run = await screen.findByRole('button', { name: /\$ Enrich 812 cards/ });
    fireEvent.click(run);
    const es = FakeEventSource.instances[0];
    const qs = new URLSearchParams(es.url.split('?')[1]);
    expect(es.url.startsWith('/api/ai/enrich?')).toBe(true);
    expect(qs.get('key')).toBe('sk-ant-x');
    expect(qs.get('scope')).toBe('all');
    expect(qs.get('model')).toBe('claude-haiku-4-5-20251001');

    act(() => {
      es.emit({ level: 'info', msg: 'Batch 1/21: 40 card(s)', ts: new Date().toISOString() });
      es.emit({ type: 'progress', done: 40, total: 812, applied: 21, suggested: 9, merges: 2 });
    });
    expect(screen.getByText('40 / 812')).toBeInTheDocument();
    expect(screen.getByText('21 applied')).toBeInTheDocument();
    expect(screen.getByText('2 merges')).toBeInTheDocument();
    expect(screen.getByText(/Batch 1\/21/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '■ Stop' })).toBeInTheDocument();

    act(() => es.emit({ type: 'done', success: true, runId: 4, applied: 412, suggested: 100, merges: 15, unchanged: 3652, errors: 0, visionUsed: 0, actualInTokens: 398000, actualOutTokens: 61200, actualUsd: 0.69 }));
    expect(screen.getByText('Actual: $0.69 · 398k in / 61k out')).toBeInTheDocument();
    expect(screen.getByText(/Run #4: 412 applied · 100 suggestions · 15 merges · 3,652 unchanged/)).toBeInTheDocument();
    expect(es.closed).toBe(true);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ runId: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Review 115 →' }));
    expect(onOpenReview).toHaveBeenCalled();
  });

  test('a dropped connection (or another AI job running) is reported, not left spinning', async () => {
    render(<EnrichPanel apiKey="sk-ant-x" />);
    fireEvent.click(await screen.findByRole('button', { name: /\$ Enrich 812 cards/ }));
    act(() => FakeEventSource.instances[0].fail());
    expect(screen.getByText(/another AI job is already running/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$ Enrich/ })).toBeInTheDocument();
  });

  test('no API key: the run button is disabled', async () => {
    render(<EnrichPanel apiKey="" />);
    await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '812 cards to process');
    expect(screen.getByRole('button', { name: /\$ Enrich/ })).toBeDisabled();
    expect(screen.getByText('Needs a Claude API key.')).toBeInTheDocument();
  });
});
