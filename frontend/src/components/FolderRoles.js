import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, errorMessage } from '../api';
import RoleMenu, { RescanButton, useNotifyRescan } from './RoleMenu';
import { getFolderRoles, saveFolderRole, roleLabel, baseName } from '../folderRoles';

// Organize → Advanced → Folder Roles: tell the scanner what a folder is when its
// guess is wrong (docs/folder-roles.md §7). Marks from the library's
// _Meta/folder_roles.csv are read-only here; the file wins over app marks.

const markOf = (n) => ({
  role: n.role || null, source: n.source || (n.role ? 'app' : null), conflict: n.conflict || undefined,
  genre: n.genre || null, group: n.group || null, tags: n.tags || [],
});

function TreeNode({ node, depth, marks, onSaved }) {
  const [open, setOpen] = useState(depth < 1);
  const [kids, setKids] = useState(null); // lazily loaded children for truncated nodes
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const given = Array.isArray(node.children) ? node.children : [];
  const children = given.length ? given : (kids || []);
  const expandable = given.length > 0 || (node.truncated && (kids === null || kids.length > 0));
  const mark = marks[node.path] || markOf(node);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && node.truncated && !given.length && kids === null && !loading) {
      setLoading(true); setLoadError('');
      try {
        const d = await apiGet(`/api/organize/fs-tree?path=${encodeURIComponent(node.path)}&depth=2`);
        setKids(Array.isArray(d && d.children) ? d.children : []);
      } catch (e) { setLoadError(errorMessage(e)); }
      setLoading(false);
    }
  };

  return (
    <li className="role-tree-item">
      <div className="role-tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
        <button type="button" className="role-tree-toggle" onClick={toggle}
          style={{ visibility: expandable ? 'visible' : 'hidden' }}
          aria-expanded={expandable ? open : undefined} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
          tabIndex={expandable ? 0 : -1}>
          {open ? '▾' : '▸'}
        </button>
        <span className={`role-tree-name ${mark.role === 'ignore' ? 'ignored' : ''}`} title={node.path}>
          {node.name}
          {(node.dirCount != null || node.fileCount != null) && (
            <span className="role-tree-counts">{node.dirCount ?? 0}d/{node.fileCount ?? 0}f</span>
          )}
        </span>
        <RoleMenu path={node.path} name={node.name} mark={mark} onSaved={onSaved} />
      </div>
      {open && loading && <div className="role-tree-note" style={{ paddingLeft: 26 + depth * 14 }}>Loading folders…</div>}
      {open && loadError && <div className="role-tree-note org-error" style={{ marginLeft: 26 + depth * 14 }}>{loadError}</div>}
      {open && children.length > 0 && (
        <ul className="role-tree-list">
          {children.map(c => <TreeNode key={c.path} node={c} depth={depth + 1} marks={marks} onSaved={onSaved} />)}
        </ul>
      )}
    </li>
  );
}

function getApiKey() {
  try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; }
}

