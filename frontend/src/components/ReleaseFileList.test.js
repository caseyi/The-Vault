import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReleaseFileList, { groupByEditionVariant, formatBytes } from './ReleaseFileList';
import { workDetail } from '../testing/metaMock';

describe('ReleaseFileList: works grouped by edition then variant', () => {
  test('groups and orders editions (Sculpture, Bust) and variants with friendly labels', () => {
    const groups = groupByEditionVariant(workDetail.files);
    expect(groups.map(g => g.edition)).toEqual(['Sculpture', 'Bust']);
    expect(groups[0].variants.map(v => v.label)).toEqual(['Non Supported', 'Pre-supported (Chitubox)', 'X Pose']);
    expect(groups[1].variants.map(v => v.label)).toEqual(['Non Supported', 'One Piece', 'Images']);
  });

  test('renders edition sections with variant groups and library per file when asked', () => {
    render(<ReleaseFileList files={workDetail.files} showLibrary />);
    const sculpture = screen.getByRole('region', { name: 'Sculpture' });
    expect(within(sculpture).getByRole('button', { name: /Sculpture/ })).toHaveAttribute('aria-expanded', 'true');
    const chitu = within(sculpture).getByRole('group', { name: 'Pre-supported (Chitubox)' });
    expect(within(chitu).getByText('Wicked - Alan Grant Sculpture (Chitubox Pre Supported).zip')).toBeInTheDocument();
    expect(within(chitu).getByText('Endor')).toBeInTheDocument();
    expect(within(chitu).getByText('2.33 GB')).toBeInTheDocument();
    expect(within(sculpture).getByText('Dagobah + Endor')).toBeInTheDocument();
    const bust = screen.getByRole('region', { name: 'Bust' });
    expect(within(bust).getByRole('group', { name: 'One Piece' })).toBeInTheDocument();
    // collapse an edition
    fireEvent.click(within(bust).getByRole('button', { name: /Bust/ }));
    expect(within(bust).queryByRole('group', { name: 'One Piece' })).not.toBeInTheDocument();
  });

  test('no library labels when the work lives in one library', () => {
    render(<ReleaseFileList files={workDetail.files} />);
    expect(screen.queryByText('Endor')).not.toBeInTheDocument();
  });

  test('print mode toggles still work inside groups', () => {
    const onTogglePrinted = jest.fn();
    render(<ReleaseFileList files={workDetail.files} printMode onTogglePrinted={onTogglePrinted} />);
    const boxes = screen.getAllByTitle('Mark as printed');
    expect(boxes).toHaveLength(6);
    fireEvent.click(boxes[0]);
    expect(onTogglePrinted).toHaveBeenCalledWith(expect.objectContaining({ id: 2 })); // Sculpture / Non Supported first
  });

  test('release items without editions list variants (scales) directly', () => {
    const files = [
      { id: 1, filename: 'orc_75.stl', filetype: 'stl', variant: '75mm' },
      { id: 2, filename: 'orc_32.stl', filetype: 'stl', variant: '32mm' },
      { id: 3, filename: 'orc_sup.lys', filetype: 'slicer', variant: 'supported' },
    ];
    render(<ReleaseFileList files={files} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))).toEqual(['32mm', '75mm', 'Supported']);
  });

  test('legacy files (no edition/variant) keep release grouping', () => {
    render(<ReleaseFileList files={[{ id: 1, filename: 'a.stl', filetype: 'stl', release_name: 'Pack A' }, { id: 2, filename: 'b.stl', filetype: 'stl', release_name: 'Pack B' }]} />);
    expect(screen.getByText('Pack A')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  test('formatBytes reaches GB', () => {
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.00 GB');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
