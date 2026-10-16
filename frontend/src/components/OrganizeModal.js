import React, { useState, useRef, useEffect, useCallback } from 'react';
import FolderRoles from './FolderRoles';
import Modal, { useUniqueId } from './Modal';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './Notices';
import { apiGet, apiSend, errorMessage } from '../api';

const READ_ONLY_TIP = 'Library is mounted read-only';

// ── shared helpers ────────────────────────────────────────────────────────────

function getApiKey() {
  try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; }
}

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
        </button>
      ))}
    </div>
  );
}

// ── Annotate tab ──────────────────────────────────────────────────────────────

const ANNOTATE_STORAGE_KEY = 'vault_annotate_session';

const EXPORT_PREAMBLE = `You are helping organize a 3D printing STL file library called "The Vault".

Analyze the library snapshot below and generate directives to improve organization.

DIRECTIVE FORMAT (one per line, no extra text):
  FRANCHISE: "Model Name" → franchise_name
  TAG: "Model Name" → tag1, tag2, tag3
  RENAME: "Old Name" → "New Name"
  MERGE: "Duplicate Model" → "Keep This One"

GUIDELINES:
- Assign FRANCHISE for named characters/universes (Marvel, DC, Star Wars, Warhammer, TMNT, etc.)
- Use lowercase TAG values: bust, full-figure, terrain, scenic, presupported, fdm, resin, etc.
- RENAME only when the name is ambiguous, truncated, or poorly formatted
- MERGE only when two entries appear to be the exact same model
- Emit only directive lines — no commentary, no headers, no explanations

After Claude replies, copy the directive lines and paste them into The Vault's Annotate tab.

--- LIBRARY SNAPSHOT ---
`;

