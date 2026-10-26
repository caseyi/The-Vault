import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, errorMessage } from '../api';
import { useNotify } from './Notices';
import { formatRunDate } from '../enrich';

// Health → Organizer export: the files the stl-library-organizer skill pulls
// (genre map, filing rules, model.json sidecars, proposed moves). The Vault never
// moves files itself; these are proposals for the organizer on the Mac.

const DESCRIPTIONS = {
  'genre_map.csv': 'character → genre, for genres set by AI, review or you',
  'filing_rules.csv': 'typo fixes (aliases), groups and genre rules',
  'model_json.ndjson': 'one model.json per work folder',
  'moves.csv': 'proposed gold-layout paths for off-layout works (never applied by the app)',
  'folder_roles.csv': 'folder roles set in the app, to merge into each library\'s _Meta/folder_roles.csv (the file wins)',
};

export function curlExample(file, origin) {
  const base = origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) ? origin : 'http://<nas>:8484';
  return `curl -o ${file.name} ${base}${file.url}`;
}

export default function OrganizerExport() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    apiGet('/api/organizer/export').then(setData).catch(e => setError(errorMessage(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const files = (data && data.files) || [];
  const example = files.length ? curlExample(files[0], origin) : curlExample({ name: 'genre_map.csv', url: '/api/organizer/export/genre_map.csv' }, origin);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(example);
      notify('Copied the curl command', { type: 'success' });
    } catch { notify('Copy failed; select the command and copy it by hand.'); }
  };

  return (
    <div className="org-export">
      <p className="org-desc" style={{ margin: '0 0 8px' }}>
        Files for the <b>stl-library-organizer</b> skill: it pulls these to rename and file folders on the Mac.
        The Vault itself never moves files.
      </p>
      {error && <div className="org-error">{error}</div>}
      {!data && !error && <div className="org-hint-inline">Loading export…</div>}
      {files.length > 0 && (
        <ul className="org-export-list">
          {files.map(f => (
            <li key={f.name} className="org-health-row org-export-row">
              <span className="org-export-name">{f.name}</span>
              <span className="org-health-extra org-export-desc">{DESCRIPTIONS[f.name] || ''}</span>
              <span className="attr-faint num">{Number(f.rows || 0).toLocaleString()} row{f.rows === 1 ? '' : 's'}</span>
              <a className="attr-link" href={f.url} download={f.name}>⬇ Download<span className="sr-only"> {f.name}</span></a>
            </li>
          ))}
        </ul>
      )}
      <div className="org-export-curl">
        <div className="attr-subtitle" style={{ margin: '10px 0 4px' }}>From the Mac</div>
        <div className="org-export-code">
          <code aria-label="curl command">{example}</code>
          <button className="org-btn org-btn-sm" onClick={copy}>Copy</button>
        </div>
        {data?.generatedAt && <div className="org-hint-inline" style={{ marginTop: 4 }}>Generated {formatRunDate(data.generatedAt)}. Add <code>?since=&lt;cursor&gt;</code> to fetch only rows changed since a previous pull.</div>}
      </div>
    </div>
  );
}
