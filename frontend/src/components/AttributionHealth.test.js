import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import OrganizeModal from './OrganizeModal';
import { NoticeProvider } from './Notices';
import { mockFetch, attributionSummary, attributionGaps, metaStatus } from '../testing/metaMock';

const health = {
  summary: { total: 3, crossCreatorDupes: 0, duplicatePairs: 1, noTags: 0, noThumbnail: 0, noFranchise: 0, emptyFolders: 0, noSource: 0 },
  crossCreatorDupes: [],
  duplicates: [{
    a: { id: 1, name: 'Ken Bust', creator_name: 'Wicked', library: 'Dagobah', file_count: 4 },
    b: { id: 2, name: 'Ken Bust', creator_name: 'Wicked', library: 'Endor', file_count: 4 },
    score: 1, crossLibrary: true,
  }],
  noTags: [], noThumbnail: [], noFranchise: [], emptyFolders: [], noSource: [],
};

const openHealth = async () => {
  render(<NoticeProvider><OrganizeModal onClose={() => {}} /></NoticeProvider>);
  fireEvent.click(screen.getByRole('tab', { name: /Health/ }));
  await screen.findByText('Total');
};

describe('Health → Attribution', () => {
  test('shows coverage by library/studio/confidence, owned-not-on-NAS products, and _Meta status', async () => {
    mockFetch([
      ['/api/organize/health', health],
      ['/api/attribution/summary', attributionSummary],
      ['/api/attribution/gaps', attributionGaps],
      ['/api/meta/status', metaStatus],
    ], []);
    await openHealth();
    const tab = await screen.findByRole('tab', { name: /Attribution/ });
    expect(within(tab).getByText('2')).toBeInTheDocument(); // gaps badge
    fireEvent.click(tab);
    expect(await screen.findByText('71%')).toBeInTheDocument(); // 705 / 1000
    expect(screen.getByRole('rowheader', { name: 'Dagobah' })).toBeInTheDocument();
    expect(screen.getByText('520 / 700')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'ZEZ' })).toBeInTheDocument();
    expect(await screen.findByText('Wicked Marvel Conan Bust')).toBeInTheDocument();
    const dl = screen.getByRole('link', { name: /Download Wicked Marvel Conan Bust/ });
    expect(dl).toHaveAttribute('href', 'https://gumroad.com/d/zz1');
    expect(dl).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: /Product page ZEZ Boba Fett/ })).toHaveAttribute('target', '_blank');
    expect(await screen.findByText('1,520')).toBeInTheDocument();
    // creator filter
    fireEvent.change(screen.getByLabelText('Filter missing products by creator'), { target: { value: 'ZEZ' } });
    expect(screen.queryByText('Wicked Marvel Conan Bust')).not.toBeInTheDocument();
  });

  test('Reload metadata POSTs /api/meta/reload and shows the new counts and errors', async () => {
    const after = { ...metaStatus, counts: { ...metaStatus.counts, products: 1600 }, errors: ['gumroad_manifest_2.json: Unexpected token'] };
    const f = mockFetch([
      ['/api/organize/health', health],
      ['/api/attribution/summary', attributionSummary],
      ['/api/attribution/gaps', attributionGaps],
      ['/api/meta/status', metaStatus],
      ['/api/meta/reload', after],
    ], []);
    await openHealth();
    fireEvent.click(await screen.findByRole('tab', { name: /Attribution/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Reload metadata/ }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => u === '/api/meta/reload' && o && o.method === 'POST')).toBe(true));
    expect(await screen.findByText('1,600')).toBeInTheDocument();
    expect(screen.getByText('gumroad_manifest_2.json: Unexpected token').closest('[role="alert"]')).toHaveClass('attr-meta-errors');
  });

  test('older backend: no Attribution section; cross-library duplicate pairs are labelled as backups', async () => {
    mockFetch([
      ['/api/organize/health', health],
      ['/api/attribution/summary', { __status: 404 }],
    ], []);
    await openHealth();
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/api/attribution/summary'))).toBe(true));
    expect(screen.queryByRole('tab', { name: /Attribution/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Similar Names/ }));
    expect(await screen.findByText('BACKUP')).toBeInTheDocument();
    expect(screen.getByText(/Same files in Dagobah and Endor: this is a backup copy/)).toBeInTheDocument();
    expect(screen.getByText(/^Dagobah · Wicked/)).toBeInTheDocument();
  });

  test('duplicate files inside one library are listed; cross-library copies are counted as backups', async () => {
    mockFetch([
      ['/api/organize/health', { ...health,
        summary: { ...health.summary, fileDuplicates: 1, backupCopies: 1234, conflictFolders: 1 },
        fileDuplicates: [{ library: 'Dagobah', filename: 'Wicked - Ken Bust (Non Supported).zip', filesize: 2 * 1024 ** 3,
          copies: [{ filepath: '/library/STL Archive/Wicked/Ken/a.zip', model_id: 1, model_name: 'Ken' }, { filepath: '/library/STL Archive/_Unsorted/a.zip', model_id: 9, model_name: 'Ken (old)' }] }],
        conflictFolders: [{ id: 5, name: 'Groot_Conflict', creator_name: 'B3DSERK', folder_path: '/library/STL Archive/B3DSERK/Groot_Conflict' }],
      }],
      ['/api/attribution/summary', { __status: 404 }],
    ], []);
    await openHealth();
    fireEvent.click(screen.getByRole('tab', { name: /Duplicate Files/ }));
    expect(await screen.findByText('Wicked - Ken Bust (Non Supported).zip')).toBeInTheDocument();
    expect(screen.getByText('2 copies · 2.00 GB')).toBeInTheDocument();
    expect(screen.getByText(/1,234 files are stored in more than one library/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Conflict Copies/ }));
    expect(await screen.findByText('Groot_Conflict')).toBeInTheDocument();
  });
});