function MetaFiles({ files }) {
  if (!files || !files.length) {
    return <div className="org-hint-inline">No <code>_Meta/folder_roles.csv</code> found in the libraries. The organizer skill writes it.</div>;
  }
  return (
    <ul className="role-meta-files">
      {files.map(f => (
        <li key={f.path}>
          <b>{f.library}</b> <code>{f.path}</code> <span className="attr-faint">{Number(f.rows || 0).toLocaleString()} row{f.rows === 1 ? '' : 's'}</span>
          {Array.isArray(f.errors) && f.errors.length > 0 && (
            <ul className="role-meta-errors" aria-label={`Warnings in ${f.library} folder_roles.csv`}>
              {f.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function FolderRoles() {
  const notifyRescan = useNotifyRescan();
  const [tree, setTree] = useState(null);
  const [marks, setMarks] = useState({}); // path -> mark saved in this session
  const [roleData, setRoleData] = useState(null); // GET /api/folder-roles
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [changes, setChanges] = useState(0);
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const apiKey = getApiKey();

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setTree(await apiGet('/api/organize/fs-tree?depth=3'));
    } catch (e) { setError(errorMessage(e)); }
    getFolderRoles().then(setRoleData).catch(() => setRoleData(null));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSaved = useCallback((path, mark) => {
    setMarks(prev => ({ ...prev, [path]: mark }));
    setChanges(n => n + 1);
  }, []);

  const suggestWithAI = async () => {
    setSuggesting(true); setError(''); setSuggestions(null);
    try {
      const r = await fetch('/api/organize/classify-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { 'x-claude-key': apiKey }) },
        body: JSON.stringify({ path: tree?.path }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setSuggestions(d.suggestions || []);
    } catch (e) { setError(e.message); }
    setSuggesting(false);
  };

  const applySuggestions = async () => {
    if (!suggestions?.length) return;
    const next = {};
    let failed = 0;
    for (const s of suggestions) {
      try {
        await saveFolderRole({ path: s.path, role: s.role });
        next[s.path] = { role: s.role, source: 'app', genre: null, group: null, tags: [] };
      } catch { failed++; }
    }
    setMarks(prev => ({ ...prev, ...next }));
    setChanges(n => n + Object.keys(next).length);
    setSuggestions(null);
    notifyRescan(`Applied ${Object.keys(next).length} AI suggestion${Object.keys(next).length !== 1 ? 's' : ''}${failed ? `, ${failed} failed` : ''}. They apply on the next scan.`, failed ? 'info' : 'success');
  };

  const marked = (roleData && Array.isArray(roleData.roles)) ? roleData.roles : [];

  return (
    <div className="org-tab-body folder-roles">
      <p className="org-desc">
        Tell the scanner what a folder is when its guess is wrong.
        {' '}<b>Creator</b>: the folder is a creator. <b>Container</b>: go inside, drop its name.
        {' '}<b>Category</b>: a grouping folder (Heroes, Terrain); its name becomes the genre, group or tags of the cards below.
        {' '}<b>Model</b>: exactly one card. <b>Ignore</b>: skip it. Marks from the library&apos;s <code>_Meta/folder_roles.csv</code> win
        and are read-only here. Changes apply on the next scan.
      </p>

      <div className="role-toolbar">
        <button type="button" className="org-btn org-btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh folder tree'}
        </button>
        <button type="button" className="org-btn org-btn-sm role-ai-btn" onClick={suggestWithAI}
          disabled={suggesting || !apiKey || !tree}
          title={apiKey ? 'Uses Claude API credits: suggest folder roles from the structure' : 'Add a Claude API key (in the Scan dialog) to enable'}>
          {suggesting ? 'Thinking…' : '✦ $ Suggest roles (AI)'}
        </button>
        <a className="attr-link role-export-link" href="/api/organizer/export/folder_roles.csv" download="folder_roles.csv">
          ⬇ Export app marks<span className="sr-only"> as folder_roles.csv for the organizer</span>
        </a>
      </div>

      {changes > 0 && (
        <div className="role-rescan-bar" role="status">
          <span>{changes} change{changes !== 1 ? 's' : ''} saved. They apply on the next scan.</span>
          <RescanButton />
        </div>
      )}

      {suggestions && (
        <div className="role-ai-box">
          <div className="role-ai-head">
            <span>{suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''}</span>
            {suggestions.length > 0 && (
              <button type="button" className="org-btn org-btn-sm org-btn-success" onClick={applySuggestions}>✓ Apply all</button>
            )}
            <button type="button" className="org-btn org-btn-sm" onClick={() => setSuggestions(null)}>Dismiss</button>
          </div>
          {suggestions.length === 0
            ? <div className="org-hint-inline">No confident suggestions. The structure looks fine, or set roles by hand below.</div>
            : (
              <ul className="role-ai-list">
                {suggestions.map((s, i) => (
                  <li key={i}>
                    <span className="role-chip">{roleLabel(s.role)}</span> {baseName(s.path)}
                    {s.reason && <span className="attr-faint">: {s.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}

      {error && <div className="org-error" style={{ marginTop: 8 }}>{error}</div>}

      {roleData && (
        <details className="role-marked">
          <summary>Marked folders <span className="attr-faint">{marked.length}</span></summary>
          <MetaFiles files={roleData.files} />
          {marked.length === 0 ? <div className="org-hint-inline">No folders are marked yet.</div> : (
            <ul className="role-marked-list">
              {marked.map(m => (
                <li key={m.path} className="role-marked-row">
                  <span className="role-marked-path" title={m.path}>
                    {m.library && <span className="attr-faint">{m.library} · </span>}{m.rel || m.path}
                  </span>
                  <RoleMenu path={m.path} name={m.rel || baseName(m.path)} mark={marks[m.path] || markOf(m)} onSaved={onSaved} />
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {tree && (
        <ul className="role-tree" aria-label="Library folders">
          <TreeNode node={tree} depth={0} marks={marks} onSaved={onSaved} />
        </ul>
      )}
    </div>
  );
}

