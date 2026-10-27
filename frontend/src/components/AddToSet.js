import React, { useState, useEffect, useRef } from 'react';
import { apiGet, apiSend, errorMessage } from '../api';
import { useNotify } from './Notices';
import { useUniqueId } from './Modal';
import { setChipLabel } from '../relations';

// "Add to set": add cards to an existing theme (searching GET /api/sets?kind=theme)
// or to a new one (POST /api/sets). Used on the detail page and in the gallery's
// bulk bar. docs/relations.md sections 5 and 7.4.

export default function AddToSet({ ids, creator, onDone, buttonClass = 'chip-btn', buttonLabel = 'Add to set' }) {
  const notify = useNotify();
  const panelId = useUniqueId('add-to-set');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [themes, setThemes] = useState(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);
  const count = Array.isArray(ids) ? ids.length : 0;

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ kind: 'theme', limit: '20', ...(q.trim() && { search: q.trim() }), ...(creator && { creator }) });
      apiGet(`/api/sets?${qs}`)
        .then(d => { if (alive) setThemes(Array.isArray(d && d.items) ? d.items : []); })
        .catch(() => { if (alive) setThemes([]); });
    }, q ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [open, q, creator]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const node = wrapRef.current;
    if (node) node.addEventListener('keydown', onKey);
    return () => { if (node) node.removeEventListener('keydown', onKey); };
  }, [open]);

  const finish = (msg) => {
    notify(msg, { type: 'success' });
    setOpen(false); setQ(''); setNewName('');
    if (onDone) onDone();
  };

  const addTo = async (set) => {
    setBusy(true);
    try {
      await apiSend(`/api/sets/${set.id}/members`, 'POST', { ids });
      finish(`Added ${count} card${count !== 1 ? 's' : ''} to ${setChipLabel(set)}`);
    } catch (e) { notify(`Couldn't add to the set: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await apiSend('/api/sets', 'POST', { name, ...(creator && { creator }), ids });
      finish(`Created theme ${name} with ${count} card${count !== 1 ? 's' : ''}`);
    } catch (e) { notify(`Couldn't create the theme: ${errorMessage(e)}`); }
    setBusy(false);
  };

  return (
    <div className="bulk-menu-wrap add-to-set" ref={wrapRef}>
      <button type="button" className={buttonClass} aria-expanded={open} aria-controls={open ? panelId : undefined}
        disabled={!count} onClick={() => setOpen(o => !o)}>
        {buttonLabel} ▾
      </button>
      {open && (
        <div className="bulk-menu add-to-set-menu" id={panelId} role="group" aria-label="Add to set">
          <label className="bulk-menu-label" htmlFor={`${panelId}-q`}>ADD TO A THEME</label>
          <input id={`${panelId}-q`} type="search" className="bulk-input" value={q} autoFocus
            onChange={e => setQ(e.target.value)} placeholder="Search themes" />
          <div className="add-to-set-list">
            {themes === null && <div className="attr-faint">Loading…</div>}
            {themes && themes.length === 0 && <div className="attr-faint">No themes yet</div>}
            {themes && themes.map(t => (
              <button key={t.id} type="button" className="bulk-menu-item" disabled={busy} onClick={() => addTo(t)}>
                {t.name}{t.creator ? <span className="attr-faint"> · {t.creator}</span> : null}
              </button>
            ))}
          </div>
          <label className="bulk-menu-label" htmlFor={`${panelId}-new`}>NEW THEME</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input id={`${panelId}-new`} className="bulk-input" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create(); }} placeholder="Theme name" />
            <button type="button" className="bulk-add-btn" disabled={busy || !newName.trim()} onClick={create}>Create</button>
          </div>
        </div>
      )}
    </div>
  );
}
