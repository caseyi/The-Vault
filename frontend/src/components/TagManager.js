import React, { useState, useEffect, useCallback } from 'react';
import Modal, { useUniqueId } from './Modal';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './Notices';
import { apiSend, errorMessage } from '../api';

// Library-wide tag cleanup: rename, merge, delete tags across every model.
export default function TagManager({ onClose, onChange }) {
  const titleId = useUniqueId('tagmgr-title');
  const [confirmUi, askConfirm] = useConfirm();
  const notify = useNotify();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState([]); // tag names selected for merge
  const [mergeTarget, setMergeTarget] = useState('');
  const [editing, setEditing] = useState(null); // tag being renamed
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch('/api/tags'); setTags(await r.json()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => { await load(); if (onChange) onChange(); };

  const doRename = async (from) => {
    const to = editValue.trim().toLowerCase();
    setEditing(null);
    if (!to || to === from) return;
    setBusy(true);
    try {
      const r = await apiSend('/api/tags/rename', 'POST', { from, to });
      setMsg(`Renamed "${from}" → "${to}" on ${r.changed} model(s)`);
    } catch (e) { notify(`Rename failed: ${errorMessage(e)}`); }
    setBusy(false);
    await refresh();
  };

  const doDelete = async (tag) => {
    const count = (tags.find(t => t.tag === tag) || {}).count;
    const ok = await askConfirm({
      title: `Delete tag "${tag}"?`,
      message: <p>Remove the tag <b>{tag}</b> from {count != null ? `${count} model${count !== 1 ? 's' : ''}` : 'all models'}. The models themselves are not changed otherwise.</p>,
      confirmLabel: 'Delete tag',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await apiSend('/api/tags/delete', 'POST', { tag });
      setMsg(`Deleted "${tag}" from ${r.changed} model(s)`);
      setSelected(s => s.filter(t => t !== tag));
    } catch (e) { notify(`Delete failed: ${errorMessage(e)}`); }
    setBusy(false);
    await refresh();
  };

  const doMerge = async () => {
    const target = mergeTarget.trim().toLowerCase();
    if (!target || selected.length === 0) return;
    setBusy(true);
    try {
      const r = await apiSend('/api/tags/merge', 'POST', { sources: selected, target });
      setMsg(`Merged ${selected.length} tag(s) into "${target}" on ${r.changed} model(s)`);
      setSelected([]); setMergeTarget('');
    } catch (e) { notify(`Merge failed: ${errorMessage(e)}`); }
    setBusy(false);
    await refresh();
  };

  const toggleSelect = (tag) => setSelected(s => s.includes(tag) ? s.filter(t => t !== tag) : [...s, tag]);

  const shown = tags.filter(t => t.tag.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal onClose={onClose} labelledBy={titleId} closeOnEscape={!confirmUi}
      className="modal" style={{ width: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        {confirmUi}
        <div className="modal-title" id={titleId}>TAG MANAGER</div>
        <div className="modal-subtitle">Rename, merge, or delete tags across your whole library</div>

        <input className="modal-input" placeholder="Filter tags…" aria-label="Filter tags" value={filter}
          onChange={e => setFilter(e.target.value)} style={{ marginBottom: 8 }} />

        {/* Merge bar (shown when tags are selected) */}
        {selected.length > 0 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, padding: '8px 10px', background: 'rgba(193,127,58,0.1)', border: '1px solid rgba(193,127,58,0.3)', borderRadius: 6 }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{selected.length} selected →</span>
            <input value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}
              placeholder="merge into tag name" aria-label="Merge selected tags into" onKeyDown={e => { if (e.key === 'Enter') doMerge(); }}
              style={{ flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none' }} />
            <button onClick={doMerge} disabled={busy || !mergeTarget.trim()}
              style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#0d0d0f', padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-display)' }}>MERGE</button>
            <button onClick={() => setSelected([])} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-faint)', padding: '5px 8px', cursor: 'pointer', fontSize: 11 }}>Clear</button>
          </div>
        )}

        {msg && <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--green)', marginBottom: 6 }}>{msg}</div>}

        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-faint)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading…</div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-faint)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>No tags.</div>
          ) : shown.map(t => (
            <div key={t.tag} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" checked={selected.includes(t.tag)} onChange={() => toggleSelect(t.tag)}
                aria-label={`Select tag ${t.tag} for merging`}
                style={{ accentColor: 'var(--accent)' }} />
              {editing === t.tag ? (
                <input value={editValue} autoFocus aria-label={`New name for tag ${t.tag}`} onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doRename(t.tag); if (e.key === 'Escape') setEditing(null); }}
                  onBlur={() => doRename(t.tag)}
                  style={{ flex: 1, background: 'var(--bg3)', border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text)', padding: '3px 7px', fontSize: 12, outline: 'none' }} />
              ) : (
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-body)' }}>{t.tag}</span>
              )}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{t.count}</span>
              <button onClick={() => { setEditing(t.tag); setEditValue(t.tag); }} disabled={busy}
                title="Rename" aria-label={`Rename tag ${t.tag}`} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', padding: '2px 7px', cursor: 'pointer', fontSize: 11 }}>✎</button>
              <button onClick={() => doDelete(t.tag)} disabled={busy}
                title="Delete from all models" aria-label={`Delete tag ${t.tag} from all models`} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--red)', padding: '2px 7px', cursor: 'pointer', fontSize: 11 }}>✕</button>
            </div>
          ))}
        </div>

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="btn-cancel" onClick={onClose}>Close</button>
        </div>
    </Modal>
  );
}
