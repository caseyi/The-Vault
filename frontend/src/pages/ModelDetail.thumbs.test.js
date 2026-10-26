import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';

jest.mock('../components/StlViewer', () => () => <div data-testid="stl-viewer" />);
jest.mock('../components/ZipImagePicker', () => () => <div data-testid="zip-picker" />);
jest.mock('../components/ClaudeAssistant', () => () => <div />);
jest.mock('../components/ReleaseFileList', () => () => <div />);
jest.mock('../components/RenderHintPanel', () => () => <div />);

const base = {
  id: 42, name: 'Dragon Bust', creator_name: 'Wicked', print_status: 'unprinted', tags: [], notes: '',
  images: ['/images/u42/front.jpg', '/images/u42/side.jpg'], thumbnail_path: '/images/u42/front.jpg',
  thumb_urls: ['/thumbs/u42/front.jpg?w=1280&v=1', '/thumbs/u42/side.jpg?w=1280&v=2'], thumb_source: 'folder',
  files: [], file_count: 0, hidden: 0,
};
const meshes = { files: [
  { path: '/library/W/Dragon/body.stl', label: 'body.stl', size: 52428800, triangles: null },
  { path: '/library/W/Dragon/parts.zip::head.stl', label: 'parts.zip: head.stl', size: 1048576, triangles: null },
] };

let model;
function mockFetch({ renderFails = false } = {}) {
  global.fetch = jest.fn((url, opts) => {
    const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
    if (url === '/api/models/42/meshes') return ok(meshes);
    if (url === '/api/models/42/thumbnail/render') {
      if (renderFails) return Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({ error: 'No mesh could be read' }) });
      model = { ...model, images: [...model.images, '/images/u42/stl-preview.png'], thumb_urls: [...model.thumb_urls, '/thumbs/u42/stl-preview.png?w=1280&v=5'], thumb_source: 'stl', thumbnail_path: '/images/u42/stl-preview.png' };
      return ok({ ok: true, images: model.images, thumbnail_path: '/images/u42/stl-preview.png', thumb_url: '/thumbs/u42/stl-preview.png?w=480&v=5', thumb_source: 'stl' });
    }
    if (url.includes('/detect-url')) return ok({ url: null });
    if (url.includes('/status-log')) return ok([]);
    if (url === '/api/models/42') return ok({ ...model });
    return ok({});
  });
}

beforeEach(() => { model = { ...base }; mockFetch(); });

test('main image uses the w=1280 thumb, filmstrip the w=480 one, lightbox the original', async () => {
  render(<ModelDetail modelId={42} onBack={jest.fn()} onSaved={jest.fn()} />);
  const main = await screen.findByAltText('Dragon Bust');
  expect(main).toHaveAttribute('src', '/thumbs/u42/front.jpg?w=1280&v=1');
  const strip = screen.getByRole('button', { name: 'Show image 2' }).querySelector('img');
  expect(strip).toHaveAttribute('src', '/thumbs/u42/side.jpg?w=480&v=2');
  expect(strip).toHaveAttribute('loading', 'lazy');
  fireEvent.click(screen.getByRole('button', { name: 'View image full size' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('img')).toHaveAttribute('src', '/images/u42/front.jpg');
});

test('older backend without thumb_urls shows the originals', async () => {
  model = { ...base, thumb_urls: undefined, thumb_source: undefined };
  render(<ModelDetail modelId={42} onBack={jest.fn()} onSaved={jest.fn()} />);
  const main = await screen.findByAltText('Dragon Bust');
  expect(main).toHaveAttribute('src', '/images/u42/front.jpg');
  expect(screen.getByRole('button', { name: 'Show image 2' }).querySelector('img')).toHaveAttribute('src', '/images/u42/side.jpg');
});

test('Render preview from model: pick a file, render, reload with the new picture', async () => {
  const onSaved = jest.fn();
  render(<ModelDetail modelId={42} onBack={jest.fn()} onSaved={onSaved} />);
  await screen.findByAltText('Dragon Bust');
  fireEvent.click(screen.getByRole('button', { name: /Render preview from model/ }));
  const select = await screen.findByLabelText('Model file');
  await waitFor(() => expect(screen.getByRole('option', { name: 'body.stl (50 MB)' })).toBeInTheDocument());
  expect(screen.getByRole('option', { name: 'Automatic (best match)' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: '/library/W/Dragon/parts.zip::head.stl' } });
  fireEvent.click(screen.getByRole('button', { name: 'Render preview' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const call = global.fetch.mock.calls.find(c => c[0] === '/api/models/42/thumbnail/render');
  expect(call[1].method).toBe('POST');
  expect(JSON.parse(call[1].body)).toEqual({ file: '/library/W/Dragon/parts.zip::head.stl' });
  // reloaded; viewer jumps to the rendered picture, marked as a 3D preview
  await waitFor(() => expect(screen.getByAltText('Dragon Bust')).toHaveAttribute('src', '/thumbs/u42/stl-preview.png?w=1280&v=5'));
  expect(screen.getByText('3D preview')).toBeInTheDocument();
});

test('Automatic render sends an empty body; errors are shown', async () => {
  mockFetch({ renderFails: true });
  render(<ModelDetail modelId={42} onBack={jest.fn()} onSaved={jest.fn()} />);
  await screen.findByAltText('Dragon Bust');
  fireEvent.click(screen.getByRole('button', { name: /Render preview from model/ }));
  await screen.findByRole('option', { name: 'body.stl (50 MB)' });
  fireEvent.click(screen.getByRole('button', { name: 'Render preview' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Render failed: No mesh could be read');
  const call = global.fetch.mock.calls.find(c => c[0] === '/api/models/42/thumbnail/render');
  expect(JSON.parse(call[1].body)).toEqual({});
});

test('a card without pictures still offers Render preview from model', async () => {
  model = { ...base, images: [], thumb_urls: [], thumbnail_path: null, thumb_source: null };
  render(<ModelDetail modelId={42} onBack={jest.fn()} onSaved={jest.fn()} />);
  await screen.findByLabelText('Model name');
  expect(screen.getByRole('button', { name: /Render preview from model/ })).toBeInTheDocument();
});
