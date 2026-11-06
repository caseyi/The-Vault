import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import OrganizeModal from './OrganizeModal';
import { NoticeProvider } from './Notices';
import { mockFetch, attributionSummary, attributionGaps, metaStatus } from '../testing/metaMock';
import { estimate } from '../testing/enrichMock';

const health = {
  summary: { total: 3, crossCreatorDupes: 0, noTags: 0, noThumbnail: 0, noFranchise: 0, emptyFolders: 0, noSource: 0 },
  crossCreatorDupes: [],
  noTags: [], noThumbnail: [], noFranchise: [], emptyFolders: [], noSource: [],
};

const openHealth = async () => {
  render(<NoticeProvider><OrganizeModal onClose={() => {}} /></NoticeProvider>);
  fireEvent.click(screen.getByRole('tab', { name: /Health/ }));
  await screen.findByRole('tablist', { name: 'Health checks' });
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

  test('older backend: no Attribution section; Similar Names is gone; Missing Info runs Enrich on just those cards', async () => {
    mockFetch([
      ['/api/organize/health', { ...health,
        summary: { ...health.summary, noFranchise: 2, noTags: 1 },
        noFranchise: [{ id: 11, name: 'Krampus', creator_name: 'Wicked' }, { id: 12, name: 'Medusa', creator_name: 'CA 3D' }],
        noTags: [{ id: 13, name: 'Goblin', creator_name: 'Loot' }] }],
      ['/api/attribution/summary', { __status: 404 }],
      ['/api/ai/enrich/estimate', (u) => { expect(new URLSearchParams(u.split('?')[1]).get('ids')).toBe('11,12'); return estimate; }],
    ], []);
    await openHealth();
    await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/api/attribution/summary'))).toBe(true));
    expect(screen.queryByRole('tab', { name: /Attribution/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Similar Names/ })).not.toBeInTheDocument();
    const missing = screen.getByRole('tab', { name: /Missing Info/ });
    expect(within(missing).getByText('3')).toBeInTheDocument(); // genre 2 + tags 1 (source URL not counted)
    fireEvent.click(missing);
    expect(screen.getByText('Krampus')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Tags/ }));
    expect(await screen.findByText('Goblin')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Genre/ }));
    fireEvent.click(screen.getByRole('button', { name: '✦ Enrich these 2' }));
    expect(await screen.findByText(/Enrich metadata/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Picture/ }));
    expect(screen.queryByText(/Enrich metadata/)).not.toBeInTheDocument();
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

  test('X-Creator Dupes merge the copies into the kept card (an accepted merge, undone with Unmerge)', async () => {
    const posts = [];
    mockFetch([
      ['/api/organize/health', { ...health,
        summary: { ...health.summary, crossCreatorDupes: 1 },
        crossCreatorDupes: [{ key: 'medusa', models: [
          { id: 21, name: 'Medusa', creator_name: 'Alpha', file_count: 1 },
          { id: 22, name: 'Medusa', creator_name: 'Beta', file_count: 3, thumbnail_path: '/images/m.jpg' },
        ] }] }],
      ['/api/attribution/summary', { __status: 404 }],
      ['/api/organize/dedupe/resolve', (u, o) => { posts.push(JSON.parse(o.body)); return { success: true, kept: 22, merged: 1, errors: [], suggestionIds: [77] }; }],
    ], []);
    await openHealth();
    fireEvent.click(await screen.findByRole('button', { name: '✓ Keep selected · merge 1 other into it' }));
    const dlg = await screen.findByRole('dialog', { name: 'Merge 1 card into "Medusa"?' });
    expect(dlg).toHaveTextContent('undo with Unmerge under Review → History');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Merge 1' }));
    await waitFor(() => expect(posts).toEqual([{ keepId: 22, dropIds: [21] }]));
    expect(await screen.findByText('Merged 1 card into "Medusa". Unmerge is under Review → History.')).toBeInTheDocument();
    expect(await screen.findByText(/No cross-creator duplicates to resolve/)).toBeInTheDocument();
  });

  test('four tabs: Review (default), Health, Folders, Tools; an old tab name falls back to Review', async () => {
    mockFetch([['/api/organize/health', health], ['/api/attribution/summary', { __status: 404 }]], []);
    render(<NoticeProvider><OrganizeModal onClose={() => {}} initialTab="annotate" /></NoticeProvider>);
    const tabs = within(screen.getByRole('tablist', { name: 'Organize sections' })).getAllByRole('tab');
    expect(tabs.map(t => t.textContent.replace(/\d+$/, '').trim())).toEqual(['✓ Review', '⚕ Health', '🗃 Folders', '⚙ Tools']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tabs[2]);
    expect(within(screen.getByRole('tablist', { name: 'Folder tools' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['🗃 Folder Roles', '📦 Unpack Loose Files']);
    expect(screen.queryByRole('button', { name: /Suggest roles/ })).not.toBeInTheDocument();
    fireEvent.click(tabs[3]);
    expect(within(screen.getByRole('tablist', { name: 'Tools' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['🔍 Gap Analysis', '🔀 Merge Creators', '⇪ Organizer Export']);
  });
});
