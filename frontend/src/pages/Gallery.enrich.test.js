import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Gallery from './Gallery';
import Sidebar from '../components/Sidebar';
import OrganizeModal from '../components/OrganizeModal';
import { NoticeProvider } from '../components/Notices';
import { EMPTY_FILTERS } from '../filters';
import { mockFetch } from '../testing/metaMock';
import { estimate, summary, exportList } from '../testing/enrichMock';

const models = [
  { id: 3751, name: 'Daredevil (2026)', creator_name: 'Wicked', release_label: 'GOOGLE DRIVE WICKED MARCH TERM 2026', release_term: '2026-03', print_status: 'unprinted', images: [], hidden: 0 },
  { id: 3752, name: 'Daredevil (Netflix)', creator_name: 'Wicked', release_label: 'Netflix', print_status: 'unprinted', images: [], hidden: 0 },
];
const card = (name) => screen.getByRole('button', { name: `Open ${name}` }).closest('.model-card');

beforeEach(() => {
  try { localStorage.setItem('claude_api_key', 'sk-ant-test'); } catch {}
  mockFetch([
    ['/api/models?', { models, total: 2, pages: 1, page: 1 }],
    ['/api/ai/enrich/estimate', estimate],
    ['/api/ai/models', { models: [], default: '' }],
    ['/api/creators', []],
    ['/api/suggestions/summary', summary],
    ['/api/organizer/export', exportList],
    ['/api/organize/health', { summary: { total: 2, crossCreatorDupes: 0, duplicatePairs: 0, noTags: 0, noThumbnail: 0, noFranchise: 0 }, crossCreatorDupes: [], duplicates: [], noTags: [], noThumbnail: [], noFranchise: [], emptyFolders: [], noSource: [] }],
    ['/api/attribution/summary', { __status: 404 }],
  ], []);
});

test('cards show a meaningful release label subtly, not the Drive term label', async () => {
  render(<NoticeProvider><Gallery filters={{ ...EMPTY_FILTERS }} onFilterChange={() => {}} onModelClick={() => {}} /></NoticeProvider>);
  await screen.findByText('Daredevil (Netflix)', { selector: '.model-card-name' });
  expect(within(card('Daredevil (Netflix)')).getByText('Netflix')).toHaveClass('model-card-release');
  expect(card('Daredevil (2026)').querySelector('.model-card-release')).toBeNull();
});

test('bulk select → "Enrich selected" opens the Enrich panel scoped to the selection', async () => {
  render(<NoticeProvider><Gallery filters={{ ...EMPTY_FILTERS }} onFilterChange={() => {}} onModelClick={() => {}} /></NoticeProvider>);
  await screen.findByText('Daredevil (Netflix)', { selector: '.model-card-name' });
  fireEvent.click(screen.getByRole('button', { name: '⊡ Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Daredevil (2026)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Daredevil (Netflix)' }));
  fireEvent.click(screen.getByRole('button', { name: '$ ✦ Enrich selected' }));
  const dlg = await screen.findByRole('dialog', { name: 'Enrich selected cards' });
  expect(await within(dlg).findByRole('button', { name: 'Selection (2)' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/api/ai/enrich/estimate') && String(u).includes('ids=3751%2C3752'))).toBe(true));
});

test('sidebar links to Review when suggestions are pending', () => {
  const onReviewClick = jest.fn();
  const base = { open: true, onToggle() {}, stats: { total: 1, byStatus: [] }, creators: [], tags: [], filters: { ...EMPTY_FILTERS }, onFilterChange() {}, onScanClick() {}, onHomeClick() {} };
  const { rerender } = render(<Sidebar {...base} pendingSuggestions={0} onReviewClick={onReviewClick} />);
  expect(screen.queryByRole('button', { name: /Review suggestions/ })).not.toBeInTheDocument();
  rerender(<Sidebar {...base} pendingSuggestions={120} onReviewClick={onReviewClick} />);
  fireEvent.click(screen.getByRole('button', { name: /Review suggestions/ }));
  expect(onReviewClick).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Review suggestions/ })).toHaveTextContent('120');
});

test('Organize: Review tab (lazy) carries the pending badge; Health has the organizer export', async () => {
  const onSuggestionsChange = jest.fn();
  render(<NoticeProvider><OrganizeModal onClose={() => {}} initialTab="review" onSuggestionsChange={onSuggestionsChange} /></NoticeProvider>);
  const tab = screen.getByRole('tab', { name: /Review/ });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(await within(tab).findByLabelText('120 pending')).toBeInTheDocument();
  expect(await screen.findByRole('tablist', { name: 'Suggestion groups' })).toBeInTheDocument();
  expect(onSuggestionsChange).toHaveBeenCalledWith(summary);
  fireEvent.click(screen.getByRole('tab', { name: /Health/ }));
  fireEvent.click(await screen.findByRole('tab', { name: /Organizer Export/ }));
  expect(await screen.findByText('moves.csv', { selector: '.org-export-name' })).toBeInTheDocument();
});
