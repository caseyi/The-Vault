import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import FolderRoles from './FolderRoles';
import Modal, { useUniqueId } from './Modal';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './Notices';
import { apiGet, apiSend, errorMessage } from '../api';
// Only the Health → Attribution section needs it; keep it out of the main bundle.
const AttributionHealth = React.lazy(() => import('./AttributionHealth'));
// The Review tab (AI suggestions) is its own chunk too.
const ReviewTab = React.lazy(() => import('./ReviewTab'));
const OrganizerExport = React.lazy(() => import('./OrganizerExport'));
const SuspectFolders = React.lazy(() => import('./SuspectFolders'));
const EnrichPanel = React.lazy(() => import('./EnrichPanel'));

const READ_ONLY_TIP = 'Library is mounted read-only';

// ── shared helpers ────────────────────────────────────────────────────────────

function TabBar({ tabs, active, onChange, label }) {
  return (
    <div className="org-tabs" role="tablist" aria-label={label}>
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`org-tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.icon} {t.label}
          {t.badge > 0 && <span className="org-tab-badge" aria-label={`${t.badge} pending`}>{t.badge > 999 ? '999+' : t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Health tab ────────────────────────────────────────────────────────────────

/** Folder path relative to the library root (falls back to the last 2 segments). */
export function relativeFolder(folderPath, libraryPath) {
  if (!folderPath) return '';
  const root = (libraryPath || '').replace(/\/+$/, '');
  if (root && (folderPath === root || folderPath.startsWith(root + '/'))) {
    return folderPath.slice(root.length + 1) || '/';
  }
  return folderPath.split('/').filter(Boolean).slice(-2).join('/');
}

// Defined at module scope (not inside HealthTab) so re-renders of the tab don't
// remount rows and wipe their local state.
function ModelRow({ m, extra, onHide }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  return (
    <div className="org-health-row">
      <div className="org-health-name">{m.name}</div>
      {m.creator_name && <div className="org-health-creator">{m.creator_name}</div>}
      {extra && <div className="org-health-extra">{extra}</div>}
      {onHide && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onHide(m);
            setBusy(false);
            if (ok) setHidden(true);
          }}
          className="org-btn org-btn-sm" style={{ marginLeft: 'auto', flexShrink: 0 }}
          title="Hide this model (files stay on disk)">
          🙈 Hide
        </button>
      )}
    </div>
  );
}

/** Libraries named on a duplicate group / pair, when the backend says it spans libraries. */
function backupLibraries(group, models) {
  const marked = group && (group.crossLibrary || group.cross_library || group.backup);
  const libs = [...new Set(models.map(m => m.library).filter(Boolean))];
  if (marked) return libs.length ? libs : (Array.isArray(group.libraries) ? group.libraries : []);
  return null;
}

function DupGroup({ groupKey, models, label, busy, onResolve, libraryPath, backupOf }) {
  const best = [...models].sort((a, b) =>
    (Number(!!b.thumbnail_path) - Number(!!a.thumbnail_path)) || ((b.file_count || 0) - (a.file_count || 0))
  )[0];
  const [keepId, setKeepId] = useState(best?.id);
  const others = models.length - 1;
  return (
    <div className={`org-dupe-pair ${backupOf ? 'is-backup' : ''}`}>
      <div className="org-dupe-score">
        {backupOf && <span className="backup-badge">BACKUP</span>}
        {label}
      </div>
      {backupOf && (
        <div className="org-hint-inline backup-hint">
          Same files in {backupOf.length > 1 ? backupOf.join(' and ') : 'two libraries'}: this is a backup copy, not a duplicate. Nothing needs fixing.
        </div>
      )}
      <div role="radiogroup" aria-label={`Choose which copy to keep: ${label}`}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px' }}>
        {models.map(m => {
          const sel = keepId === m.id;
          let tagCount = 0;
          try { tagCount = Array.isArray(m.tags) ? m.tags.length : JSON.parse(m.tags || '[]').length; } catch {}
          const rel = relativeFolder(m.folder_path, libraryPath);
          return (
            <label key={m.id} className={`org-dupe-choice ${sel ? 'selected' : ''}`}>
              <input type="radio" name={`keep-${groupKey}`} checked={sel} onChange={() => setKeepId(m.id)} />
              {m.thumbnail_path
                ? <img src={m.thumbnail_path} alt="" className="org-dupe-thumb" loading="lazy" />
                : <div className="org-dupe-thumb org-dupe-thumb-ph" aria-hidden="true">🧩</div>}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="org-dupe-name">{sel && <span className="org-dupe-keep-badge">KEEP</span>}{m.name}</div>
                <div className="org-dupe-meta">{m.library ? `${m.library} · ` : ''}{m.creator_name || '?'} · {m.file_count || 0} files · {tagCount} tags{m.thumbnail_path ? ' · 🖼' : ''}</div>
                {rel && <div className="org-dupe-path" title={m.folder_path}>📁 {rel}</div>}
              </div>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        <button className="org-btn org-btn-success" disabled={busy || !keepId}
          onClick={() => onResolve(groupKey, keepId, models)}>
          {busy ? 'Merging…' : `✓ Keep selected · merge ${others} other${others !== 1 ? 's' : ''} into it`}
        </button>
        <span className="org-hint-inline">Files, tags and collections move to the kept card; undo with Unmerge under Review → History.</span>
      </div>
    </div>
  );
}

function fmtSize(b) {
  if (!b) return '';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

/** Files in two libraries (Dagobah + Endor) are backups, not duplicates. */
function BackupNote({ count }) {
  if (!count) return null;
  return (
    <div className="org-hint-inline backup-note">
      <span className="backup-badge">BACKUP</span>
      {Number(count).toLocaleString()} file{count !== 1 ? 's are' : ' is'} stored in more than one library. Those are backup copies, not duplicates, and are not listed here.
    </div>
  );
}

/** Same file name + size more than once inside ONE library. Read-only. */
function FileDupRow({ d, libraryPath }) {
  const copies = Array.isArray(d.copies) ? d.copies : [];
  return (
    <div className="org-dupe-pair">
      <div className="org-dupe-score">
        {d.library && <span className="backup-badge dup-lib">{d.library}</span>}
        {copies.length} copies · {fmtSize(d.filesize)}
      </div>
      <div className="file-dup-name" title={d.filename}>{d.filename}</div>
      <ul className="file-dup-copies">
        {copies.map((c, i) => (
          <li key={`${c.filepath}-${i}`} title={c.filepath}>
            {c.model_name && <span className="org-health-creator">{c.model_name}</span>}{' '}
            <span className="org-dupe-path">📁 {relativeFolder(c.filepath, libraryPath)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MISSING = [
  { id: 'noFranchise', label: 'Genre', enrich: true },
  { id: 'noTags', label: 'Tags', enrich: true },
  { id: 'noThumbnail', label: 'Picture' },
  { id: 'noSource', label: 'Source URL' },
];

/**
 * Cards missing a genre, tags, a picture or a source URL. Genre and tags are filled by Enrich, run
 * right here on just these cards; pictures come from Scan Library (free first, then the web search).
 */
function MissingInfo({ data, libraryPath, onOpenReview, onSummary }) {
  const [which, setWhich] = useState('noFranchise');
  const [enriching, setEnriching] = useState(false);
  const def = MISSING.find(x => x.id === which) || MISSING[0];
  const list = Array.isArray(data[which]) ? data[which] : [];
  const ids = useMemo(() => list.map(m => m.id), [list]);
  return (
    <>
      <div className="org-section-actions missing-info-bar">
        <div className="seg" role="group" aria-label="Missing">
          {MISSING.map(x => (
            <button key={x.id} type="button" className={`seg-btn ${which === x.id ? 'active' : ''}`} aria-pressed={which === x.id}
              onClick={() => { setWhich(x.id); setEnriching(false); }}>
              {x.label} <span className="num">{(data.summary && data.summary[x.id]) ?? 0}</span>
            </button>
          ))}
        </div>
        {def.enrich && list.length > 0 && !enriching && (
          <button className="org-btn org-btn-sm org-btn-accent" onClick={() => setEnriching(true)}>✦ Enrich these {list.length.toLocaleString()}</button>
        )}
        {which === 'noThumbnail' && list.length > 0 && (
          <span className="org-hint-inline">Scan Library → <b>Find missing pictures</b> fills these from renders in their files (free); the web search there is for what it can't fill.</span>
        )}
      </div>
      {enriching && (
        <React.Suspense fallback={<div className="org-hint-inline">Loading…</div>}>
          <div className="missing-enrich">
            <EnrichPanel presetIds={ids} onOpenReview={onOpenReview}
              onDone={() => apiGet('/api/suggestions/summary').then(onSummary).catch(() => {})} />
          </div>
        </React.Suspense>
      )}
      {list.length === 0
        ? <div className="org-empty">Every card has a {def.label.toLowerCase()} 🎉</div>
        : list.map(m => <ModelRow key={m.id} m={m} extra={relativeFolder(m.folder_path, libraryPath) || undefined} />)}
    </>
  );
}

function HealthTab({ libraryPath, onOpenReview, onSummary }) {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('crossCreator');
  const [integrityData, setIntegrityData] = useState(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [resolvedKeys, setResolvedKeys] = useState(new Set()); // dup groups already handled this session
  const [resolvingKey, setResolvingKey] = useState(null);
  const [attrSummary, setAttrSummary] = useState(undefined); // undefined = loading, null = not supported

  const loadAttrSummary = useCallback(() => {
    apiGet('/api/attribution/summary')
      .then(d => setAttrSummary(d && typeof d === 'object' && 'total' in d ? d : null))
      .catch(() => setAttrSummary(null));
  }, []);
  useEffect(() => { loadAttrSummary(); }, [loadAttrSummary]);

  // Duplicates across creators fold like an accepted merge: alias + Unmerge (Review → History)
  const resolveDup = useCallback(async (groupKey, keepId, models) => {
    const drop = models.filter(m => m.id !== keepId);
    if (!drop.length) return;
    const keep = models.find(m => m.id === keepId);
    const n = drop.length;
    const ok = await askConfirm({
      title: `Merge ${n} card${n !== 1 ? 's' : ''} into "${keep?.name}"?`,
      message: (
        <>
          <p>Keep <b>{keep?.name}</b>{keep?.creator_name ? ` (${keep.creator_name})` : ''} and fold {n === 1 ? 'the other copy' : `the other ${n} copies`} into it:</p>
          <ul className="confirm-list">
            {drop.map(m => <li key={m.id}>{m.name} <span className="confirm-dim">— {m.creator_name || '?'}{m.folder_path ? ` · ${relativeFolder(m.folder_path, libraryPath)}` : ''}</span></li>)}
          </ul>
          <p>Files, tags, notes and collections move to the kept card, and the next scan keeps them together. A database snapshot is taken first; undo with Unmerge under Review → History. Files on disk are not touched.</p>
        </>
      ),
      confirmLabel: `Merge ${n}`,
    });
    if (!ok) return;
    setResolvingKey(groupKey);
    try {
      const r = await apiSend('/api/organize/dedupe/resolve', 'POST', { keepId, dropIds: drop.map(m => m.id) });
      const merged = Number(r && r.merged) || 0;
      const errs = Array.isArray(r && r.errors) ? r.errors : [];
      if (merged) setResolvedKeys(prev => new Set(prev).add(groupKey));
      if (merged) notify(`Merged ${merged} card${merged !== 1 ? 's' : ''} into "${keep?.name}". Unmerge is under Review → History.`, { type: 'success' });
      if (errs.length) notify(`${errs.length} not merged: ${errs.map(e => e.error).join('; ')}`, { type: 'info', duration: 9000 });
    } catch (e) {
      setError(errorMessage(e));
      notify(`Couldn't merge: ${errorMessage(e)}`);
    }
    setResolvingKey(null);
  }, [askConfirm, libraryPath, notify]);

  const hideOne = useCallback(async (m) => {
    const ok = await askConfirm({
      title: 'Hide 1 model?',
      message: <p>Hide <b>{m.name}</b>? Files stay on disk; you can unhide it later.</p>,
      confirmLabel: 'Hide model',
    });
    if (!ok) return false;
    try {
      await apiSend('/api/models/bulk', 'POST', { ids: [m.id], hidden: true });
      return true;
    } catch (e) { notify(`Couldn't hide model: ${errorMessage(e)}`); return false; }
  }, [askConfirm, notify]);

  const run = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setData(await apiGet('/api/organize/health'));
    } catch (e) { setError(errorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { run(); }, [run]);

  const runIntegrity = async () => {
    setIntegrityLoading(true); setActiveSection('integrity');
    try {
      setIntegrityData(await apiGet('/api/organize/integrity'));
    } catch (e) { setError(errorMessage(e)); }
    setIntegrityLoading(false);
  };

  const missingCount = data?.summary ? MISSING.filter(x => x.id !== 'noSource').reduce((n, x) => n + (data.summary[x.id] || 0), 0) : undefined;
  const sections = [
    ...(attrSummary ? [{ id: 'attribution', label: 'Attribution', icon: '🔖', count: attrSummary.gaps }] : []),
    { id: 'crossCreator', label: 'X-Creator Dupes', icon: '🔀', count: data?.summary?.crossCreatorDupes },
    { id: 'missing',      label: 'Missing Info',    icon: '🏷', count: missingCount },
    ...(data?.summary?.fileDuplicates !== undefined ? [{ id: 'fileDuplicates', label: 'Duplicate Files', icon: '⧉', count: data.summary.fileDuplicates }] : []),
    ...(data?.summary?.conflictFolders !== undefined ? [{ id: 'conflicts', label: 'Conflict Copies', icon: '⚠', count: data.summary.conflictFolders }] : []),
    { id: 'emptyFolders', label: 'Empty Folders',   icon: '📂', count: data?.summary?.emptyFolders },
    { id: 'integrity',    label: 'Integrity',        icon: '🔍', count: integrityData?.summary?.missingFolders },
  ];

  const folderExtra = (m) => relativeFolder(m.folder_path, libraryPath) || undefined;

  function renderSection() {
    if (!data) return null;
    switch (activeSection) {
      case 'attribution':
        return attrSummary
          ? (
            <React.Suspense fallback={<div className="org-hint-inline">Loading…</div>}>
              <AttributionHealth summary={attrSummary} onSummaryChange={loadAttrSummary} />
            </React.Suspense>
          )
          : <div className="org-empty">Attribution needs a newer backend.</div>;
      case 'crossCreator': {
        const groups = (data.crossCreatorDupes || []).filter(g => !resolvedKeys.has(`xc-${g.key}`));
        return groups.length === 0
          ? <div className="org-empty">No cross-creator duplicates to resolve 🎉</div>
          : groups.map(g => (
            <DupGroup key={`xc-${g.key}`} groupKey={`xc-${g.key}`} models={g.models} libraryPath={libraryPath}
              backupOf={backupLibraries(g, g.models)}
              busy={resolvingKey === `xc-${g.key}`} onResolve={resolveDup}
              label={`"${g.key}" — ${g.models.length} copies across ${new Set(g.models.map(m => m.creator_name)).size} creators`} />
          ));
      }
      case 'missing':
        return <MissingInfo data={data} libraryPath={libraryPath} onOpenReview={onOpenReview} onSummary={onSummary} />;
      case 'fileDuplicates': {
        const list = data.fileDuplicates || [];
        return (<>
          <BackupNote count={data.summary.backupCopies} />
          {list.length === 0
            ? <div className="org-empty">No duplicate files inside a library 🎉</div>
            : list.map((d, i) => <FileDupRow key={`${d.filename}-${d.filesize}-${i}`} d={d} libraryPath={libraryPath} />)}
        </>);
      }
      case 'conflicts': {
        const list = data.conflictFolders || [];
        return list.length === 0
          ? <div className="org-empty">No Synology Drive conflict copies 🎉</div>
          : (<>
            <div className="org-hint-inline" style={{ margin: 8 }}>
              Folders ending in <code>_Conflict</code> are Synology Drive conflict copies. Compare them with the original and delete the extra on the NAS.
            </div>
            {list.map(m => <ModelRow key={m.id} m={m} extra={folderExtra(m)} onHide={hideOne} />)}
          </>);
      }
      case 'integrity':
        if (!integrityData) return (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <button className="org-btn org-btn-secondary" onClick={runIntegrity} disabled={integrityLoading}>
              {integrityLoading ? '⏳ Checking…' : '🔍 Run Integrity Check'}
            </button>
            <div className="org-hint-inline" style={{ marginTop: 8 }}>
              Checks whether each model's folder still exists on disk.
            </div>
          </div>
        );
        return integrityData.missingFolders.length === 0
          ? <div className="org-empty">All {integrityData.summary.checked} model folders found on disk 🎉</div>
          : (<>
            <div className="org-hint-inline" style={{ margin: 8 }}>
              {integrityData.summary.missingFolders} of {integrityData.summary.checked} folders not found on disk.
              These models may have been moved or deleted.
              <button className="link-btn" onClick={runIntegrity} disabled={integrityLoading} style={{ marginLeft: 8 }}>↻ Re-run</button>
            </div>
            {integrityData.missingFolders.map(m => (
              <ModelRow key={m.id} m={m} extra={folderExtra(m)} onHide={hideOne} />
            ))}
          </>);
      case 'emptyFolders':
        return data.emptyFolders.length === 0
          ? <div className="org-empty">No empty folders 🎉</div>
          : data.emptyFolders.map(m => <ModelRow key={m.id} m={m} extra={`${folderExtra(m) || ''} · ${m.file_count || 0} files`} onHide={hideOne} />);
      default: return null;
    }
  }

  return (
    <div className="org-tab-body">
      {confirmUi}
      <p className="org-desc">
        Problems in the library itself: the same model under two creators, cards missing information, duplicate or conflicting files, and folders that are empty or gone.
        Genre, tag and name suggestions are in Review.
      </p>

      <button className="org-btn org-btn-secondary" onClick={run} disabled={loading} style={{ marginBottom: 12 }}>
        {loading ? '⏳ Scanning…' : '↻ Refresh'}
      </button>

      {error && <div className="org-error">{error}</div>}

      {data && (
        <>
          <div className="org-health-sections" role="tablist" aria-label="Health checks">
            {sections.map(x => (
              <button key={x.id} role="tab" aria-selected={activeSection === x.id}
                className={`org-health-section-btn ${activeSection === x.id ? 'active' : ''}`}
                onClick={() => setActiveSection(x.id)}>
                {x.icon} {x.label}
                <span className={`org-health-badge ${x.count > 0 ? 'warn' : 'ok'}`}>{x.count ?? '…'}</span>
              </button>
            ))}
          </div>

          <div className={`org-health-list ${activeSection === 'missing' ? 'missing-list' : ''}`}>
            {renderSection()}
          </div>
        </>
      )}
    </div>
  );
}

