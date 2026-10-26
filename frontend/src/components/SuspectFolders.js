import React, { useState } from 'react';
import { errorMessage } from '../api';
import { useNotify } from './Notices';
import RoleMenu, { useNotifyRescan } from './RoleMenu';
import { roleLabel, saveFolderRole, dismissSuspect, savedMessage } from '../folderRoles';
import { pct } from '../enrich';

// Health → Suspect folders: folders the rule-based check thinks are marked
// wrong (a giant mixed card, a category split into cards, many tiny part cards,
// a creator hiding inside another). One click marks the suggested role.

const RULE_LABELS = {
  mixed: 'Mixed card', 'category-name': 'Category name', 'tiny-siblings': 'Tiny part cards', 'creator-name': 'Creator inside',
};

function SuspectRow({ s, onDone, onOpenModel, onToggleDismiss }) {
  const notify = useNotify();
  const notifyRescan = useNotifyRescan();
  const [busy, setBusy] = useState(false);
  const name = s.rel || s.name || s.path;

  const markSuggested = async () => {
    setBusy(true);
    try {
      const res = await saveFolderRole({ path: s.path, role: s.suggestedRole });
      notifyRescan(savedMessage(s.name || name, s.suggestedRole, res), res && res.fileOverrides ? 'info' : 'success');
      onDone(s.path);
    } catch (e) {
      notify(`Couldn't mark ${s.name || name}: ${errorMessage(e)}`);
      setBusy(false);
    }
  };

  return (
    <li className={`org-health-row suspect-row ${s.dismissed ? 'dismissed' : ''}`} aria-label={`Suspect folder ${name}`}>
      <div className="suspect-main">
        <div className="suspect-title">
          <span className="suspect-path" title={s.path}>{name}</span>
          {s.library && <span className="attr-faint">{s.library}</span>}
          {s.rule && <span className="source-chip">{RULE_LABELS[s.rule] || s.rule}</span>}
          {s.confidence != null && <span className="attr-faint num">{pct(s.confidence)}</span>}
        </div>
        <div className="suspect-reason">{s.reason}</div>
        <div className="suspect-meta">
          {(s.files != null || s.folders != null) && (
            <span className="attr-faint num">
              {s.files != null && `${Number(s.files).toLocaleString()} file${s.files !== 1 ? 's' : ''}`}
              {s.files != null && s.folders != null && ' · '}
              {s.folders != null && `${Number(s.folders).toLocaleString()} folder${s.folders !== 1 ? 's' : ''}`}
            </span>
          )}
          {Array.isArray(s.sample) && s.sample.length > 0 && (
            <span className="suspect-sample" title={s.sample.join(', ')}>Sub-folders: {s.sample.join(', ')}</span>
          )}
          {s.cardId != null && (onOpenModel ? (
            <button type="button" className="link-btn attr-link" onClick={() => onOpenModel({ id: s.cardId, name: s.cardName })}>
              Open card<span className="sr-only"> {s.cardName || name}</span>
            </button>
          ) : (
            <span className="attr-faint">Card: {s.cardName || `#${s.cardId}`}</span>
          ))}
        </div>
      </div>
      <div className="suspect-actions">
        {s.suggestedRole && !s.dismissed && (
          <button type="button" className="org-btn org-btn-sm org-btn-accent" disabled={busy} onClick={markSuggested}
            aria-label={`Mark ${name} as ${roleLabel(s.suggestedRole)}`}>
            Mark as {roleLabel(s.suggestedRole)}
          </button>
        )}
        <RoleMenu path={s.path} name={name} mark={{ role: null, source: null }}
          onSaved={(p, m) => { if (m.role) onDone(p); }} />
        <button type="button" className="org-btn org-btn-sm" disabled={busy} onClick={() => onToggleDismiss(s)}
          aria-label={`${s.dismissed ? 'Restore' : 'Dismiss'} ${name}`}>
          {s.dismissed ? 'Restore' : 'Dismiss'}
        </button>
      </div>
    </li>
  );
}

/**
 * `data` = GET /api/folder-roles/suspects response (or null while loading),
 * `showDismissed` + `onShowDismissed` toggle ?dismissed=1, `onChange` reloads.
 */
export default function SuspectFolders({ data, error, showDismissed, onShowDismissed, onChange, onOpenModel }) {
  const notify = useNotify();
  const [gone, setGone] = useState(() => new Set());
  const items = ((data && data.items) || []).filter(s => !gone.has(s.path));

  const done = (path) => setGone(prev => new Set(prev).add(path));

  const toggleDismiss = async (s) => {
    try {
      await dismissSuspect(s.path, !!s.dismissed);
      if (!s.dismissed && !showDismissed) done(s.path);
      if (onChange) onChange();
    } catch (e) { notify(`Couldn't ${s.dismissed ? 'restore' : 'dismiss'} ${s.rel || s.path}: ${errorMessage(e)}`); }
  };

  return (
    <div className="suspects">
      <div className="suspects-head">
        <span className="org-hint-inline">
          Folders whose cards look wrong. Mark the role the scanner should use; it applies on the next scan.
        </span>
        <label className="suspects-toggle">
          <input type="checkbox" checked={!!showDismissed} onChange={e => onShowDismissed(e.target.checked)} /> Show dismissed
        </label>
      </div>
      {error && <div className="org-error">{error}</div>}
      {!data && !error && <div className="org-hint-inline">Loading suspect folders…</div>}
      {data && items.length === 0 && <div className="org-empty">No suspect folders 🎉</div>}
      {items.length > 0 && (
        <ul className="suspect-list" aria-label="Suspect folders">
          {items.map(s => (
            <SuspectRow key={s.path} s={s} onDone={done} onOpenModel={onOpenModel} onToggleDismiss={toggleDismiss} />
          ))}
        </ul>
      )}
    </div>
  );
}
