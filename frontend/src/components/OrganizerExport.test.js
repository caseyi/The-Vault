import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import OrganizerExport, { curlExample } from './OrganizerExport';
import { NoticeProvider } from './Notices';
import { mockFetch } from '../testing/metaMock';
import { exportList } from '../testing/enrichMock';

describe('Organizer export', () => {
  test('lists the export files with rows and download links, plus a copyable curl command', async () => {
    mockFetch([['/api/organizer/export', exportList]]);
    Object.assign(navigator, { clipboard: { writeText: jest.fn(() => Promise.resolve()) } });
    render(<NoticeProvider><OrganizerExport /></NoticeProvider>);
    expect(await screen.findByText('genre_map.csv', { selector: '.org-export-name' })).toBeInTheDocument();
    const row = screen.getByText('filing_rules.csv', { selector: '.org-export-name' }).closest('li');
    expect(within(row).getByText('341 rows')).toBeInTheDocument();
    const dl = within(row).getByRole('link', { name: /Download filing_rules.csv/ });
    expect(dl).toHaveAttribute('href', '/api/organizer/export/filing_rules.csv');
    expect(dl).toHaveAttribute('download', 'filing_rules.csv');
    expect(screen.getAllByRole('link')).toHaveLength(4);
    // jsdom runs on localhost, so the example uses the NAS placeholder
    expect(screen.getByLabelText('curl command')).toHaveTextContent('curl -o genre_map.csv http://<nas>:8484/api/organizer/export/genre_map.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('curl -o genre_map.csv http://<nas>:8484/api/organizer/export/genre_map.csv');
    expect(await screen.findByText('Copied the curl command')).toBeInTheDocument();
  });

  test('curl example uses the real origin when served from the NAS', () => {
    expect(curlExample(exportList.files[3], 'http://192.168.1.140:8484')).toBe('curl -o moves.csv http://192.168.1.140:8484/api/organizer/export/moves.csv');
  });
});
