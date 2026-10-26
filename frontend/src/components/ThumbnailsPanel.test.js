import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ThumbnailsPanel from './ThumbnailsPanel';
import ScanModal from './ScanModal';
import { FakeEventSource } from '../testing/enrichMock';

jest.mock('./EnrichPanel', () => () => <div data-testid="enrich-panel" />);

const status = { sharp: true, cached: 1200, missing: 30, generating: 0, bytes: 81234567,
  cards: { withPicture: 4100, rendered: 600, missing: 280 } };

const json = (body, ok = true, st = 200) => Promise.resolve({ ok, status: st, json: () => Promise.resolve(body) });

function mockFetch(overrides = {}) {
  global.fetch = jest.fn((url, opts) => {
    if (url === '/api/thumbs/status') return overrides.status ? overrides.status() : json(status);
    if (url === '/api/thumbs/rebuild' && opts && opts.method === 'POST') return json({ ok: true, queued: 1230 });
    if (url === '/api/scan/status') return json({ inProgress: false });
    if (url === '/api/library/roots') return json({ roots: [], libraryPath: '/library' });
    return json({});
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  global.EventSource = FakeEventSource;
  mockFetch();
});

test('shows picture counts and cache size', async () => {
  render(<ThumbnailsPanel />);
  await waitFor(() => expect(screen.getByText('4,100')).toBeInTheDocument());
  expect(screen.getByText('With picture')).toBeInTheDocument();
  expect(screen.getByText('600')).toBeInTheDocument();
  expect(screen.getByText('280')).toBeInTheDocument();
  expect(screen.getByText(/77 MB/)).toBeInTheDocument();
  expect(screen.getByText(/1,200 cached, 30 to go/)).toBeInTheDocument();
});

test('hides itself when the backend has no thumbnail support (404)', async () => {
  mockFetch({ status: () => json({ error: 'Not found' }, false, 404) });
  const { container } = render(<ThumbnailsPanel />);
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});

test('Find missing pictures streams the fill job into the task log', async () => {
  const onChanged = jest.fn();
  const onRunningChange = jest.fn();
  render(<ThumbnailsPanel onChanged={onChanged} onRunningChange={onRunningChange} />);
  await waitFor(() => screen.getByText('4,100'));
  fireEvent.click(screen.getByRole('button', { name: 'Find missing pictures' }));
  const es = FakeEventSource.instances[0];
  expect(es.url).toBe('/api/thumbs/fill?scope=missing&steps=peek%2Crender');
  expect(onRunningChange).toHaveBeenLastCalledWith(true);

  act(() => es.emit({ level: 'img', msg: 'Bane: 2 pictures inside bane 1-6.zip', ts: '2026-10-27T10:00:00Z' }));
  act(() => es.emit({ type: 'progress', done: 5, total: 20, found: { folder: 1, archive: 0, peek: 2, stl: 1 }, failed: 1 }));
  expect(screen.getByRole('log', { name: 'THUMBNAIL LOG' })).toHaveTextContent('Bane: 2 pictures inside bane 1-6.zip');
  expect(screen.getByText(/5 \/ 20 cards checked, 1 failed/)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Find missing pictures progress' })).toHaveAttribute('value', '25');
  expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();

  act(() => es.emit({ type: 'done', success: true, done: 20, found: { folder: 1, archive: 2, peek: 6, stl: 9 }, failed: 2 }));
  expect(es.closed).toBe(true);
  expect(screen.getByText(/Done: 20 cards checked; found folder 1, archive 2, inside zips 6, 3D renders 9; 2 failed/)).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onRunningChange).toHaveBeenLastCalledWith(false);
  // status refreshed after the job
  await waitFor(() => expect(global.fetch.mock.calls.filter(c => c[0] === '/api/thumbs/status').length).toBeGreaterThanOrEqual(2));
});

test('options change the scope and steps', async () => {
  render(<ThumbnailsPanel />);
  await waitFor(() => screen.getByText('4,100'));
  fireEvent.click(screen.getByLabelText(/Recheck every card/));
  fireEvent.click(screen.getByLabelText(/Render from 3D files/));
  fireEvent.click(screen.getByRole('button', { name: 'Find missing pictures' }));
  expect(FakeEventSource.instances[0].url).toBe('/api/thumbs/fill?scope=all&steps=peek');
});

test('an immediate stream error (409, job already running) is explained', async () => {
  render(<ThumbnailsPanel />);
  await waitFor(() => screen.getByText('4,100'));
  fireEvent.click(screen.getByRole('button', { name: 'Find missing pictures' }));
  act(() => FakeEventSource.instances[0].fail());
  expect(screen.getByRole('log')).toHaveTextContent(/thumbnail job is probably already running/);
  expect(screen.getByRole('button', { name: 'Find missing pictures' })).toBeEnabled();
});

test('Rebuild cache posts and reports the queued count', async () => {
  render(<ThumbnailsPanel />);
  await waitFor(() => screen.getByText('4,100'));
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild cache' }));
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('1,230 images queued'));
  expect(global.fetch).toHaveBeenCalledWith('/api/thumbs/rebuild', expect.objectContaining({ method: 'POST' }));
});

test('the Scan window shows the Thumbnails section', async () => {
  render(<ScanModal onClose={jest.fn()} onScanComplete={jest.fn()} filters={{}} />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'THUMBNAILS' })).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('4,100')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Find missing pictures' })).toBeInTheDocument();
});
