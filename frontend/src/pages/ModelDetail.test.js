import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail, { AUTOSAVE_DELAY } from './ModelDetail';

const patchCalls = () => global.fetch.mock.calls.filter(([url, opts]) => url === '/api/models/42' && opts && opts.method === 'PATCH');
const patchBodies = () => patchCalls().map(([, opts]) => JSON.parse(opts.body));
const nameInput = () => screen.getByLabelText('Model name');

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
      expect(nameInput()).toHaveValue('Dragon Bust');
    });
  });

  test('shows back button that calls onBack', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
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

  test('there is no manual Save button any more (edits autosave)', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    expect(screen.queryByText('SAVE CHANGES')).not.toBeInTheDocument();
    expect(screen.getByText('Changes save automatically.')).toBeInTheDocument();
  });

  test('Ask Claude button toggles assistant panel', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());

    expect(screen.queryByTestId('claude-assistant')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Ask Claude/));
    expect(screen.getByTestId('claude-assistant')).toBeInTheDocument();
  });

  test('hide button toggles hidden state', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());

    fireEvent.click(screen.getByText('🙈 Hide'));

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

describe('ModelDetail autosave', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((url, opts) => {
      if (opts && opts.method === 'PATCH') return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      if (url.includes('/detect-url')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ url: null }) });
      if (url.includes('/status-log') || url.includes('/tag-suggestions') || url.includes('/collections') || url === '/api/queue') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...mockModel }) });
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('status change saves immediately and shows "Saved"', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    fireEvent.change(screen.getByDisplayValue('Unprinted'), { target: { value: 'sliced' } });
    await waitFor(() => expect(patchBodies()).toContainEqual({ print_status: 'sliced' }));
    expect(await screen.findByText('✓ Saved')).toBeInTheDocument();
    expect(defaultProps.onSaved).toHaveBeenCalled();
  });

  test('adding and removing tags saves immediately', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: 'Dragon' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patchBodies()).toContainEqual({ tags: ['fantasy', 'bust', 'dragon'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag fantasy' }));
    await waitFor(() => expect(patchBodies()).toContainEqual({ tags: ['bust', 'dragon'] }));
  });

  test('notes are debounced into one PATCH with the final text', async () => {
    jest.useFakeTimers();
    render(<ModelDetail {...defaultProps} />);
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => nameInput());
    const notes = screen.getByDisplayValue('Great detail');
    fireEvent.change(notes, { target: { value: 'Great detail, 0.05mm' } });
    act(() => { jest.advanceTimersByTime(300); });
    fireEvent.change(notes, { target: { value: 'Great detail, 0.05mm layers' } });
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(AUTOSAVE_DELAY - 50); });
    expect(patchCalls()).toHaveLength(0);
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(patchBodies()).toEqual([{ notes: 'Great detail, 0.05mm layers' }]);
  });

  test('Back flushes pending edits instead of dropping them', async () => {
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    fireEvent.change(screen.getByLabelText('Source URL'), { target: { value: 'https://www.printables.com/model/999' } });
    fireEvent.click(screen.getByText('← Back'));
    expect(defaultProps.onBack).toHaveBeenCalled();
    await waitFor(() => expect(patchBodies()).toContainEqual({ source_url: 'https://www.printables.com/model/999' }));
  });

  test('unmounting with a pending edit sends it (keepalive)', async () => {
    const { unmount } = render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    fireEvent.change(nameInput(), { target: { value: 'Dragon Bust v2' } });
    unmount();
    const call = patchCalls().find(([, o]) => JSON.parse(o.body).name === 'Dragon Bust v2');
    expect(call).toBeDefined();
    expect(call[1].keepalive).toBe(true);
  });

  test('a failed save shows "Save failed – retry" and retry re-sends the edit', async () => {
    let fail = true;
    const base = global.fetch;
    global.fetch = jest.fn((url, opts) => {
      if (opts && opts.method === 'PATCH' && fail) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Database is locked' }) });
      }
      return base(url, opts);
    });
    render(<ModelDetail {...defaultProps} />);
    await waitFor(() => nameInput());
    fireEvent.change(screen.getByDisplayValue('Unprinted'), { target: { value: 'printed' } });
    expect(await screen.findByText(/Save failed/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(await screen.findByText('✓ Saved')).toBeInTheDocument();
    expect(patchBodies().filter(b => b.print_status === 'printed')).toHaveLength(2);
  });
});
