import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

// Mock fetch responses for the initial load
beforeEach(() => {
  global.fetch = jest.fn((url) => {
    if (url.includes('/api/stats')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ total: 5, creators: 2, withImages: 3, byStatus: [] }),
      });
    }
    if (url.includes('/api/creators')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { id: 1, name: 'ArtistA', model_count: 3 },
          { id: 2, name: 'ArtistB', model_count: 2 },
        ]),
      });
    }
    if (url.includes('/api/models')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          models: [
            { id: 1, name: 'Dragon', creator_name: 'ArtistA', print_status: 'unprinted', tags: [], images: [] },
          ],
          total: 1, page: 1, pages: 1,
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('App', () => {
  test('renders THE VAULT header', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('THE')).toBeInTheDocument();
      expect(screen.getByText('VAULT')).toBeInTheDocument();
    });
  });

  test('renders sidebar with Library section', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
  });

  test('renders filter status buttons', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('All Models')).toBeInTheDocument();
      expect(screen.getByText('Unprinted')).toBeInTheDocument();
      expect(screen.getByText('Printed')).toBeInTheDocument();
    });
  });

  test('fetches stats and creators on mount', async () => {
    render(<App />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/stats'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/creators'));
    });
  });

  test('sidebar toggle collapses sidebar', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    const collapseBtn = screen.getByTitle('Collapse');
    fireEvent.click(collapseBtn);
    // Library section should be gone when sidebar is collapsed
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });
});
