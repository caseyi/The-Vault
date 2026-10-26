import React, { useState, useCallback, useEffect } from 'react';
import { useNotify } from './Notices';
import { errorMessage } from '../api';
import {
  ROLE_OPTIONS, ROLE_HELP, roleLabel, roleValue, splitTags, saveFolderRole, startRescan, savedMessage,
} from '../folderRoles';

// Shared pieces for folder roles: a labelled role <select> with the category
// genre / group / tags form, the read-only "from _Meta" badge for marks that
// come from the library's _Meta/folder_roles.csv, and the "Rescan now" action.

/** Start a scan and report it. Returns { rescan, busy }. */
export function useRescan() {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const rescan = useCallback(async () => {
    setBusy(true);
    try {
      const r = await startRescan();
      notify(r === 'running'
        ? 'A scan is already running. Your changes apply on the next scan.'
        : 'Scan started. Progress shows in the sidebar.', { type: r === 'running' ? 'info' : 'success' });
    } catch (e) {
      notify(`Couldn't start a scan: ${errorMessage(e)}`);
    }
    setBusy(false);
  }, [notify]);
  return { rescan, busy };
}

/** notify() with a "Rescan now" action, for after any role change. */
export function useNotifyRescan() {
  const notify = useNotify();
  const { rescan } = useRescan();
  return useCallback((message, type = 'success') => {
    notify(message, { type, duration: 10000, action: { label: 'Rescan now', onClick: rescan } });
  }, [notify, rescan]);
}

export function RescanButton({ className = 'org-btn org-btn-sm org-btn-blue' }) {
  const { rescan, busy } = useRescan();
  return (
    <button type="button" className={className} onClick={rescan} disabled={busy}>
      {busy ? 'Starting…' : '↻ Rescan now'}
    </button>
  );
}

const conflictRole = (c) => (c && typeof c === 'object' ? (c.role !== undefined ? c.role : c.app) : c);

/** Small chips for a category's genre / group / tags. */
export function CategoryValues({ genre, group, tags }) {
  const t = splitTags(tags);
  if (!genre && !group && !t.length) return null;
  return (
    <span className="role-values">
      {genre && <span className="role-value" title="Genre">genre: {genre}</span>}
      {group && <span className="role-value" title="Group">group: {group}</span>}
      {t.length > 0 && <span className="role-value" title="Tags">tags: {t.join(', ')}</span>}
    </span>
  );
}

function CategoryForm({ name, initial, onSave, onCancel, busy }) {
  const [vals, setVals] = useState(() => ({
    genre: initial.genre || '', group: initial.group || '', tags: splitTags(initial.tags).join(', '),
  }));
  const set = k => e => setVals(v => ({ ...v, [k]: e.target.value }));
  const submit = (e) => { e.preventDefault(); onSave(vals); };
  return (
    <form className="role-cat-form" onSubmit={submit} aria-label={`Category values for ${name}`}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <label><span>Genre</span><input className="url-input" value={vals.genre} onChange={set('genre')} placeholder="Marvel, Movies…" disabled={busy} /></label>
      <label><span>Group</span><input className="url-input" value={vals.group} onChange={set('group')} placeholder="X-Men, Heroes…" disabled={busy} /></label>
      <label><span>Tags</span><input className="url-input" value={vals.tags} onChange={set('tags')} placeholder="terrain, scenery" disabled={busy} /></label>
      <div className="role-cat-actions">
        <button type="button" className="org-btn org-btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="org-btn org-btn-sm org-btn-success" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div className="attr-faint role-cat-hint">Leave all empty to use the folder name (a known genre becomes the genre, anything else the group). Tags: comma or | separated.</div>
    </form>
  );
}

/**
 * Role menu for one folder. `mark` = { role, source, conflict, genre, group, tags }.
 * Calls onSaved(path, newMark, response) after a successful save.
 */
export default function RoleMenu({ path, name, mark, onSaved, className = '' }) {
  const notifyRescan = useNotifyRescan();
  const notify = useNotify();
  const [cur, setCur] = useState(() => ({ ...(mark || {}) }));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = name || path;

  // follow the parent's mark when it really changes (not on every new object)
  const markKey = JSON.stringify(mark || {});
  useEffect(() => { setCur(JSON.parse(markKey)); }, [markKey]);

  const save = async (next) => {
    setBusy(true);
    try {
      const res = await saveFolderRole({ path, ...next });
      const saved = {
        ...cur, role: next.role || null, source: next.role ? 'app' : null,
        genre: next.role === 'category' ? (next.genre || null) : null,
        group: next.role === 'category' ? (next.group || null) : null,
        tags: next.role === 'category' ? splitTags(next.tags) : [],
      };
      // a file mark still wins: keep showing it, with the app value as the conflict
      const shown = cur.source === 'file' ? { ...cur, conflict: { role: next.role || null } } : saved;
      setCur(shown);
      notifyRescan(savedMessage(label, next.role, res), res && res.fileOverrides ? 'info' : 'success');
      if (onSaved) onSaved(path, shown, res);
      setBusy(false);
      return true;
    } catch (e) {
      notify(`Couldn't save the role for ${label}: ${errorMessage(e)}`);
      setBusy(false);
      return false;
    }
  };

  const onSelect = async (e) => {
    const role = e.target.value;
    if (role === 'category') {
      // one click: save with folder-name defaults, then offer the values form
      const ok = await save({ role: 'category', genre: cur.role === 'category' ? cur.genre : '', group: cur.role === 'category' ? cur.group : '', tags: cur.role === 'category' ? cur.tags : [] });
      if (ok) setEditing(true);
      return;
    }
    setEditing(false);
    save({ role });
  };

  const fromFile = cur.source === 'file';
  const value = roleValue(cur.role);
  const appConflict = fromFile && cur.conflict ? conflictRole(cur.conflict) : undefined;

  return (
    <div className={`role-menu ${className}`}>
      <div className="role-menu-line">
        {fromFile ? (
          <>
            <span className={`role-chip role-${value || 'auto'}`}>{roleLabel(value)}</span>
            <span className="role-file-badge" title="Set in _Meta/folder_roles.csv in the library. Edit that file to change it.">from _Meta</span>
            {appConflict !== undefined && (
              <span className="role-conflict" title="The app has a different mark; the file wins">app: {roleLabel(appConflict)}</span>
            )}
          </>
        ) : (
          <select className={`role-select ${value ? 'set' : ''}`} value={value} onChange={onSelect} disabled={busy}
            aria-label={`Role for ${label}`} title={ROLE_HELP[value]}>
            {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        )}
        {value === 'category' && <CategoryValues genre={cur.genre} group={cur.group} tags={cur.tags} />}
        {value === 'category' && !fromFile && !editing && (
          <button type="button" className="role-edit-btn" onClick={() => setEditing(true)}
            aria-label={`Edit category values for ${label}`} title="Edit genre, group and tags">✎</button>
        )}
      </div>
      {editing && !fromFile && (
        <CategoryForm name={label} initial={cur} busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (v) => { if (await save({ role: 'category', ...v })) setEditing(false); }} />
      )}
    </div>
  );
}
