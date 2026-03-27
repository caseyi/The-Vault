import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from './Sidebar';

const defaultProps = {
  open: true,
  onToggle: jest.fn(),
  stats: { total: 10, creators: 3, withImages: 7, byStatus: [
    { print_status: 'unprinted', n: 5 },
    { print_status: 'printed', n: 3 },
    { print_status: 'failed', n: 2 },
  ]},
  creators: [
    { id: 1, name: 'ArtistA', model_count: 6, render_zip_hint: null },
    { id: 2, name: 'ArtistB', model_count: 4, render_zip_hint: '*renders*' },
  ],
  tags: [{ tag: 'fantasy', count: 5 }, { tag: 'sci-fi', count: 3 }],
  filters: { search: '', creator: '', status: '', tags: '', has_thumbnail: false },
  onFilterChange: jest.fn(),
  onScanClick: jest.fn(),
  onHomeClick: jest.fn(),
};

afterEach(() => { jest.clearAllMocks(); });

describe('Sidebar', () => {
  test('renders stats when open', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Total models')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getAllByText(/Creators/i).length).toBeGreaterThan(0);
    expect(screen.getByText('With images')).toBeInTheDocument();
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
  });

  test('renders status filter buttons', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('All Models')).toBeInTheDocument();
    expect(screen.getByText('Unprinted')).toBeInTheDocument();
    expect(screen.getByText('Sliced')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.getByText('Printed')).toBeInTheDocument();
    expect(screen.getByText('Painted')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  test('clicking status filter calls onFilterChange', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Printed'));
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'printed' })
    );
  });

  test('renders creator list', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('ArtistA')).toBeInTheDocument();
    expect(screen.getByText('ArtistB')).toBeInTheDocument();
    expect(screen.getByText('All Creators')).toBeInTheDocument();
  });

  test('clicking creator calls onFilterChange', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('ArtistA'));
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ creator: 'ArtistA' })
    );
  });

  test('shows render hint icon for creators with hint', () => {
    render(<Sidebar {...defaultProps} />);
    // ArtistB has render_zip_hint set
    expect(screen.getByTitle('Render hint: *renders*')).toBeInTheDocument();
  });

  test('hides content when sidebar is closed', () => {
    render(<Sidebar {...defaultProps} open={false} />);
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
    expect(screen.queryByText('Total models')).not.toBeInTheDocument();
  });

  test('toggle button calls onToggle', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Collapse'));
    expect(defaultProps.onToggle).toHaveBeenCalled();
  });

  test('scan button calls onScanClick', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText(/SCAN LIBRARY/i));
    expect(defaultProps.onScanClick).toHaveBeenCalled();
  });

  test('logo button calls onHomeClick', () => {
    render(<Sidebar {...defaultProps} />);
    const logo = screen.getByText('THE').closest('button');
    fireEvent.click(logo);
    expect(defaultProps.onHomeClick).toHaveBeenCalled();
  });

  test('displays status counts', () => {
    render(<Sidebar {...defaultProps} />);
    // Counts should appear next to status labels
    expect(screen.getAllByText('5').length).toBeGreaterThan(0); // unprinted
    expect(screen.getAllByText('2').length).toBeGreaterThan(0); // failed
  });

  test('renders tag cloud', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Tags')).toBeInTheDocument();
    expect(screen.getByText('fantasy')).toBeInTheDocument();
    expect(screen.getByText('sci-fi')).toBeInTheDocument();
  });

  test('clicking tag calls onFilterChange with tag', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('fantasy'));
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 'fantasy' })
    );
  });

  test('renders Has Thumbnail filter', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('Has Thumbnail')).toBeInTheDocument();
  });

  test('clicking Has Thumbnail toggles filter', () => {
    render(<Sidebar {...defaultProps} />);
    fireEvent.click(screen.getByText('Has Thumbnail'));
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ has_thumbnail: true })
    );
  });
});
