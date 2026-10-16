import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery, { SEARCH_DEBOUNCE_MS } from './Gallery';
import { EMPTY_FILTERS } from '../filters';

const fetchedUrls = () => global.fetch.mock.calls.map(c => c[0]);

// ── Mock data ────────────────────────────────────────────────────────────────

const mockModels = [
  { id: 1, name: 'Dragon Bust', creator_name: 'Wicked', print_status: 'printed', has_stl: true, has_chitubox: false, has_lychee: false, images: ['/images/1/dragon.jpg'], thumbnail_path: '/images/1/dragon.jpg', hidden: 0 },
  { id: 2, name: 'Goblin Scout', creator_name: 'Archvillain', print_status: 'unprinted', has_stl: true, has_chitubox: true, has_lychee: false, images: [], thumbnail_path: null, hidden: 0 },
  { id: 3, name: 'Hidden Model', creator_name: 'Test', print_status: 'sliced', has_stl: true, has_chitubox: false, has_lychee: false, images: [], thumbnail_path: null, hidden: 1 },
];

const defaultProps = {
  filters: { search: '', creator: '', status: '', tags: '' },
  onFilterChange: jest.fn(),
  onModelClick: jest.fn(),
  showHidden: false,
  onRefreshStats: jest.fn(),
};

