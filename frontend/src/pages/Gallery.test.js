import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';

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

  test('search input filters via onFilterChange', async () => {
    render(<Gallery {...defaultProps} />);
    const input = screen.getByPlaceholderText(/Search models/);
    fireEvent.change(input, { target: { value: 'dragon' } });
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'dragon' })
    );
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
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('show_hidden=1')
      );
    });
  });

  test('does not pass show_hidden param when showHidden is false', async () => {
    render(<Gallery {...defaultProps} showHidden={false} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.not.stringContaining('show_hidden')
      );
    });
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
});