// ── Gap Analysis tab ──────────────────────────────────────────────────────────

function GapTab() {
  const [csv, setCsv] = useState('');
  const [threshold, setThreshold] = useState(0.75);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPresent, setShowPresent] = useState(false);

  const run = useCallback(async () => {
    if (!csv.trim()) { setError('Paste your Gumroad CSV or model list first'); return; }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/organize/gap-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, threshold }),
      });
      if (!res.ok) { setError(`Error ${res.status}: ${await res.text()}`); setLoading(false); return; }
      setResult(await res.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [csv, threshold]);

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Paste a Gumroad CSV (or a plain list of model names) to find which ones are missing from your library.
      </p>

      <div className="org-row">
        <label className="org-label" htmlFor="gap-csv">Gumroad CSV or model name list</label>
        <textarea
          id="gap-csv"
          className="org-textarea"
          rows={6}
          placeholder={'Paste CSV here — or one model name per line...\n\nCSV: must have a "Model Name" or "Name" column header\nPlain list: one name per line'}
          value={csv}
          onChange={e => setCsv(e.target.value)}
        />
      </div>

      <div className="org-row org-row-inline">
        <label className="org-label" htmlFor="gap-threshold" style={{ marginBottom: 0 }}>Match threshold</label>
        <input
          id="gap-threshold"
          type="range" min={0.5} max={1} step={0.05}
          value={threshold}
          onChange={e => setThreshold(parseFloat(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
        />
        <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 12, minWidth: 36 }}>
          {Math.round(threshold * 100)}%
        </span>
      </div>

      <button className="org-btn org-btn-primary" onClick={run} disabled={loading || !csv.trim()}>
        {loading ? '⏳ Analysing…' : '🔍 Find Gaps'}
      </button>

      {error && <div className="org-error">{error}</div>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="org-gap-summary">
            <span>Checked: <b style={{ color: 'var(--text-main)' }}>{result.stats.checked}</b></span>
            <span style={{ color: 'var(--red-text)' }}>Missing: <b>{result.stats.missing}</b></span>
            <span style={{ color: 'var(--green-text)' }}>Present: <b>{result.stats.present}</b></span>
          </div>

          {result.missing.length > 0 && (
            <>
              <div className="org-gap-section-label">❌ Missing from library ({result.missing.length})</div>
              <div className="org-gap-list">
                {result.missing.map((item, i) => (
                  <div key={i} className="org-gap-row org-gap-missing">
                    <span className="org-gap-name">{item.searched}</span>
                    {item.closestMatch && (
                      <span className="org-gap-closest">
                        closest: {item.closestMatch} ({Math.round(item.score * 100)}%)
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {result.missing.length === 0 && (
            <div className="org-empty">All items found in your library 🎉</div>
          )}

          <button
            className="org-btn org-btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => setShowPresent(p => !p)}
          >
            {showPresent ? '▲ Hide' : '▼ Show'} matched ({result.present.length})
          </button>

          {showPresent && result.present.length > 0 && (
            <div className="org-gap-list" style={{ marginTop: 6 }}>
              {result.present.map((item, i) => (
                <div key={i} className="org-gap-row org-gap-present">
                  <span className="org-gap-name">{item.searched}</span>
                  <span className="org-gap-closest">→ {item.matched} ({Math.round(item.score * 100)}%)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tools tab ─────────────────────────────────────────────────────────────────

// Module scope: a component defined inside a tab would remount its children
// (and drop input focus) on every keystroke.
function Section({ title, children }) {
  return (
    <div className="org-batch-section">
      <div className="org-batch-section-title">{title}</div>
      {children}
    </div>
  );
}

/** Combine two creator entries (Tools). Files on disk are not touched. */
function CreatorMerge() {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [creators, setCreators] = useState([]);
  const [srcCreator, setSrcCreator] = useState('');
  const [dstCreator, setDstCreator] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState('');
  const [error, setError] = useState('');
  const loadCreators = useCallback(() => {
    apiGet('/api/creators').then(d => setCreators(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);
  useEffect(() => { loadCreators(); }, [loadCreators]);

  const mergeCreators = async () => {
    if (!srcCreator || !dstCreator || srcCreator === dstCreator) {
      setError('Select two different creators'); return;
    }
    const src = creators.find(c => String(c.id) === String(srcCreator));
    const dst = creators.find(c => String(c.id) === String(dstCreator));
    const n = src?.model_count ?? 0;
    const ok = await askConfirm({
      title: 'Merge creators?',
      message: <p>Move {n} model{n !== 1 ? 's' : ''} from <b>{src?.name}</b> into <b>{dst?.name}</b> and delete the creator entry "{src?.name}". Files on disk are not touched.</p>,
      confirmLabel: `Merge ${n} model${n !== 1 ? 's' : ''}`,
      danger: true,
    });
    if (!ok) return;
    setMerging(true); setError(''); setMergeResult('');
    try {
      const d = await apiSend(`/api/creators/${srcCreator}/merge`, 'POST', { targetCreatorId: parseInt(dstCreator, 10) });
      setMergeResult(`✓ Merged "${d.sourceCreator}" → "${d.targetCreator}" (${d.moved} models moved)`);
      setSrcCreator(''); setDstCreator('');
      loadCreators();
    } catch (e) { setError(errorMessage(e)); notify(`Merge failed: ${errorMessage(e)}`); }
    setMerging(false);
  };

  return (
    <Section title="🔀 Merge Creators">
      {confirmUi}
      {error && <div className="org-error">{error}</div>}
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 8 }}>
        Combine two creator entries into one. All models from the source move to the target; the source creator is deleted.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
        <div>
          <label className="org-label" htmlFor="merge-src" style={{ marginBottom: 4, display: 'block' }}>Merge FROM (will be deleted)</label>
          <select id="merge-src" className="org-select" style={{ width: '100%' }} value={srcCreator} onChange={e => setSrcCreator(e.target.value)}>
            <option value="">Source creator…</option>
            {creators.map(c => <option key={c.id} value={c.id}>{c.name} ({c.model_count})</option>)}
          </select>
        </div>
        <span style={{ color: 'var(--text-faint)', fontSize: 18, textAlign: 'center' }} aria-hidden="true">→</span>
        <div>
          <label className="org-label" htmlFor="merge-dst" style={{ marginBottom: 4, display: 'block' }}>Merge INTO (kept)</label>
          <select id="merge-dst" className="org-select" style={{ width: '100%' }} value={dstCreator} onChange={e => setDstCreator(e.target.value)}>
            <option value="">Target creator…</option>
            {creators.filter(c => c.id !== parseInt(srcCreator, 10)).map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.model_count})</option>
            ))}
          </select>
        </div>
      </div>
      <button onClick={mergeCreators}
        disabled={merging || !srcCreator || !dstCreator}
        className="org-btn org-btn-secondary org-btn-danger" style={{ marginTop: 10 }}>
        {merging ? '⏳ Merging…' : '🔀 Merge Creators'}
      </button>
      {mergeResult && <div className="org-success-box" style={{ marginTop: 6 }}>{mergeResult}</div>}
    </Section>
  );
}

// ── Main OrganizeModal ────────────────────────────────────────────────────────

// ── Loose File Grouper tab ────────────────────────────────────────────────────

function LooseTab({ libraryWritable }) {
  const [confirmUi, askConfirm] = useConfirm();
  const [creators, setCreators] = useState([]);
  const [creatorId, setCreatorId] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null); // { path, groups, existingFolders, looseFileCount }
  const [groups, setGroups] = useState([]); // editable copy of groups
  const [editingIdx, setEditingIdx] = useState(null);
  const [editName, setEditName] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [scriptResult, setScriptResult] = useState(null); // { script, summary, errors }
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/creators').then(r => r.json()).then(setCreators).catch(() => {});
  }, []);

  // Resolve path: creator folder_path or manual override
  const activePath = (() => {
    if (manualPath.trim()) return manualPath.trim();
    const c = creators.find(c => String(c.id) === creatorId);
    return c?.folder_path || '';
  })();

  const scan = async () => {
    if (!activePath) { setError('Select a creator or enter a folder path'); return; }
    setError(''); setScanResult(null); setScriptResult(null); setGroups([]);
    setScanning(true);
    try {
      const res = await fetch(`/api/organize/loose-files?path=${encodeURIComponent(activePath)}`);
      const d = await res.json();
      if (!res.ok) { setError(d.error || `Error ${res.status}`); setScanning(false); return; }
      setScanResult(d);
      setGroups(d.groups.map(g => ({ name: g.suggestedName, files: g.files, conflicts: g.conflicts })));
      setExpanded(new Set()); // collapse all by default
    } catch (e) { setError(e.message); }
    setScanning(false);
  };

  const renameGroup = (idx, newName) => {
    setGroups(gs => gs.map((g, i) => i === idx ? { ...g, name: newName } : g));
  };

  const removeFileFromGroup = (gIdx, fileIdx) => {
    setGroups(gs => gs.map((g, i) => {
      if (i !== gIdx) return g;
      const files = g.files.filter((_, fi) => fi !== fileIdx);
      return { ...g, files };
    }).filter(g => g.files.length > 0));
  };

  const toggleExpanded = (idx) => {
    setExpanded(ex => {
      const next = new Set(ex);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const generateScript = async (dryRun = true) => {
    if (!dryRun) {
      if (libraryWritable !== true) { setError(READ_ONLY_TIP); return; }
      const nFiles = groups.reduce((s, g) => s + g.files.length, 0);
      const ok = await askConfirm({
        title: `Move ${nFiles} file${nFiles !== 1 ? 's' : ''} now?`,
        message: <p>This moves {nFiles} file{nFiles !== 1 ? 's' : ''} into {groups.length} new folder{groups.length !== 1 ? 's' : ''} inside <code>{activePath}</code> on disk. Rescan afterwards.</p>,
        confirmLabel: 'Move files',
        danger: true,
      });
      if (!ok) return;
    }
    setError(''); setScriptResult(null);
    setScanning(true);
    try {
      const res = await fetch('/api/organize/group-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activePath, groups, dryRun }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `Error ${res.status}`); }
      else { setScriptResult(d); }
    } catch (e) { setError(e.message); }
    setScanning(false);
  };

  const copyScript = () => {
    if (!scriptResult?.script) return;
    navigator.clipboard.writeText(scriptResult.script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="org-tab-body">
      {confirmUi}
      {/* ── Step 1: Pick folder ── */}
      <div className="org-section-title">📂 UNPACK LOOSE FILES</div>
      <p className="org-hint">
        Finds loose files in a creator folder and groups them into model subfolders.
        Useful after bulk-downloading from Gumroad or Google Drive.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label className="org-label" htmlFor="loose-creator">Creator (auto-fills path)</label>
          <select id="loose-creator" className="org-select" value={creatorId} onChange={e => { setCreatorId(e.target.value); setManualPath(''); }}>
            <option value="">— pick a creator —</option>
            {creators.filter(c => c.folder_path).map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.model_count} models)</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="org-label" htmlFor="loose-path">…or enter a folder path directly</label>
        <input
          id="loose-path"
          className="org-input"
          placeholder="/library/STL Archive/CA 3D"
          value={manualPath}
          onChange={e => { setManualPath(e.target.value); setCreatorId(''); }}
        />
      </div>
      {activePath && <div className="org-hint" style={{ marginBottom: 8 }}>Path: <code style={{ color: 'var(--accent)' }}>{activePath}</code></div>}

      <button className="org-btn org-btn-primary" onClick={scan} disabled={scanning || !activePath} style={{ marginBottom: 16 }}>
        {scanning ? '⏳ Scanning…' : '🔍 Scan for Loose Files'}
      </button>

      {error && <div className="org-error">{error}</div>}

      {/* ── Results ── */}
      {scanResult && (
        <>
          <div className="org-loose-summary">
            <span className="org-loose-stat"><b>{scanResult.looseFileCount}</b> loose files</span>
            <span className="org-loose-stat-sep">→</span>
            <span className="org-loose-stat"><b>{groups.length}</b> proposed groups</span>
            {scanResult.existingFolders.length > 0 && (
              <span className="org-loose-stat-existing">{scanResult.existingFolders.length} existing folders</span>
            )}
          </div>

          {groups.length === 0 && (
            <div className="org-empty">No loose files found — folder is already organized.</div>
          )}

          <div className="org-loose-groups">
            {groups.map((g, idx) => (
              <div key={idx} className={`org-loose-group ${g.conflicts ? 'org-loose-conflict' : ''}`}>
                <div className="org-loose-group-header" onClick={() => toggleExpanded(idx)}>
                  <span className="org-loose-expand">{expanded.has(idx) ? '▼' : '▶'}</span>
                  {editingIdx === idx ? (
                    <input
                      className="org-loose-name-input"
                      value={editName}
                      autoFocus
                      onClick={e => e.stopPropagation()}
                      aria-label="Folder name for this group"
                      onChange={e => setEditName(e.target.value)}
                      onBlur={() => { renameGroup(idx, editName); setEditingIdx(null); }}
                      onKeyDown={e => { if (e.key === 'Enter') { renameGroup(idx, editName); setEditingIdx(null); } if (e.key === 'Escape') setEditingIdx(null); }}
                    />
                  ) : (
                    <span className="org-loose-group-name">{g.name}</span>
                  )}
                  <span className="org-loose-file-count">{g.files.length} file{g.files.length !== 1 ? 's' : ''}</span>
                  {g.conflicts && <span className="org-loose-conflict-badge">⚠ folder exists</span>}
                  <button
                    className="org-loose-rename-btn"
                    onClick={e => { e.stopPropagation(); setEditingIdx(idx); setEditName(g.name); }}
                    title="Rename group"
                    aria-label={`Rename group ${g.name}`}
                  >✏</button>
                </div>

                {expanded.has(idx) && (
                  <div className="org-loose-files">
                    {g.files.map((f, fi) => (
                      <div key={fi} className="org-loose-file">
                        <span className="org-loose-filename">{f}</span>
                        <button
                          className="org-loose-remove-btn"
                          onClick={() => removeFileFromGroup(idx, fi)}
                          title="Remove from group"
                          aria-label={`Remove ${f} from group`}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {groups.length > 0 && !scriptResult && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="org-btn org-btn-primary" onClick={() => generateScript(true)} disabled={scanning}>
                  📋 Generate Move Script
                </button>
                {/* Moving files directly needs a writable library mount */}
                <span title={libraryWritable === true ? 'Move the files on disk now' : READ_ONLY_TIP}>
                  <button className="org-btn org-btn-secondary" onClick={() => generateScript(false)}
                    disabled={scanning || libraryWritable !== true}
                    aria-describedby={libraryWritable === true ? undefined : 'loose-ro-hint'}>
                    📦 Move Files Now
                  </button>
                </span>
              </div>
              <div className="org-hint" id="loose-ro-hint" style={{ marginTop: 6 }}>
                {libraryWritable === true
                  ? 'Generate a bash script to review and run yourself, or move the files directly. Rescan afterwards.'
                  : <>{READ_ONLY_TIP}, so The Vault can't move files itself. Generate a safe bash script instead — review it, run it over SSH on your NAS, then rescan.</>}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Script output ── */}
      {scriptResult && (
        <div className="org-loose-script-panel">
          <div className="org-loose-script-header">
            <span>
              {scriptResult.dryRun
                ? `📋 Bash script — ${scriptResult.summary.groups} folders, ${scriptResult.summary.files} files`
                : `${scriptResult.errors.length ? '⚠' : '✓'} Direct move — ${scriptResult.summary.executed} files moved, ${scriptResult.summary.errors} errors`}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="org-btn org-btn-small" onClick={copyScript}>
                {copied ? '✓ Copied!' : '📋 Copy'}
              </button>
              <button className="org-btn org-btn-small" onClick={() => setScriptResult(null)}>Reset</button>
            </div>
          </div>

          {scriptResult.dryRun && (
            <div className="org-hint" style={{ marginBottom: 8 }}>
              SSH into your NAS and paste this script to move the files. After running, trigger a library rescan.
            </div>
          )}

          {scriptResult.errors.length > 0 && (
            <div className="org-error" style={{ marginBottom: 8 }}>
              {scriptResult.errors.map((e, i) => <div key={i}>{e.type}: {e.file || e.name} — {e.error}</div>)}
            </div>
          )}

          <pre className="org-loose-script">{scriptResult.script}</pre>
        </div>
      )}
    </div>
  );
}

/** Small section switcher inside a tab (Folders, Tools). */
function SectionBar({ sections, active, onChange, label }) {
  return (
    <div className="org-health-sections" role="tablist" aria-label={label}>
      {sections.map(x => (
        <button key={x.id} role="tab" aria-selected={active === x.id}
          className={`org-health-section-btn ${active === x.id ? 'active' : ''}`} onClick={() => onChange(x.id)}>
          {x.icon} {x.label}{x.count != null && <span className={`org-health-badge ${x.count > 0 ? 'warn' : 'ok'}`}>{x.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Folders: what each folder is (roles), folders that look wrong (suspects), and loose files to group. */
function FoldersTab({ libraryWritable, onOpenModel }) {
  const [sub, setSub] = useState('roles');
  // Suspect folders (docs/folder-roles.md §4); undefined = loading, null = older backend
  const [suspects, setSuspects] = useState(undefined);
  const [suspectsError, setSuspectsError] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const loadSuspects = useCallback((dismissed) => {
    setSuspectsError('');
    apiGet(`/api/folder-roles/suspects?dismissed=${dismissed ? 1 : 0}`)
      .then(d => setSuspects(d && Array.isArray(d.items) ? d : null))
      .catch(e => {
        if (e && e.status === 404) setSuspects(null);
        else { setSuspectsError(errorMessage(e)); setSuspects(sv => (sv === undefined ? { items: [] } : sv)); }
      });
  }, []);
  useEffect(() => { loadSuspects(showDismissed); }, [loadSuspects, showDismissed]);
  const sections = [
    { id: 'roles', label: 'Folder Roles', icon: '🗃' },
    ...(suspects ? [{ id: 'suspects', label: 'Suspect Folders', icon: '⚑', count: suspects.items.filter(x => !x.dismissed).length }] : []),
    { id: 'unpack', label: 'Unpack Loose Files', icon: '📦' },
  ];
  return (
    <div className="org-tab-body">
      <SectionBar sections={sections} active={sub} onChange={setSub} label="Folder tools" />
      {sub === 'roles' && <FolderRoles />}
      {sub === 'suspects' && (
        <React.Suspense fallback={<div className="org-hint-inline">Loading…</div>}>
          <SuspectFolders data={suspects} error={suspectsError} showDismissed={showDismissed}
            onShowDismissed={setShowDismissed} onChange={() => loadSuspects(showDismissed)} onOpenModel={onOpenModel} />
        </React.Suspense>
      )}
      {sub === 'unpack' && <LooseTab libraryWritable={libraryWritable} />}
    </div>
  );
}

/** Tools: a list against the library, combine creators, export what the Vault learned. */
function ToolsTab() {
  const [sub, setSub] = useState('gaps');
  const sections = [
    { id: 'gaps', label: 'Gap Analysis', icon: '🔍' },
    { id: 'creators', label: 'Merge Creators', icon: '🔀' },
    { id: 'export', label: 'Organizer Export', icon: '⇪' },
  ];
  return (
    <div className="org-tab-body">
      <SectionBar sections={sections} active={sub} onChange={setSub} label="Tools" />
      {sub === 'gaps' && <GapTab />}
      {sub === 'creators' && <CreatorMerge />}
      {sub === 'export' && (
        <React.Suspense fallback={<div className="org-hint-inline">Loading…</div>}>
          <div className="attr-health"><OrganizerExport /></div>
        </React.Suspense>
      )}
    </div>
  );
}

const TABS = [
  { id: 'review',  label: 'Review',  icon: '✓' },
  { id: 'health',  label: 'Health',  icon: '⚕' },
  { id: 'folders', label: 'Folders', icon: '🗃' },
  { id: 'tools',   label: 'Tools',   icon: '⚙' },
];
const TAB_IDS = new Set(TABS.map(t => t.id));

export default function OrganizeModal({ onClose, libraryWritable, libraryPath, initialTab, onSuggestionsChange, onOpenModel }) {
  const titleId = useUniqueId('org-title');
  const [tab, setTab] = useState(TAB_IDS.has(initialTab) ? initialTab : 'review');
  const [pending, setPending] = useState(null);
  const onSuggestionsChangeRef = useRef(onSuggestionsChange);
  onSuggestionsChangeRef.current = onSuggestionsChange;
  const updateSummary = useCallback((s) => {
    setPending(s && typeof s.pending === 'number' ? s.pending : null);
    if (onSuggestionsChangeRef.current) onSuggestionsChangeRef.current(s);
  }, []);
  useEffect(() => {
    apiGet('/api/suggestions/summary').then(updateSummary).catch(() => setPending(null));
  }, [updateSummary]);
  const tabs = TABS.map(t => (t.id === 'review' ? { ...t, badge: pending || 0 } : t));

  return (
    <Modal onClose={onClose} labelledBy={titleId} overlayClassName="organize-overlay" className="organize-modal">
      <div className="org-header">
        <div>
          <div className="org-title" id={titleId}>🗂 ORGANIZE LIBRARY</div>
          <div className="org-subtitle">Review AI suggestions · Health checks · Folders · Tools</div>
        </div>
        <button className="org-close" onClick={onClose} aria-label="Close Organize Library">✕</button>
      </div>

      {libraryWritable === false && (
        <div className="org-readonly-banner" role="note">🔒 {READ_ONLY_TIP}: tools that would move files generate a script for you to run instead.</div>
      )}

      <TabBar tabs={tabs} active={tab} onChange={setTab} label="Organize sections" />

      {tab === 'review' && (
        <React.Suspense fallback={<div className="org-tab-body"><div className="org-hint-inline">Loading…</div></div>}>
          <ReviewTab onSummary={updateSummary} />
        </React.Suspense>
      )}
      {tab === 'health'  && <HealthTab libraryPath={libraryPath} onOpenReview={() => setTab('review')} onSummary={updateSummary} />}
      {tab === 'folders' && <FoldersTab libraryWritable={libraryWritable} onOpenModel={onOpenModel} />}
      {tab === 'tools'   && <ToolsTab />}
    </Modal>
  );
}
