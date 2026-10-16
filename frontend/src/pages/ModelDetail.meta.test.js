import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ModelDetail from './ModelDetail';
import { NoticeProvider } from '../components/Notices';
import { mockFetch, workDetail } from '../testing/metaMock';

jest.mock('../components/StlViewer', () => () => <div />);
jest.mock('../components/ClaudeAssistant', () => () => <div />);

const renderDetail = (model) => {
  mockFetch([[/\/api\/models\/\d+$/, model], ['/api/queue', []], ['/status-log', []], ['/tag-suggestions', []], ['/collections', []]], {});
  return render(<NoticeProvider><ModelDetail modelId={model.id} onBack={() => {}} collections={[]} /></NoticeProvider>);
};

describe('ModelDetail with library metadata', () => {
  test('shows the Attribution panel and files grouped by edition with libraries', async () => {
    renderDetail(workDetail);
    const panel = await screen.findByRole('region', { name: 'Attribution' });
    expect(panel).toHaveTextContent('Matched 11 of 14 files');
    expect(screen.getByRole('region', { name: 'Sculpture' })).toBeInTheDocument();
    const nonSup = within(screen.getByRole('region', { name: 'Bust' })).getByRole('group', { name: 'Non Supported' });
    expect(within(nonSup).getByText('Endor')).toBeInTheDocument();
    // Creator/Franchise move from Info into the Attribution panel
    expect(screen.queryByText('Franchise')).not.toBeInTheDocument();
  });

  test('older backend: no panel, Info keeps Creator, files list as before', async () => {
    renderDetail({ id: 7, name: 'Old', creator_name: 'Someone', franchise: 'Star Wars', tags: [], images: [], file_count: 1,
      files: [{ id: 1, filename: 'a.stl', filetype: 'stl', filesize: 10 }] });
    expect(await screen.findByText('a.stl')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Attribution' })).not.toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByText('Star Wars')).toBeInTheDocument();
  });
});
