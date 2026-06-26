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

export default function FolderRoles() {
  const [tree, setTree] = useState(null);
  const [roles, setRoles] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

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

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Fix how the scanner groups folders when auto-detection gets it wrong.
        <b> Creator</b> = stop here (this folder is a creator) · <b>Container</b> = descend past it ·
        <b> Ignore</b> = skip it. Changes take effect on the next <b>Scan Library</b>.
      </p>

      <button className="org-btn org-btn-sm" onClick={load} disabled={loading}>
        {loading ? '⏳ Loading…' : '↻ Refresh folder tree'}
      </button>

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
