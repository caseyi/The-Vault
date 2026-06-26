import React, { useState, useEffect, useCallback } from 'react';

// Override how the scanner treats a folder when auto-detection gets it wrong.
const ROLES = [
  { v: '', label: 'Auto' },
  { v: 'creator', label: 'Creator' },
  { v: 'passthrough', label: 'Container' },
  { v: 'ignore', label: 'Ignore' },
];

function TreeNode({ node, depth, roles, onSetRole }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children && node.children.length > 0;
  const role = (node.path in roles) ? roles[node.path] : (node.role || '');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', paddingLeft: 6 + depth * 14 }}>
        <button onClick={() => hasChildren && setOpen(o => !o)}
          style={{ visibility: hasChildren ? 'visible' : 'hidden', background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10, width: 12, padding: 0 }}>
          {open ? '▾' : '▸'}
        </button>
        <span title={node.path}
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: role === 'ignore' ? 'var(--text-faint)' : 'var(--text)' }}>
          {node.name}
          <span style={{ color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)', marginLeft: 6 }}>{node.dirCount}d/{node.fileCount}f</span>
        </span>
        <select value={role} onChange={e => onSetRole(node.path, e.target.value)}
          style={{
            background: role ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
            border: `1px solid ${role ? 'var(--accent)' : 'var(--border)'}`,
            color: role ? 'var(--accent)' : 'var(--text-muted)',
            borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)', padding: '2px 4px', cursor: 'pointer',
          }}>
          {ROLES.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
      </div>
      {open && hasChildren && node.children.map(c => (
        <TreeNode key={c.path} node={c} depth={depth + 1} roles={roles} onSetRole={onSetRole} />
      ))}
      {open && node.truncated && (
        <div style={{ paddingLeft: 6 + (depth + 1) * 14, fontSize: 10, color: 'var(--text-faint)', padding: '2px 0' }}>… deeper folders not shown</div>
      )}
    </div>
  );
}

function getApiKey() {
  try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; }
}

export default function FolderRoles() {
  const [tree, setTree] = useState(null);
  const [roles, setRoles] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const apiKey = getApiKey();

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/organize/fs-tree?depth=3');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
      setTree(d);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onSetRole = async (path, role) => {
    setRoles(prev => ({ ...prev, [path]: role }));
    try {
      await fetch('/api/organize/folder-overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, role }),
      });
      setMsg('Saved — re-scan to apply.');
    } catch (e) { setError(e.message); }
  };

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
    for (const s of suggestions) {
      next[s.path] = s.role;
      try {
        await fetch('/api/organize/folder-overrides', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: s.path, role: s.role }),
        });
      } catch {}
    }
    setRoles(prev => ({ ...prev, ...next }));
    setSuggestions(null);
    setMsg(`Applied ${Object.keys(next).length} AI suggestion(s) — re-scan to take effect.`);
  };

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Fix how the scanner groups folders when auto-detection gets it wrong.
        <b> Creator</b> = stop here (this folder is a creator) · <b>Container</b> = descend past it ·
        <b> Ignore</b> = skip it. Changes take effect on the next <b>Scan Library</b>.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="org-btn org-btn-sm" onClick={load} disabled={loading}>
          {loading ? '⏳ Loading…' : '↻ Refresh folder tree'}
        </button>
        <button className="org-btn org-btn-sm" onClick={suggestWithAI}
          disabled={suggesting || !apiKey || !tree}
          style={{ color: apiKey ? '#9b72cf' : 'var(--text-faint)', borderColor: apiKey ? 'rgba(155,114,207,0.4)' : 'var(--border)', opacity: apiKey ? 1 : 0.6 }}
          title={apiKey ? 'Uses Claude API credits — suggest folder roles from the structure' : 'Add a Claude API key (in the Scan dialog) to enable'}>
          {suggesting ? '⏳ Thinking…' : '✦ $ Suggest roles (AI)'}
        </button>
      </div>

      {suggestions && (
        <div style={{ marginTop: 10, border: '1px solid rgba(155,114,207,0.4)', borderRadius: 6, padding: 10, background: 'rgba(155,114,207,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#9b72cf' }}>{suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''}</span>
            {suggestions.length > 0 && (
              <button className="org-btn org-btn-sm" style={{ marginLeft: 'auto', color: 'var(--green)', borderColor: 'rgba(76,175,125,0.4)' }} onClick={applySuggestions}>
                ✓ Apply all
              </button>
            )}
            <button className="org-btn org-btn-sm" onClick={() => setSuggestions(null)}>Dismiss</button>
          </div>
          {suggestions.length === 0
            ? <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>No confident suggestions — the structure looks fine, or set roles manually below.</div>
            : suggestions.map((s, i) => (
              <div key={i} style={{ fontSize: 11, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ color: '#9b72cf', fontFamily: 'var(--font-mono)', marginRight: 6 }}>{s.role}</span>
                <span style={{ color: 'var(--text)' }}>{s.path.split('/').filter(Boolean).slice(-1)[0]}</span>
                {s.reason && <span style={{ color: 'var(--text-faint)' }}> — {s.reason}</span>}
              </div>
            ))}
        </div>
      )}

      {error && <div className="org-error" style={{ marginTop: 8 }}>{error}</div>}
      {msg && <div style={{ fontSize: 11, color: 'var(--green)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>{msg}</div>}

      {tree && (
        <div style={{ marginTop: 8, maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 4px' }}>
          <TreeNode node={tree} depth={0} roles={roles} onSetRole={onSetRole} />
        </div>
      )}
    </div>
  );
}
