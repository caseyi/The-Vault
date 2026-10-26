import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';

const models = [
  { id: 1, name: 'Dragon Bust', creator_name: 'Wicked', print_status: 'printed', has_stl: true,
    images: ['/images/u1/a.png', '/images/u1/b.png', '/images/u1/c.png'], thumbnail_path: '/images/u1/a.png',
    thumb_url: '/thumbs/u1/a.png?w=480&v=11', thumb_urls: ['/thumbs/u1/a.png?w=480&v=11', '/thumbs/u1/b.png?w=480&v=12'],
    thumb_source: 'archive-peek', hidden: 0 },
  { id: 2, name: 'Goblin Scout', creator_name: 'Archvillain', print_status: 'unprinted', has_stl: true,
    images: ['/images/u2/stl-preview.png'], thumbnail_path: '/images/u2/stl-preview.png',
    thumb_url: '/thumbs/u2/stl-preview.png?w=480&v=3', thumb_urls: ['/thumbs/u2/stl-preview.png?w=480&v=3'],
    thumb_source: 'stl', hidden: 0 },
  // older backend: no thumb fields
  { id: 3, name: 'Old Knight', creator_name: 'Test', print_status: 'sliced', has_stl: true,
    images: ['/images/u3/k.jpg'], thumbnail_path: '/images/u3/k.jpg', hidden: 0 },
  { id: 4, name: 'Bare Card', creator_name: 'Test', print_status: 'sliced', has_stl: true,
    images: [], thumbnail_path: null, thumb_url: null, thumb_urls: [], thumb_source: null, hidden: 0 },
];

const props = {
  filters: { search: '', creator: '', status: '', tags: '' },
  onFilterChange: jest.fn(), onModelClick: jest.fn(), showHidden: false, onRefreshStats: jest.fn(),
};

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ models, total: models.length, pages: 1, page: 1 }) }));
});

const cardImg = (name) => screen.getByAltText(name);

test('cards load the small cached thumbnail, with a reserved 4:3 box', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => cardImg('Dragon Bust'));
  const img = cardImg('Dragon Bust');
  expect(img).toHaveAttribute('src', '/thumbs/u1/a.png?w=480&v=11');
  expect(img).toHaveAttribute('width', '480');
  expect(img).toHaveAttribute('height', '360');
  expect(img).toHaveAttribute('loading', 'lazy');
});

test('hover cycling walks thumb_urls, not the originals', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => cardImg('Dragon Bust'));
  const next = screen.getAllByLabelText('Next image')[0];
  fireEvent.click(next);
  expect(cardImg('Dragon Bust')).toHaveAttribute('src', '/thumbs/u1/b.png?w=480&v=12');
  fireEvent.click(next);
  expect(cardImg('Dragon Bust')).toHaveAttribute('src', '/thumbs/u1/a.png?w=480&v=11');
  expect(props.onModelClick).not.toHaveBeenCalled();
});

test('falls back to the original image for an older backend', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => cardImg('Old Knight'));
  expect(cardImg('Old Knight')).toHaveAttribute('src', '/images/u3/k.jpg');
});

test('a thumbnail that fails to load retries the original once', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => cardImg('Dragon Bust'));
  fireEvent.error(cardImg('Dragon Bust'));
  expect(cardImg('Dragon Bust')).toHaveAttribute('src', '/images/u1/a.png');
  fireEvent.error(cardImg('Dragon Bust'));
  expect(screen.queryByAltText('Dragon Bust')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'No picture for Dragon Bust' })).toBeInTheDocument();
});

test('a 3D badge marks previews rendered from the mesh only', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => cardImg('Goblin Scout'));
  const badges = screen.getAllByRole('img', { name: '3D preview rendered from the model' });
  expect(badges).toHaveLength(1);
  expect(badges[0]).toHaveTextContent('3D');
  expect(cardImg('Goblin Scout').closest('.model-card')).toContainElement(badges[0]);
});

test('a card without any picture shows the labelled placeholder', async () => {
  render(<Gallery {...props} />);
  await waitFor(() => screen.getByText('Bare Card'));
  expect(screen.getByRole('img', { name: 'No picture for Bare Card' })).toBeInTheDocument();
});
