import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AttributionPanel from './AttributionPanel';
import { workDetail } from '../testing/metaMock';

describe('AttributionPanel', () => {
  test('shows studio, genre › group, character, editions, term with the Drive label, and confidence explained', () => {
    render(<AttributionPanel model={workDetail} />);
    const panel = screen.getByRole('region', { name: 'Attribution' });
    expect(panel).toHaveTextContent('Wicked');
    expect(panel).toHaveTextContent(/Movies ›.*Jurassic Park/);
    expect(panel).toHaveTextContent('Alan Grant');
    expect(within(panel).getAllByText('Sculpture').length).toBeGreaterThan(0);
    const term = within(panel).getByText('Mar 2026', { selector: '.attr-term' });
    expect(term).toHaveAttribute('title', 'Drive term: GOOGLE DRIVE WICKED MOVIES MARCH TERM 2026');
    expect(panel).toHaveTextContent('Exact match');
    expect(panel).toHaveTextContent('Matched 11 of 14 files to your Gumroad purchases by exact size.');
    expect(panel).toHaveTextContent('Dagobah + Endor');
    expect(panel).toHaveTextContent('Claimed (Sep 2 2026) · since Mar 1, 2026');
  });

  test('per-product rows link to Gumroad in a new tab and list missing files (collapsed)', () => {
    render(<AttributionPanel model={workDetail} />);
    expect(screen.getByText('Products (2)')).toBeInTheDocument();
    const views = screen.getAllByRole('link', { name: /View on Gumroad/ });
    expect(views).toHaveLength(2);
    expect(views[0]).toHaveAttribute('href', 'https://wickedart.gumroad.com/l/xyz');
    for (const a of screen.getAllByRole('link')) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getAllByRole('link', { name: /Your Gumroad library/ })[0]).toHaveAttribute('href', 'https://gumroad.com/d/f079abc');
    expect(screen.getByText('6/8 files on NAS')).toBeInTheDocument();
    const missing = screen.getByText('2 files not on the NAS').closest('details');
    expect(missing).not.toHaveAttribute('open');
    expect(within(missing).getByText('Wicked - Alan Grant Sculpture (X Pose Images).zip')).toBeInTheDocument();
    fireEvent.click(screen.getByText('2 files not on the NAS'));
  });

  test('a single product puts its links on the Source row', () => {
    render(<AttributionPanel model={{ ...workDetail, products: [workDetail.products[0]] }} />);
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /View on Gumroad/ })).toHaveLength(1);
    expect(screen.getByText('Gumroad')).toBeInTheDocument();
  });

  test('handles partial data: no products, no attribution object, only list-level fields', () => {
    const partial = { id: 3, name: 'Gate', kind: 'diorama', studio: 'Wicked', creator_name: 'Wicked', confidence: 'none', release_term: '2025-11' };
    render(<AttributionPanel model={partial} />);
    const panel = screen.getByRole('region', { name: 'Attribution' });
    expect(panel).toHaveTextContent('Nov 2025');
    expect(panel).toHaveTextContent('Unattributed');
    expect(panel).toHaveTextContent('No purchase record matched');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/Products/)).not.toBeInTheDocument();
  });

  test('renders nothing for a plain folder model from an older backend', () => {
    const { container } = render(<AttributionPanel model={{ id: 1, name: 'x', creator_name: 'y', franchise: 'z' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

test('release items: no empty genre dash, group equal to the name is dropped, unknown source hidden', () => {
  render(<AttributionPanel model={{ id: 9, name: 'Aboleth', kind: 'release-item', creator_name: 'Loot Studios', franchise: null,
    group_name: 'Aboleth', release_label: 'Going Down the Drain', release_term: '2020-11', source: 'unknown', confidence: 'path' }} />);
  const panel = screen.getByRole('region', { name: 'Attribution' });
  expect(panel).not.toHaveTextContent('—');
  expect(screen.queryByText('Genre')).not.toBeInTheDocument();
  expect(screen.queryByText('Source')).not.toBeInTheDocument();
  expect(panel).toHaveTextContent('Going Down the Drain');
  expect(panel).toHaveTextContent('Creator');
});

test('lists the old cards folded into this work', () => {
  render(<AttributionPanel model={{ id: 4, name: 'Ken', studio: 'Wicked', confidence: 'exact',
    attribution: { confidence: 'exact', foldedFrom: [{ id: 7, name: 'Ken Bust' }, { id: 8, name: 'WICKED - Ken (Non Supported)', collection: 3 }, 'DC'] } }} />);
  expect(screen.getByText('Includes data from: Ken Bust, WICKED - Ken (Non Supported), DC')).toBeInTheDocument();
});