function mockFetchResponse(models = mockModels, total = null) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      models,
      total: total ?? models.length,
      pages: 1,
      page: 1,
    }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gallery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(() => mockFetchResponse());
  });

  test('renders model cards after fetching', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Dragon Bust')).toBeInTheDocument();
      expect(screen.getByText('Goblin Scout')).toBeInTheDocument();
    });
  });

  test('shows model count in header', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('3 models')).toBeInTheDocument();
    });
  });

  test('shows empty state when no models returned', async () => {
    global.fetch = jest.fn(() => mockFetchResponse([], 0));
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('VAULT IS EMPTY')).toBeInTheDocument();
    });
  });

  test('shows creator name on cards', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Wicked')).toBeInTheDocument();
      expect(screen.getByText('Archvillain')).toBeInTheDocument();
    });
  });

  test('shows status badges on cards', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/● printed/)).toBeInTheDocument();
      expect(screen.getByText(/○ unprinted/)).toBeInTheDocument();
    });
  });

  test('shows file type indicators (STL, CHI)', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      const stlBadges = screen.getAllByText('STL');
      expect(stlBadges.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('CHI')).toBeInTheDocument();
    });
  });

  test('calls onModelClick when a card is clicked', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));
    fireEvent.click(screen.getByText('Dragon Bust'));
    expect(defaultProps.onModelClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, name: 'Dragon Bust' })
    );
  });

  test('search input filters via onFilterChange (debounced)', async () => {
    render(<Gallery {...defaultProps} />);
    const input = screen.getByPlaceholderText(/Search models/);
    fireEvent.change(input, { target: { value: 'dragon' } });
    expect(input).toHaveValue('dragon');
    await waitFor(() => expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'dragon' })
    ));
  });

  test('toggling bulk mode shows Select/Cancel button', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));
    const selectBtn = screen.getByText(/Select/);
    fireEvent.click(selectBtn);
    expect(screen.getByText(/Cancel/)).toBeInTheDocument();
  });

  test('passes show_hidden param when showHidden is true', async () => {
    render(<Gallery {...defaultProps} showHidden={true} />);
    await waitFor(() => {
      expect(fetchedUrls().some(u => u.includes('show_hidden=1'))).toBe(true);
    });
  });

  test('does not pass show_hidden param when showHidden is false', async () => {
    render(<Gallery {...defaultProps} showHidden={false} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(fetchedUrls().some(u => u.includes('show_hidden'))).toBe(false);
  });

  test('HIDDEN badge appears on hidden models', async () => {
    render(<Gallery {...defaultProps} showHidden={true} />);
    await waitFor(() => {
      expect(screen.getByText('HIDDEN')).toBeInTheDocument();
    });
  });

  test('shows no-image placeholder when model has no thumbnail', async () => {
    render(<Gallery {...defaultProps} />);
    await waitFor(() => {
      const placeholders = screen.getAllByText('🧩');
      expect(placeholders.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('model cards are keyboard focusable and open on Enter', async () => {
    render(<Gallery {...defaultProps} />);
    const open = await screen.findByRole('button', { name: 'Open Dragon Bust' });
    open.focus();
    expect(open).toHaveFocus();
    fireEvent.click(open); // Enter/Space on a native button dispatches click
    expect(defaultProps.onModelClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});

// ── Filter chips ─────────────────────────────────────────────────────────────

describe('Gallery filter chips', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(() => mockFetchResponse());
  });

  const activeFilters = {
    ...EMPTY_FILTERS,
    status: 'printed', creator: 'Wicked', franchise: 'Star Wars', collection: '7',
    folder: '/library/Wicked/Busts', tags: 'bust,resin', favorite: true, search: 'dragon',
  };

  test('lists every active filter as a removable chip', async () => {
    render(<Gallery {...defaultProps} filters={activeFilters} collections={[{ id: 7, name: 'Busts To Paint' }]} />);
    const bar = await screen.findByLabelText('Active filters');
    expect(bar).toHaveTextContent('printed');
    expect(bar).toHaveTextContent('Wicked');
    expect(bar).toHaveTextContent('Star Wars');
    expect(bar).toHaveTextContent('Busts To Paint'); // collection id resolved to its name
    expect(bar).toHaveTextContent('Busts');          // folder shows last path segment
    expect(bar).toHaveTextContent('bust');
    expect(bar).toHaveTextContent('resin');
    expect(bar).toHaveTextContent('Favorites');
    expect(bar).toHaveTextContent('"dragon"');
  });

  test('✕ on a chip removes only that filter', async () => {
    const onFilterChange = jest.fn();
    render(<Gallery {...defaultProps} filters={activeFilters} onFilterChange={onFilterChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter Tag bust' }));
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ tags: 'resin', status: 'printed', creator: 'Wicked' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Creator Wicked' }));
    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ creator: '', status: 'printed' }));
  });

  test('Clear all resets every filter (and hidden toggle)', async () => {
    const onFilterChange = jest.fn();
    const onToggleHidden = jest.fn();
    render(<Gallery {...defaultProps} filters={activeFilters} onFilterChange={onFilterChange}
      showHidden onToggleHidden={onToggleHidden} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(onFilterChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS });
    expect(onToggleHidden).toHaveBeenCalled();
  });

  test('no chip bar when nothing is filtered', async () => {
    render(<Gallery {...defaultProps} />);
    await screen.findByText('Dragon Bust');
    expect(screen.queryByLabelText('Active filters')).not.toBeInTheDocument();
  });

  test('filters that match nothing show "No models match" + Clear instead of "Vault is empty"', async () => {
    global.fetch = jest.fn(() => mockFetchResponse([], 0));
    const onFilterChange = jest.fn();
    render(<Gallery {...defaultProps} filters={{ ...EMPTY_FILTERS, status: 'failed' }} onFilterChange={onFilterChange} />);
    expect(await screen.findByText('No models match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('VAULT IS EMPTY')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onFilterChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS });
  });

  test('empty library offers a Scan library button', async () => {
    global.fetch = jest.fn(() => mockFetchResponse([], 0));
    const onScanClick = jest.fn();
    render(<Gallery {...defaultProps} onScanClick={onScanClick} />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan library/ }));
    expect(onScanClick).toHaveBeenCalled();
  });
});

// ── Search debounce + latest-request-wins ────────────────────────────────────

describe('Gallery search', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { jest.useRealTimers(); });

  test('debounces keystrokes into a single filter update', () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => mockFetchResponse());
    const onFilterChange = jest.fn();
    render(<Gallery {...defaultProps} onFilterChange={onFilterChange} />);
    const input = screen.getByPlaceholderText(/Search models/);
    for (const v of ['s', 'sa', 'sam', 'samu', 'samur', 'samura', 'samurai']) {
      fireEvent.change(input, { target: { value: v } });
      act(() => { jest.advanceTimersByTime(40); });
    }
    expect(onFilterChange).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'samurai' }));
  });

  test('a slow response for an older query never overwrites the newer results', async () => {
    const resolvers = {};
    const signals = {};
    global.fetch = jest.fn((url, opts) => {
      const q = new URL(url, 'http://x').searchParams.get('search') || '';
      signals[q] = opts && opts.signal;
      return new Promise(resolve => { resolvers[q] = resolve; });
    });
    const answer = (q, models) => resolvers[q]({ ok: true, json: () => Promise.resolve({ models, total: models.length, page: 1, pages: 1 }) });

    const { rerender } = render(<Gallery {...defaultProps} filters={{ ...EMPTY_FILTERS, search: 's' }} />);
    rerender(<Gallery {...defaultProps} filters={{ ...EMPTY_FILTERS, search: 'samurai' }} />);
    await waitFor(() => expect(resolvers.samurai).toBeDefined());

    // The older request was aborted when the newer one started
    expect(signals.s && signals.s.aborted).toBe(true);

    // Newer query answers first, then the stale one arrives late
    await act(async () => { answer('samurai', [{ ...mockModels[0], id: 10, name: 'Samurai Oni' }]); });
    await act(async () => { answer('s', mockModels); });

    expect(await screen.findByText('Samurai Oni')).toBeInTheDocument();
    expect(screen.queryByText('Goblin Scout')).not.toBeInTheDocument();
    expect(screen.getByText('1 models')).toBeInTheDocument();
  });
});
