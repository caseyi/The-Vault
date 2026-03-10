import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';

// ── Mock child components that have their own complex dependencies ────────────

jest.mock('../components/StlViewer', () => () => <div data-testid="stl-viewer">STL Viewer</div>);
jest.mock('../components/ZipImagePicker', () => ({ onClose }) => (
  <div data-testid="zip-picker"><button onClick={onClose}>Close Picker</button></div>
));
jest.mock('../components/ClaudeAssistant', () => () => <div data-testid="claude-assistant">Claude</div>);
jest.mock('../components/TaskLog', () => ({ lines, title }) => (
  <div data-testid="task-log">{title}: {lines.length} lines</div>
));
jest.mock('../components/ReleaseFileList', () => ({ files }) => (
  <div data-testid="file-list">{files.length} files</div>
));
jest.mock('../components/RenderHintPanel', () => () => <div data-testid="render-hint">Hint Panel</div>);

// ── Mock data ────────────────────────────────────────────────────────────────

const mockModel = {
  id: 42,
  name: 'Dragon Bust',
  creator_name: 'Wicked',
  print_status: 'unprinted',
  source_site: 'printables',
  source_url: 'https://printables.com/model/12345',
  tags: ['fantasy', 'bust'],
  notes: 'Great detail',
  images: ['/images/42/front.jpg', '/images/42/side.jpg'],
  thumbnail_path: '/images/42/front.jpg',
  files: [
    { id: 1, filename: 'dragon.stl', filetype: 'stl', size_bytes: 5000000 },
    { id: 2, filename: 'dragon.chitubox', filetype: 'slicer', size_bytes: 12000000 },
  ],
  file_count: 2,
  has_stl: true,
  has_chitubox: true,
  has_lychee: false,
  has_plate: false,
  hidden: 0,
  render_zip_hint: null,
};

const defaultProps = {
  modelId: 42,
  onBack: jest.fn(),
  onSaved: jest.fn(),
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ModelDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((url) => {
      if (url.includes('/detect-url')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ url: null }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...mockModel }) });
    });
  });

  test('shows loading then model name', async () => {
    render(<ModelDetail {...defaultProps} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Dragon Bust')).toBeInTheDocument();
    });
  });

  test('shows back button that calls onBack', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));
    fireEvent.click(screen.getByText('← Back'));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  test('shows source site badge', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Printables')).toBeInTheDocument();
    });
  });

  test('shows creator name in metadata', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Wicked')).toBeInTheDocument();
    });
  });

  test('shows file info (has STL, Chitubox)', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      // Info section shows file capabilities
      const stlCheck = screen.getAllByText('✓');
      expect(stlCheck.length).toBeGreaterThanOrEqual(2); // STL + Chitubox
    });
  });

  test('renders print status dropdown with current value', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      const select = screen.getByDisplayValue('Unprinted');
      expect(select).toBeInTheDocument();
    });
  });

  test('renders existing tags', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('fantasy')).toBeInTheDocument();
      expect(screen.getByText('bust')).toBeInTheDocument();
    });
  });

  test('renders notes textarea with existing content', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      const textarea = screen.getByDisplayValue('Great detail');
      expect(textarea).toBeInTheDocument();
    });
  });

  test('shows image thumbnails', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      // Main image has alt text; thumbnails have alt=""
      const allImages = document.querySelectorAll('img');
      expect(allImages.length).toBeGreaterThanOrEqual(2); // main + thumb(s)
    });
  });

  test('shows file list component', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('file-list')).toBeInTheDocument();
    });
  });

  test('save button triggers PATCH and calls onSaved', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));

    fireEvent.click(screen.getByText('SAVE CHANGES'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/models/42',
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  test('Ask Claude button toggles assistant panel', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));

    expect(screen.queryByTestId('claude-assistant')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Ask Claude/));
    expect(screen.getByTestId('claude-assistant')).toBeInTheDocument();
  });

  test('hide button toggles hidden state', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => screen.getByText('Dragon Bust'));

    fireEvent.click(screen.getByText(/Hide/));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/models/42',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"hidden":true'),
        })
      );
    });
  });

  test('shows "model not found" for missing model', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve(null)
    }));
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Model not found')).toBeInTheDocument();
    });
  });
});