function AnnotateTab({ target, onClearTarget }) {
  const [creator, setCreator] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [creators, setCreators] = useState([]);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [directives, setDirectives] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [exporting, setExporting] = useState(false);
  const esRef = useRef(null);
  const logRef = useRef(null);

  // Restore saved session from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ANNOTATE_STORAGE_KEY);
      if (raw) {
        const { directives: saved, creator: savedCreator, savedAt: ts } = JSON.parse(raw);
        if (saved?.length) {
          setDirectives(saved);
          setSelected(new Set(saved.map((_, i) => i)));
          if (savedCreator) setCreator(savedCreator);
          setSavedAt(ts);
        }
      }
    } catch {}
  }, []);

  // Persist directives to localStorage whenever they change
  useEffect(() => {
    if (directives.length === 0) return;
    try {
      const ts = new Date().toISOString();
      localStorage.setItem(ANNOTATE_STORAGE_KEY, JSON.stringify({ directives, creator, savedAt: ts }));
      setSavedAt(ts);
    } catch {}
  }, [directives]); // eslint-disable-line

  useEffect(() => {
    fetch('/api/creators').then(r => r.json()).then(setCreators).catch(() => {});
  }, []);

  // Auto-scroll directive list
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [directives.length]);

  const clearSession = () => {
    try { localStorage.removeItem(ANNOTATE_STORAGE_KEY); } catch {}
    setDirectives([]);
    setSelected(new Set());
    setPreview(null);
    setApplyResult(null);
    setStatusMsg('');
    setSavedAt(null);
    setError('');
  };

  const run = useCallback(async () => {
    const apiKey = getApiKey();
    if (!apiKey) { setError('No Claude API key — set it in Settings first'); return; }

    setError('');
    setDirectives([]);
    setSelected(new Set());
    setPreview(null);
    setApplyResult(null);
    setSavedAt(null);
    setRunning(true);
    setStatusMsg('Connecting to Claude…');
    try { localStorage.removeItem(ANNOTATE_STORAGE_KEY); } catch {}

    if (esRef.current) esRef.current.close();

    try {
      const res = await fetch('/api/organize/auto-annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-key': apiKey },
        body: JSON.stringify({
        creator: creator || undefined,
        pathFilter: pathFilter || undefined,
        modelIds: target?.modelIds?.length ? target.modelIds : undefined,
      }),
      });

      if (!res.ok) { setError(`Error ${res.status}: ${await res.text()}`); setRunning(false); setStatusMsg(''); return; }

      setStatusMsg('Streaming directives from Claude…');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let count = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'directive' && ev.text) {
              count++;
              setDirectives(d => [...d, ev.text]);
              setStatusMsg(`Received ${count} directive${count !== 1 ? 's' : ''}…`);
            } else if (ev.type === 'done') {
              setStatusMsg(`✓ Done — ${count} directive${count !== 1 ? 's' : ''} generated`);
              setRunning(false);
              // Auto-select all
              setSelected(new Set(Array.from({ length: count }, (_, i) => i)));
            } else if (ev.type === 'error') {
              setError(ev.message);
              setStatusMsg('');
              setRunning(false);
            }
          } catch {}
        }
      }
    } catch (e) {
      setError(e.message);
      setStatusMsg('');
    }
    setRunning(false);
  }, [creator, pathFilter, target]);

  const exportForClaude = useCallback(async () => {
    setExporting(true);
    setError('');
    try {
      const qp = new URLSearchParams();
      if (creator) qp.set('creator', creator);
      if (pathFilter) qp.set('pathFilter', pathFilter);
      const qs = qp.toString() ? `?${qp}` : '';
      const res = await fetch(`/api/organize/snapshot${qs}`);
      if (!res.ok) throw new Error(`Snapshot error ${res.status}`);
      const snapshot = await res.text();
      const fullText = EXPORT_PREAMBLE + snapshot + '\n--- END SNAPSHOT ---\n';
      const blob = new Blob([fullText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = (creator || pathFilter) ? '-' + (creator || pathFilter).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '') : '';
      a.download = `vault-annotate-prompt${suffix}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    }
    setExporting(false);
  }, [creator, pathFilter]);

  const pasteDirectives = useCallback((text) => {
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l => /^(FRANCHISE|TAG|RENAME|MERGE):/i.test(l));
    if (!lines.length) { setError('No valid directives found in pasted text'); return; }
    setDirectives(lines);
    setSelected(new Set(lines.map((_, i) => i)));
    setPreview(null);
    setApplyResult(null);
    setError('');
    setStatusMsg(`Loaded ${lines.length} directive${lines.length !== 1 ? 's' : ''} from paste`);
  }, []);

  const selectAll = () => setSelected(new Set(directives.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());
  const toggleOne = (i) => setSelected(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const previewSelected = useCallback(async () => {
    const chosen = directives.filter((_, i) => selected.has(i));
    if (!chosen.length) { setError('Select at least one directive'); return; }
    setError('');
    try {
      const data = await apiSend('/api/organize/annotate/preview', 'POST', { directives: chosen });
      setPreview(data);
    } catch (e) { setError(`Preview failed: ${errorMessage(e)}`); }
  }, [directives, selected]);

  const applySelected = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError('');
    const chosen = directives.filter((_, i) => selected.has(i));
    // Newer backends tag each preview change with an `id`; send those back so the
    // server applies exactly what was previewed. Directives are still sent for
    // older backends.
    const ids = (preview.changes || []).filter(c => c.found && c.id != null).map(c => c.id);
    const body = { directives: chosen };
    if (ids.length) body.ids = ids;
    try {
      const data = await apiSend('/api/organize/annotate/apply', 'POST', body);
      setApplyResult(data);
      setPreview(null);
    } catch (e) { setError(`Apply failed: ${errorMessage(e)}`); }
    setApplying(false);
  }, [directives, selected, preview]);

  const typeColor = { FRANCHISE: 'var(--accent-text)', RENAME: 'var(--blue-text)', MERGE: 'var(--purple-text)', TAG: 'var(--green-text)' };

  function directiveType(line) {
    const m = line.match(/^(FRANCHISE|RENAME|MERGE|TAG):/i);
    return m ? m[1].toUpperCase() : 'OTHER';
  }

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Generate Claude AI directives to franchise-tag, rename, merge, and tag your entire library — then apply selectively.
        Or export a prompt to paste into Claude manually and import the response.
      </p>

      {/* Target banner from health/franchise tab */}
      {target?.modelIds?.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          background: 'rgba(193,127,58,0.08)', border: '1px solid rgba(193,127,58,0.3)',
          borderRadius: 6, marginBottom: 10,
        }}>
          <span style={{ fontSize: 12, color: 'var(--accent)', flex: 1 }}>
            🎯 Targeting: <b>{target.label}</b>
          </span>
          <button className="org-btn org-btn-sm" onClick={onClearTarget}
            style={{ color: 'var(--text-faint)' }}>✕ Clear</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="org-row" style={{ marginBottom: 0 }}>
          <label className="org-label">Filter by creator</label>
          <select className="org-select" aria-label="Filter by creator" value={creator} onChange={e => { setCreator(e.target.value); setPathFilter(''); }}>
            <option value="">All creators</option>
            {creators.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>
        <div className="org-row" style={{ marginBottom: 0 }}>
          <label className="org-label">Filter by subfolder / path</label>
          <input
            className="org-select"
            placeholder="e.g. Marvel, Star Wars, X-Men…"
            aria-label="Filter by subfolder or path"
            value={pathFilter}
            onChange={e => { setPathFilter(e.target.value); setCreator(''); }}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="org-btn org-btn-primary" onClick={run} disabled={running} style={{ flex: '1 1 auto' }}>
          {running ? `⏳ ${statusMsg || 'Generating…'}` : '✦ Generate with AI'}
        </button>
        <button className="org-btn org-btn-secondary" onClick={exportForClaude} disabled={exporting} title="Download a .txt file to paste into Claude manually">
          {exporting ? '⏳' : '📄'} Export for Claude
        </button>
      </div>

      {/* Paste-back area (shown when no directives loaded yet or as an alternative) */}
      {!running && directives.length === 0 && (
        <div style={{ marginTop: 10 }}>
          <label className="org-label">Paste Claude's response here to import directives</label>
          <textarea
            className="org-textarea"
            aria-label="Paste Claude's response to import directives"
            rows={5}
            placeholder={"Paste Claude's output here — lines starting with FRANCHISE:, TAG:, RENAME:, or MERGE: will be imported automatically"}
            onPaste={e => {
              e.preventDefault();
              pasteDirectives(e.clipboardData.getData('text'));
            }}
            onChange={e => { if (e.target.value.trim()) pasteDirectives(e.target.value); }}
          />
        </div>
      )}

      {/* Status line */}
      {statusMsg && !error && (
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', padding: '6px 10px',
          background: 'rgba(193,127,58,0.06)', border: '1px solid rgba(193,127,58,0.2)',
          borderRadius: 4, color: 'var(--accent)', marginTop: 4,
        }}>
          {statusMsg}
        </div>
      )}

      {/* Saved indicator */}
      {savedAt && directives.length > 0 && !running && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
            💾 Auto-saved {new Date(savedAt).toLocaleTimeString()}
          </span>
          <button className="org-btn org-btn-sm org-btn-danger" onClick={clearSession}>
            ✕ Clear
          </button>
        </div>
      )}

      {error && <div className="org-error">{error}</div>}

      {directives.length > 0 && (
        <>
          <div className="org-directive-header">
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {directives.length} directive{directives.length !== 1 ? 's' : ''} · {selected.size} selected
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="org-btn org-btn-sm" onClick={selectAll}>All</button>
              <button className="org-btn org-btn-sm" onClick={selectNone}>None</button>
              <button className="org-btn org-btn-sm" onClick={() => {
                const keep = new Set();
                directives.forEach((d, i) => { if (['FRANCHISE','TAG'].includes(directiveType(d))) keep.add(i); });
                setSelected(keep);
              }}>FRANCHISE+TAG</button>
            </div>
          </div>

          <div className="org-directive-list" ref={logRef}>
            {directives.map((line, i) => {
              const type = directiveType(line);
              return (
                <div
                  key={i}
                  role="checkbox"
                  aria-checked={selected.has(i)}
                  tabIndex={0}
                  className={`org-directive ${selected.has(i) ? 'selected' : ''}`}
                  onClick={() => toggleOne(i)}
                  onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleOne(i); } }}
                >
                  <span className="org-directive-check" aria-hidden="true">{selected.has(i) ? '☑' : '☐'}</span>
                  <span className="org-directive-type" style={{ color: typeColor[type] || 'var(--text-faint)' }}>{type}</span>
                  <span className="org-directive-text">{line.replace(/^[A-Z]+:\s*/i, '')}</span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="org-btn org-btn-secondary" onClick={previewSelected} disabled={!selected.size}>
              🔍 Preview Changes
            </button>
            {preview && (
              <button className="org-btn org-btn-success" onClick={applySelected} disabled={applying}>
                {applying ? 'Applying…' : `✓ Apply ${preview.stats.found} Changes`}
              </button>
            )}
          </div>

          {preview && (
            <div className="org-preview-box">
              <div className="org-preview-header">Preview — {preview.stats.found} will apply · {preview.stats.notFound} not found</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
                {Object.entries(preview.stats.byType).map(([type, count]) => (
                  <span key={type} style={{ color: typeColor[type] || 'var(--text-faint)' }}>{type}: {count}</span>
                ))}
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', padding: '8px 12px' }}>
                {preview.changes.map((c, i) => (
                  <div key={c.id ?? i} style={{ fontSize: 11, padding: '3px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: typeColor[c.type] || 'var(--text-faint)', minWidth: 70, fontSize: 10 }}>{c.type}</span>
                    <span style={{ color: c.found ? 'var(--text-main)' : 'var(--text-faint)', flex: 1 }}>
                      {c.type === 'FRANCHISE' && `${c.modelName} → franchise: ${c.franchise}`}
                      {c.type === 'RENAME' && `${c.oldName} → ${c.newName}`}
                      {c.type === 'TAG' && `${c.modelName}: ${(c.tags || []).join(', ')}`}
                      {c.type === 'MERGE' && `${c.srcName} → ${c.targetName} (advisory)`}
                    </span>
                    {!c.found && <span style={{ color: 'var(--red-text)', fontSize: 10 }}>NOT FOUND</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {applyResult && (
            <div className="org-success-box">
              ✓ Applied {applyResult.applied} changes · {applyResult.skipped} skipped
            </div>
          )}
        </>
      )}
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

function DupGroup({ groupKey, models, label, busy, onResolve, libraryPath }) {
  const best = [...models].sort((a, b) =>
    (Number(!!b.thumbnail_path) - Number(!!a.thumbnail_path)) || ((b.file_count || 0) - (a.file_count || 0))
  )[0];
  const [keepId, setKeepId] = useState(best?.id);
  const others = models.length - 1;
  return (
    <div className="org-dupe-pair">
      <div className="org-dupe-score">{label}</div>
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
                <div className="org-dupe-meta">{m.creator_name || '?'} · {m.file_count || 0} files · {tagCount} tags{m.thumbnail_path ? ' · 🖼' : ''}</div>
                {rel && <div className="org-dupe-path" title={m.folder_path}>📁 {rel}</div>}
              </div>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        <button className="org-btn org-btn-success" disabled={busy || !keepId}
          onClick={() => onResolve(groupKey, keepId, models)}>
          {busy ? 'Merging…' : `✓ Keep selected · hide ${others} other${others !== 1 ? 's' : ''}`}
        </button>
        <span className="org-hint-inline">Tags & collections fold into the kept model; the rest are hidden (not deleted).</span>
      </div>
    </div>
  );
}

function HealthTab({ onAnnotateThese, libraryPath }) {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('crossCreator');
  const [thumbFixing, setThumbFixing] = useState(false);
  const [thumbResult, setThumbResult] = useState('');
  const [integrityData, setIntegrityData] = useState(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [resolvedKeys, setResolvedKeys] = useState(new Set()); // dup groups already handled this session
  const [resolvingKey, setResolvingKey] = useState(null);

  const resolveDup = useCallback(async (groupKey, keepId, models) => {
    const drop = models.filter(m => m.id !== keepId);
    if (!drop.length) return;
    const keep = models.find(m => m.id === keepId);
    const n = drop.length;
    const ok = await askConfirm({
      title: `Hide ${n} model${n !== 1 ? 's' : ''}?`,
      message: (
        <>
          <p>Keep <b>{keep?.name}</b>{keep?.creator_name ? ` (${keep.creator_name})` : ''} and hide {n === 1 ? 'the other copy' : `the other ${n} copies`}:</p>
          <ul className="confirm-list">
            {drop.map(m => <li key={m.id}>{m.name} <span className="confirm-dim">— {m.creator_name || '?'}{m.folder_path ? ` · ${relativeFolder(m.folder_path, libraryPath)}` : ''}</span></li>)}
          </ul>
          <p>Files stay on disk; you can unhide them later.</p>
        </>
      ),
      confirmLabel: `Hide ${n} model${n !== 1 ? 's' : ''}`,
    });
    if (!ok) return;
    setResolvingKey(groupKey);
    try {
      await apiSend('/api/organize/dedupe/resolve', 'POST', { keepId, dropIds: drop.map(m => m.id) });
      setResolvedKeys(prev => new Set(prev).add(groupKey));
      notify(`Kept "${keep?.name}", hid ${n} duplicate${n !== 1 ? 's' : ''}`, { type: 'success' });
    } catch (e) {
      setError(errorMessage(e));
      notify(`Couldn't resolve duplicates: ${errorMessage(e)}`);
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

  const fixThumbnails = async () => {
    setThumbFixing(true); setThumbResult('');
    try {
      const d = await apiSend('/api/organize/fix-thumbnails', 'POST');
      setThumbResult(`✓ Fixed ${d.fixed}${d.extracted ? ` + extracted ${d.extracted} from archives` : ''}`);
      run();
    } catch (e) { setError(errorMessage(e)); }
    setThumbFixing(false);
  };

  const runIntegrity = async () => {
    setIntegrityLoading(true); setActiveSection('integrity');
    try {
      setIntegrityData(await apiGet('/api/organize/integrity'));
    } catch (e) { setError(errorMessage(e)); }
    setIntegrityLoading(false);
  };

  const sections = [
    { id: 'crossCreator', label: 'X-Creator Dupes', icon: '🔀', count: data?.summary?.crossCreatorDupes },
    { id: 'duplicates',   label: 'Similar Names',   icon: '⧉', count: data?.summary?.duplicatePairs },
    { id: 'integrity',    label: 'Integrity',        icon: '🔍', count: integrityData?.summary?.missingFolders },
    { id: 'emptyFolders', label: 'Empty Folders',   icon: '📂', count: data?.summary?.emptyFolders },
    { id: 'noThumbnail',  label: 'No Thumbnail',    icon: '🖼', count: data?.summary?.noThumbnail },
    { id: 'noTags',       label: 'No Tags',          icon: '🏷', count: data?.summary?.noTags },
    { id: 'noFranchise',  label: 'No Franchise',     icon: '🗂', count: data?.summary?.noFranchise },
    { id: 'noSource',     label: 'No Source URL',    icon: '🔗', count: data?.summary?.noSource },
  ];

  const folderExtra = (m) => relativeFolder(m.folder_path, libraryPath) || undefined;

  // Quick-fix action bar for the current section
  function renderSectionActions() {
    if (!data) return null;
    if (activeSection === 'noFranchise' && data.noFranchise.length > 0 && onAnnotateThese) {
      return (
        <div className="org-section-actions">
          <span className="org-hint-inline">{data.noFranchise.length} models without franchise assignment</span>
          <button className="org-btn org-btn-sm org-btn-accent"
            onClick={() => onAnnotateThese(data.noFranchise.map(m => m.id), `${data.noFranchise.length} unfranchised models`)}>
            ✦ Annotate These
          </button>
        </div>
      );
    }
    if (activeSection === 'noTags' && data.noTags.length > 0 && onAnnotateThese) {
      return (
        <div className="org-section-actions">
          <span className="org-hint-inline">{data.noTags.length} models without tags</span>
          <button className="org-btn org-btn-sm org-btn-accent"
            onClick={() => onAnnotateThese(data.noTags.map(m => m.id), `${data.noTags.length} untagged models`)}>
            ✦ Annotate These
          </button>
        </div>
      );
    }
    if (activeSection === 'noThumbnail' && data.noThumbnail.length > 0) {
      return (
        <div className="org-section-actions">
          <span className="org-hint-inline">{data.noThumbnail.length} models missing thumbnails</span>
          <button className="org-btn org-btn-sm org-btn-blue" onClick={fixThumbnails} disabled={thumbFixing}>
            {thumbFixing ? '⏳' : '🖼'} Auto-Fix + Extract
          </button>
          {thumbResult && <span className="org-ok-text">{thumbResult}</span>}
        </div>
      );
    }
    if (activeSection === 'integrity') {
      return (
        <div className="org-section-actions">
          <button className="org-btn org-btn-sm org-btn-blue" onClick={runIntegrity} disabled={integrityLoading}>
            {integrityLoading ? '⏳ Checking…' : '↻ Re-run Check'}
          </button>
        </div>
      );
    }
    return null;
  }

  function renderSection() {
    if (!data) return null;
    switch (activeSection) {
      case 'crossCreator': {
        const groups = (data.crossCreatorDupes || []).filter(g => !resolvedKeys.has(`xc-${g.key}`));
        return groups.length === 0
          ? <div className="org-empty">No cross-creator duplicates to resolve 🎉</div>
          : groups.map(g => (
            <DupGroup key={`xc-${g.key}`} groupKey={`xc-${g.key}`} models={g.models} libraryPath={libraryPath}
              busy={resolvingKey === `xc-${g.key}`} onResolve={resolveDup}
              label={`"${g.key}" — ${g.models.length} copies across ${new Set(g.models.map(m => m.creator_name)).size} creators`} />
          ));
      }
      case 'duplicates': {
        const pairs = (data.duplicates || []).filter(p => !resolvedKeys.has(`dup-${p.a.id}-${p.b.id}`));
        return pairs.length === 0
          ? <div className="org-empty">No similar-name pairs to resolve 🎉</div>
          : pairs.map(p => (
            <DupGroup key={`dup-${p.a.id}-${p.b.id}`} groupKey={`dup-${p.a.id}-${p.b.id}`} models={[p.a, p.b]} libraryPath={libraryPath}
              busy={resolvingKey === `dup-${p.a.id}-${p.b.id}`} onResolve={resolveDup}
              label={`${Math.round(p.score * 100)}% similar`} />
          ));
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
            </div>
            {integrityData.missingFolders.map(m => (
              <ModelRow key={m.id} m={m} extra={folderExtra(m)} onHide={hideOne} />
            ))}
          </>);
      case 'emptyFolders':
        return data.emptyFolders.length === 0
          ? <div className="org-empty">No empty folders 🎉</div>
          : data.emptyFolders.map(m => <ModelRow key={m.id} m={m} extra={`${folderExtra(m) || ''} · ${m.file_count || 0} files`} onHide={hideOne} />);
      case 'noThumbnail':
        return data.noThumbnail.length === 0
          ? <div className="org-empty">All models have thumbnails 🎉</div>
          : data.noThumbnail.map(m => <ModelRow key={m.id} m={m} extra={folderExtra(m)} />);
      case 'noTags':
        return data.noTags.length === 0
          ? <div className="org-empty">All models have tags 🎉</div>
          : data.noTags.map(m => <ModelRow key={m.id} m={m} extra={folderExtra(m)} />);
      case 'noFranchise':
        return data.noFranchise.length === 0
          ? <div className="org-empty">All models have a franchise 🎉</div>
          : data.noFranchise.map(m => <ModelRow key={m.id} m={m} extra={folderExtra(m)} />);
      case 'noSource':
        return data.noSource.length === 0
          ? <div className="org-empty">All models have a source URL 🎉</div>
          : data.noSource.map(m => <ModelRow key={m.id} m={m} extra={folderExtra(m)} />);
      default: return null;
    }
  }

  return (
    <div className="org-tab-body">
      {confirmUi}
      <p className="org-desc">
        Scan your library for issues. Use the quick-fix buttons to jump directly to action.
      </p>

      <button className="org-btn org-btn-secondary" onClick={run} disabled={loading} style={{ marginBottom: 12 }}>
        {loading ? '⏳ Scanning…' : '↻ Refresh'}
      </button>

      {error && <div className="org-error">{error}</div>}

      {data && (
        <>
          <div className="org-health-summary">
            <div className="org-health-stat"><span className="org-health-stat-num">{data.summary.total}</span><span>Total</span></div>
            <button className="org-health-stat org-health-warn" onClick={() => setActiveSection('crossCreator')}>
              <span className="org-health-stat-num org-num-blue">{data.summary.crossCreatorDupes ?? 0}</span><span>X-Dupes</span>
            </button>
            <button className="org-health-stat org-health-warn" onClick={() => setActiveSection('duplicates')}><span className="org-health-stat-num">{data.summary.duplicatePairs}</span><span>Similar</span></button>
            <button className="org-health-stat org-health-warn" onClick={() => setActiveSection('noTags')}><span className="org-health-stat-num">{data.summary.noTags}</span><span>No Tags</span></button>
            <button className="org-health-stat org-health-warn" onClick={() => setActiveSection('noThumbnail')}><span className="org-health-stat-num">{data.summary.noThumbnail}</span><span>No Thumb</span></button>
            <button className="org-health-stat org-health-warn" onClick={() => setActiveSection('noFranchise')}><span className="org-health-stat-num">{data.summary.noFranchise}</span><span>No Franchise</span></button>
          </div>

          <div className="org-health-sections" role="tablist" aria-label="Health checks">
            {sections.map(s => (
              <button key={s.id} role="tab" aria-selected={activeSection === s.id}
                className={`org-health-section-btn ${activeSection === s.id ? 'active' : ''}`}
                onClick={() => setActiveSection(s.id)}>
                {s.icon} {s.label}
                <span className={`org-health-badge ${s.count > 0 ? 'warn' : 'ok'}`}>{s.count ?? '…'}</span>
              </button>
            ))}
          </div>

          {renderSectionActions()}

          <div className="org-health-list">
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

// ── Franchise Browser tab ─────────────────────────────────────────────────────

function FranchiseTab({ onAnnotateThese }) {
  const [confirmUi, askConfirm] = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [franchiseInput, setFranchiseInput] = useState('');
  const [filterText, setFilterText] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState('');
  const [expanded, setExpanded] = useState(new Set(['__unassigned__']));

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setData(await apiGet('/api/organize/franchise-browser'));
    } catch (e) { setError(errorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (key) =>
    setExpanded(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleModel = (id) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectGroup = (models) =>
    setSelected(s => new Set([...s, ...models.map(m => m.id)]));

  const applyFranchise = async () => {
    if (!selected.size || !franchiseInput.trim()) return;
    // Reassigning models that already have a franchise overwrites it: confirm first
    const all = data ? [...data.unassigned, ...data.franchises.flatMap(f => f.models)] : [];
    const overwriting = all.filter(m => selected.has(m.id) && m.franchise && m.franchise !== franchiseInput.trim()).length;
    if (overwriting > 0) {
      const ok = await askConfirm({
        title: `Reassign ${selected.size} model${selected.size !== 1 ? 's' : ''}?`,
        message: <p>{overwriting} of the selected models already belong to another franchise; they will be moved to <b>{franchiseInput.trim()}</b>.</p>,
        confirmLabel: `Assign to ${selected.size}`,
      });
      if (!ok) return;
    }
    setApplying(true); setError(''); setResult('');
    try {
      const d = await apiSend('/api/organize/bulk-update', 'POST', { modelIds: [...selected], franchise: franchiseInput.trim() });
      setResult(`✓ Assigned "${franchiseInput.trim()}" to ${d.updated} model${d.updated !== 1 ? 's' : ''}`);
      setSelected(new Set()); setFranchiseInput(''); load();
    } catch (e) { setError(e.message); }
    setApplying(false);
  };

  const filter = filterText.toLowerCase();
  const filterModels = (mods) => !filter ? mods
    : mods.filter(m => m.name.toLowerCase().includes(filter) || (m.creator_name || '').toLowerCase().includes(filter));

  // Plain render helpers (not nested components) so rows aren't remounted —
  // and their thumbnails re-fetched — every time the selection changes.
  function renderModelRow(m) {
    const isSel = selected.has(m.id);
    return (
      <div key={m.id} className={`org-franchise-model${isSel ? ' selected' : ''}`} onClick={() => toggleModel(m.id)}
        role="checkbox" aria-checked={isSel} tabIndex={0}
        onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleModel(m.id); } }}>
        <span className="org-franchise-check" aria-hidden="true">{isSel ? '☑' : '☐'}</span>
        {m.thumbnail_path
          ? <img src={m.thumbnail_path} className="org-franchise-thumb" alt="" loading="lazy" />
          : <span className="org-franchise-thumb-ph">🧩</span>}
        <span className="org-franchise-model-name">{m.name}</span>
        <span className="org-franchise-model-creator">{m.creator_name}</span>
      </div>
    );
  }

  function renderGroup({ groupKey, label, models, warn }) {
    const filtered = filterModels(models);
    if (filter && !filtered.length) return null;
    const isOpen = expanded.has(groupKey);
    return (
      <div className="org-franchise-group" key={groupKey}>
        <div className="org-franchise-header" onClick={() => toggleExpand(groupKey)}
          role="button" tabIndex={0} aria-expanded={isOpen}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleExpand(groupKey); } }}>
          <span className={warn ? 'org-franchise-label warn' : 'org-franchise-label'}>{label}</span>
          <span className={`org-franchise-count ${warn ? 'warn' : ''}`}>
            {models.length}
          </span>
          <button className="org-btn org-btn-sm" style={{ marginLeft: 'auto', marginRight: 6, fontSize: 9 }}
            onClick={e => { e.stopPropagation(); selectGroup(filtered); }}>
            + Select all
          </button>
          {onAnnotateThese && groupKey === '__unassigned__' && (
            <button className="org-btn org-btn-sm" style={{ marginRight: 6, fontSize: 9, color: 'var(--accent)', borderColor: 'var(--accent)' }}
              onClick={e => { e.stopPropagation(); onAnnotateThese(filtered.map(m => m.id), `${filtered.length} unassigned models`); }}>
              ✦ Annotate
            </button>
          )}
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{isOpen ? '▾' : '▸'}</span>
        </div>
        {isOpen && (
          <div>
            {filtered.slice(0, 60).map(renderModelRow)}
            {filtered.length > 60 && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 12px' }}>
                +{filtered.length - 60} more — use filter to narrow down
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="org-tab-body" style={{ paddingBottom: selected.size ? 60 : 0 }}>
      {confirmUi}
      <p className="org-desc">
        Browse models by franchise. Select unassigned models and bulk-assign them, or select across franchises to reassign.
      </p>

      {data && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Total <b style={{ color: 'var(--text)' }}>{data.total}</b></span>
          <span style={{ color: 'var(--red-text)' }}>Unassigned <b>{data.unassigned.length}</b></span>
          <span style={{ color: 'var(--green-text)' }}>Franchises <b>{data.franchises.length}</b></span>
          <button className="org-btn org-btn-sm" style={{ marginLeft: 'auto' }} onClick={load}>↻ Refresh</button>
        </div>
      )}

      <input className="org-select" placeholder="Filter by model name or creator…" aria-label="Filter by model name or creator" value={filterText}
        onChange={e => setFilterText(e.target.value)}
        style={{ marginBottom: 10, fontFamily: 'var(--font-mono)', fontSize: 11 }} />

      {error && <div className="org-error">{error}</div>}
      {loading && <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: 8 }}>⏳ Loading…</div>}

      {data && (
        <div className="org-franchise-list">
          {/* Unassigned always first */}
          {data.unassigned.length > 0 && renderGroup({ groupKey: '__unassigned__', label: '⚠ Unassigned', models: data.unassigned, warn: true })}
          {data.franchises.map(f => renderGroup({ groupKey: f.name, label: f.name, models: f.models }))}
          {data.total === 0 && <div className="org-empty">No models found</div>}
        </div>
      )}

      {result && <div className="org-success-box" style={{ marginTop: 8 }}>{result}</div>}

      {/* Sticky action bar */}
      {selected.size > 0 && (
        <div className="org-franchise-actions">
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{selected.size} selected</span>
          <input className="org-select" placeholder="Franchise name…" aria-label="Franchise name to assign" value={franchiseInput}
            onChange={e => setFranchiseInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyFranchise(); }}
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          <button className="org-btn org-btn-success" onClick={applyFranchise}
            disabled={applying || !franchiseInput.trim()}>
            {applying ? '⏳' : '✓'} Assign
          </button>
          <button className="org-btn org-btn-sm org-btn-danger" onClick={() => setSelected(new Set())}
            aria-label="Clear selection">✕</button>
        </div>
      )}
    </div>
  );
}

// ── Batch Actions tab ─────────────────────────────────────────────────────────

// Module scope: a component defined inside BatchTab would remount its children
// (and drop input focus) on every keystroke.
function Section({ title, children }) {
  return (
    <div className="org-batch-section">
      <div className="org-batch-section-title">{title}</div>
      {children}
    </div>
  );
}

function BatchTab() {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [creators, setCreators] = useState([]);
  const [thumbStats, setThumbStats] = useState(null);
  // Bulk tag/franchise
  const [bulkCreatorId, setBulkCreatorId] = useState('');
  const [bulkFranchise, setBulkFranchise] = useState('');
  const [bulkTags, setBulkTags] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkResult, setBulkResult] = useState('');
  // Creator merge
  const [srcCreator, setSrcCreator] = useState('');
  const [dstCreator, setDstCreator] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState('');
  // Thumbnails
  const [thumbFixing, setThumbFixing] = useState(false);
  const [thumbResult, setThumbResult] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/creators').then(r => r.json()).then(setCreators).catch(() => {});
    fetch('/api/organize/thumbnail-stats').then(r => r.json()).then(setThumbStats).catch(() => {});
  }, []);

  const applyBulk = async () => {
    if (!bulkCreatorId) { setError('Select a creator first'); return; }
    const tags = bulkTags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!bulkFranchise && !tags.length) { setError('Enter a franchise and/or tags to apply'); return; }
    const creator = creators.find(c => String(c.id) === String(bulkCreatorId));
    const n = creator?.model_count ?? 0;
    const ok = await askConfirm({
      title: `Update all ${n} model${n !== 1 ? 's' : ''} by ${creator?.name || 'this creator'}?`,
      message: (
        <>
          {bulkFranchise.trim() && <p>Every model's franchise will be set to <b>{bulkFranchise.trim()}</b>, replacing any franchise already assigned.</p>}
          {tags.length > 0 && <p>Tags added: <b>{tags.join(', ')}</b> (existing tags are kept).</p>}
        </>
      ),
      confirmLabel: `Apply to ${n} model${n !== 1 ? 's' : ''}`,
      danger: !!bulkFranchise.trim(),
    });
    if (!ok) return;
    setBulkApplying(true); setError(''); setBulkResult('');
    try {
      const body = { creatorId: parseInt(bulkCreatorId, 10) };
      if (bulkFranchise) body.franchise = bulkFranchise.trim();
      if (tags.length) body.tags = tags;
      const d = await apiSend('/api/organize/bulk-update', 'POST', body);
      setBulkResult(`✓ Updated ${d.updated} of ${d.total} models`);
    } catch (e) { setError(errorMessage(e)); notify(`Bulk update failed: ${errorMessage(e)}`); }
    setBulkApplying(false);
  };

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
      fetch('/api/creators').then(r => r.json()).then(setCreators).catch(() => {});
    } catch (e) { setError(errorMessage(e)); notify(`Merge failed: ${errorMessage(e)}`); }
    setMerging(false);
  };

  const fixThumbnails = async () => {
    setThumbFixing(true); setError(''); setThumbResult('');
    try {
      const d = await apiSend('/api/organize/fix-thumbnails', 'POST');
      setThumbResult(`✓ Fixed ${d.fixed} thumbnails from existing images`);
      fetch('/api/organize/thumbnail-stats').then(r => r.json()).then(setThumbStats).catch(() => {});
    } catch (e) { setError(errorMessage(e)); }
    setThumbFixing(false);
  };

  return (
    <div className="org-tab-body">
      {confirmUi}
      <p className="org-desc">
        Bulk operations: apply franchise and tags to an entire creator's library, merge duplicate creators, and fix missing thumbnails.
      </p>

      {error && <div className="org-error">{error}</div>}

      {/* Bulk apply to creator */}
      <Section title="⚡ Bulk Apply to Creator">
        <div className="org-row">
          <label className="org-label" htmlFor="bulk-creator">Creator</label>
          <select id="bulk-creator" className="org-select" value={bulkCreatorId} onChange={e => setBulkCreatorId(e.target.value)}>
            <option value="">Select creator…</option>
            {creators.map(c => <option key={c.id} value={c.id}>{c.name} ({c.model_count} models)</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="org-row" style={{ marginBottom: 0 }}>
            <label className="org-label" htmlFor="bulk-franchise">Set franchise (optional)</label>
            <input id="bulk-franchise" className="org-select" placeholder="e.g. Marvel" value={bulkFranchise}
              onChange={e => setBulkFranchise(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          </div>
          <div className="org-row" style={{ marginBottom: 0 }}>
            <label className="org-label" htmlFor="bulk-tags">Add tags (comma-separated, optional)</label>
            <input id="bulk-tags" className="org-select" placeholder="e.g. 28mm, resin, presupported" value={bulkTags}
              onChange={e => setBulkTags(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          </div>
        </div>
        <button className="org-btn org-btn-primary" onClick={applyBulk} disabled={bulkApplying || !bulkCreatorId} style={{ marginTop: 10 }}>
          {bulkApplying ? '⏳ Applying…' : '⚡ Apply to All Models'}
        </button>
        {bulkResult && <div className="org-success-box" style={{ marginTop: 6 }}>{bulkResult}</div>}
      </Section>

      {/* Fix thumbnails */}
      <Section title="🖼 Fix Missing Thumbnails">
        {thumbStats ? (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, marginBottom: 10 }}>
            <span style={{ color: 'var(--text-muted)' }}>No thumbnail: <b style={{ color: 'var(--red-text)' }}>{thumbStats.noThumb}</b></span>
            <span style={{ color: 'var(--text-muted)' }}>Auto-fixable: <b style={{ color: 'var(--green-text)' }}>{thumbStats.fixable}</b></span>
            <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>(have images already extracted, just need linking)</span>
          </div>
        ) : (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, marginBottom: 10 }}>Loading stats…</div>
        )}
        <button className="org-btn org-btn-secondary" onClick={fixThumbnails}
          disabled={thumbFixing || (thumbStats && thumbStats.fixable === 0)}>
          {thumbFixing ? '⏳ Fixing…' : `🖼 Auto-Fix ${thumbStats?.fixable ?? '…'} Thumbnails`}
        </button>
        {thumbResult && <div className="org-success-box" style={{ marginTop: 6 }}>{thumbResult}</div>}
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
          For models with no images at all, use the ZIP extractor in the model detail view.
        </div>
      </Section>

      {/* Creator merge */}
      <Section title="🔀 Merge Creators">
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
              {creators.filter(c => c.id !== parseInt(srcCreator)).map(c => (
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
    </div>
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

// Advanced — less-used tools grouped under one tab with secondary sub-tabs,
// so the top level stays uncluttered.
function AdvancedTab({ libraryWritable }) {
  const [sub, setSub] = useState('batch');
  const subTabs = [
    { id: 'batch',  label: 'Bulk & Merge',       icon: '⚡' },
    { id: 'roles',  label: 'Folder Roles',       icon: '🗃' },
    { id: 'gaps',   label: 'Gap Analysis',       icon: '🔍' },
    { id: 'unpack', label: 'Unpack Loose Files', icon: '📦' },
  ];
  return (
    <div>
      <div style={{ padding: '8px 16px 0' }}>
        <TabBar tabs={subTabs} active={sub} onChange={setSub} label="Advanced tools" />
      </div>
      {sub === 'batch'  && <BatchTab />}
      {sub === 'roles'  && <FolderRoles />}
      {sub === 'gaps'   && <GapTab />}
      {sub === 'unpack' && <LooseTab libraryWritable={libraryWritable} />}
    </div>
  );
}

const TABS = [
  { id: 'annotate',  label: 'Annotate',  icon: '✦' },
  { id: 'health',    label: 'Health',    icon: '⚕' },
  { id: 'franchise', label: 'Franchise', icon: '🗂' },
  { id: 'advanced',  label: 'Advanced',  icon: '⚙' },
];

export default function OrganizeModal({ onClose, libraryWritable, libraryPath }) {
  const titleId = useUniqueId('org-title');
  const [tab, setTab] = useState('annotate');
  // Shared target for health → annotate "Annotate These" flow
  const [annotateTarget, setAnnotateTarget] = useState(null); // { modelIds, label }

  const handleAnnotateThese = useCallback((modelIds, label) => {
    setAnnotateTarget({ modelIds, label });
    setTab('annotate');
  }, []);

  return (
    <Modal onClose={onClose} labelledBy={titleId} overlayClassName="organize-overlay" className="organize-modal">
      <div className="org-header">
        <div>
          <div className="org-title" id={titleId}>🗂 ORGANIZE LIBRARY</div>
          <div className="org-subtitle">Annotate with AI · Health & fixes · Franchises · Advanced tools</div>
        </div>
        <button className="org-close" onClick={onClose} aria-label="Close Organize Library">✕</button>
      </div>

      {libraryWritable === false && (
        <div className="org-readonly-banner" role="note">🔒 {READ_ONLY_TIP}: tools that would move files generate a script for you to run instead.</div>
      )}

      <TabBar tabs={TABS} active={tab} onChange={setTab} label="Organize sections" />

      {tab === 'annotate'  && <AnnotateTab target={annotateTarget} onClearTarget={() => setAnnotateTarget(null)} />}
      {tab === 'health'    && <HealthTab onAnnotateThese={handleAnnotateThese} libraryPath={libraryPath} />}
      {tab === 'franchise' && <FranchiseTab onAnnotateThese={handleAnnotateThese} />}
      {tab === 'advanced'  && <AdvancedTab libraryWritable={libraryWritable} />}
    </Modal>
  );
}
