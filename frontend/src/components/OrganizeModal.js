import React, { useState, useRef, useEffect, useCallback } from 'react';

// ── shared helpers ────────────────────────────────────────────────────────────

function getApiKey() {
  return localStorage.getItem('claude_api_key') || '';
}

function ModalOverlay({ onClose, children }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="organize-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="organize-modal">
        {children}
      </div>
    </div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="org-tabs">
      {tabs.map(t => (
        <button
          key={t.id}
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

function AnnotateTab() {
  const [creator, setCreator] = useState('');
  const [creators, setCreators] = useState([]);
  const [running, setRunning] = useState(false);
  const [directives, setDirectives] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [error, setError] = useState('');
  const esRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    fetch('/api/creators').then(r => r.json()).then(setCreators).catch(() => {});
  }, []);

  // Auto-scroll directive list
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [directives.length]);

  const run = useCallback(async () => {
    const apiKey = getApiKey();
    if (!apiKey) { setError('No Claude API key — set it in Settings first'); return; }

    setError('');
    setDirectives([]);
    setSelected(new Set());
    setPreview(null);
    setApplyResult(null);
    setRunning(true);

    if (esRef.current) esRef.current.close();

    try {
      const res = await fetch('/api/organize/auto-annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-key': apiKey },
        body: JSON.stringify({ creator: creator || undefined }),
      });

      if (!res.ok) { setError(`Error ${res.status}: ${await res.text()}`); setRunning(false); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

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
              setDirectives(d => [...d, ev.text]);
            } else if (ev.type === 'done') {
              setRunning(false);
            } else if (ev.type === 'error') {
              setError(ev.message);
              setRunning(false);
            }
          } catch {}
        }
      }
    } catch (e) {
      setError(e.message);
    }
    setRunning(false);
  }, [creator]);

  const selectAll = () => setSelected(new Set(directives.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());
  const toggleOne = (i) => setSelected(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const previewSelected = useCallback(async () => {
    const chosen = directives.filter((_, i) => selected.has(i));
    if (!chosen.length) { setError('Select at least one directive'); return; }
    setError('');
    const res = await fetch('/api/organize/annotate/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directives: chosen }),
    });
    const data = await res.json();
    setPreview(data);
  }, [directives, selected]);

  const applySelected = useCallback(async () => {
    if (!preview) return;
    setApplying(true);
    setError('');
    const chosen = directives.filter((_, i) => selected.has(i));
    const res = await fetch('/api/organize/annotate/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directives: chosen }),
    });
    const data = await res.json();
    setApplyResult(data);
    setApplying(false);
    setPreview(null);
  }, [directives, selected, preview]);

  const typeColor = { FRANCHISE: '#c17f3a', RENAME: '#5b9bd5', MERGE: '#9b72cf', TAG: '#4caf7d' };

  function directiveType(line) {
    const m = line.match(/^(FRANCHISE|RENAME|MERGE|TAG):/i);
    return m ? m[1].toUpperCase() : 'OTHER';
  }

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Generate Claude AI directives to franchise-tag, rename, merge, and tag your entire library — then apply selectively.
      </p>

      <div className="org-row">
        <label className="org-label">Filter by creator (optional)</label>
        <select className="org-select" value={creator} onChange={e => setCreator(e.target.value)}>
          <option value="">All creators</option>
          {creators.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
      </div>

      <button className="org-btn org-btn-primary" onClick={run} disabled={running}>
        {running ? '⏳ Generating directives…' : '✦ Generate Directives with AI'}
      </button>

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
                const byType = t => directives.filter(d => directiveType(d) === t).map((_, i) => directives.indexOf(directives.filter(d => directiveType(d) === t)[i]));
                // Toggle only FRANCHISE + TAG
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
                  className={`org-directive ${selected.has(i) ? 'selected' : ''}`}
                  onClick={() => toggleOne(i)}
                >
                  <span className="org-directive-check">{selected.has(i) ? '☑' : '☐'}</span>
                  <span className="org-directive-type" style={{ color: typeColor[type] || '#888' }}>{type}</span>
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
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid #2a2a35', fontSize: 11 }}>
                {Object.entries(preview.stats.byType).map(([type, count]) => (
                  <span key={type} style={{ color: typeColor[type] || '#888' }}>{type}: {count}</span>
                ))}
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', padding: '8px 12px' }}>
                {preview.changes.map((c, i) => (
                  <div key={i} style={{ fontSize: 11, padding: '3px 0', borderBottom: '1px solid #18181f', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: typeColor[c.type] || '#888', minWidth: 70, fontSize: 10 }}>{c.type}</span>
                    <span style={{ color: c.found ? 'var(--text-main)' : 'var(--text-faint)', flex: 1 }}>
                      {c.type === 'FRANCHISE' && `${c.modelName} → franchise: ${c.franchise}`}
                      {c.type === 'RENAME' && `${c.oldName} → ${c.newName}`}
                      {c.type === 'TAG' && `${c.modelName}: ${(c.tags || []).join(', ')}`}
                      {c.type === 'MERGE' && `${c.srcName} → ${c.targetName} (advisory)`}
                    </span>
                    {!c.found && <span style={{ color: '#cf7272', fontSize: 10 }}>NOT FOUND</span>}
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

function HealthTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState('duplicates');

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/organize/health');
      if (!res.ok) { setError(`Error ${res.status}`); setLoading(false); return; }
      setData(await res.json());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { run(); }, [run]);

  const sections = [
    { id: 'duplicates',  label: 'Duplicates',    icon: '⧉', count: data?.summary?.duplicatePairs },
    { id: 'emptyFolders',label: 'Empty Folders', icon: '📂', count: data?.summary?.emptyFolders },
    { id: 'noThumbnail', label: 'No Thumbnail',  icon: '🖼', count: data?.summary?.noThumbnail },
    { id: 'noTags',      label: 'No Tags',        icon: '🏷', count: data?.summary?.noTags },
    { id: 'noFranchise', label: 'No Franchise',   icon: '🗂', count: data?.summary?.noFranchise },
    { id: 'noSource',    label: 'No Source URL',  icon: '🔗', count: data?.summary?.noSource },
  ];

  function ModelRow({ m, extra }) {
    return (
      <div className="org-health-row">
        <div className="org-health-name">{m.name}</div>
        {m.creator_name && <div className="org-health-creator">{m.creator_name}</div>}
        {extra && <div className="org-health-extra">{extra}</div>}
      </div>
    );
  }

  function renderSection() {
    if (!data) return null;
    switch (activeSection) {
      case 'duplicates':
        return data.duplicates.length === 0
          ? <div className="org-empty">No duplicate pairs found 🎉</div>
          : data.duplicates.map((pair, i) => (
            <div key={i} className="org-dupe-pair">
              <div className="org-dupe-score">{Math.round(pair.score * 100)}% similar</div>
              <ModelRow m={pair.a} />
              <div style={{ color: 'var(--text-faint)', fontSize: 11, padding: '0 12px' }}>vs</div>
              <ModelRow m={pair.b} />
            </div>
          ));
      case 'emptyFolders':
        return data.emptyFolders.length === 0
          ? <div className="org-empty">No empty folders 🎉</div>
          : data.emptyFolders.map((m, i) => <ModelRow key={i} m={m} extra={`${m.file_count} files`} />);
      case 'noThumbnail':
        return data.noThumbnail.length === 0
          ? <div className="org-empty">All models have thumbnails 🎉</div>
          : data.noThumbnail.map((m, i) => <ModelRow key={i} m={m} />);
      case 'noTags':
        return data.noTags.length === 0
          ? <div className="org-empty">All models have tags 🎉</div>
          : data.noTags.map((m, i) => <ModelRow key={i} m={m} />);
      case 'noFranchise':
        return data.noFranchise.length === 0
          ? <div className="org-empty">All models have a franchise 🎉</div>
          : data.noFranchise.map((m, i) => <ModelRow key={i} m={m} />);
      case 'noSource':
        return data.noSource.length === 0
          ? <div className="org-empty">All models have a source URL 🎉</div>
          : data.noSource.map((m, i) => <ModelRow key={i} m={m} />);
      default: return null;
    }
  }

  return (
    <div className="org-tab-body">
      <p className="org-desc">
        Scan your library for issues: duplicate models, missing thumbnails, empty folders, and untagged entries.
      </p>

      <button className="org-btn org-btn-secondary" onClick={run} disabled={loading} style={{ marginBottom: 12 }}>
        {loading ? '⏳ Scanning…' : '↻ Refresh'}
      </button>

      {error && <div className="org-error">{error}</div>}

      {data && (
        <>
          <div className="org-health-summary">
            <div className="org-health-stat"><span className="org-health-stat-num">{data.summary.total}</span><span>Total</span></div>
            <div className="org-health-stat org-health-warn"><span className="org-health-stat-num">{data.summary.duplicatePairs}</span><span>Dupes</span></div>
            <div className="org-health-stat org-health-warn"><span className="org-health-stat-num">{data.summary.noTags}</span><span>No Tags</span></div>
            <div className="org-health-stat org-health-warn"><span className="org-health-stat-num">{data.summary.noThumbnail}</span><span>No Thumb</span></div>
            <div className="org-health-stat org-health-warn"><span className="org-health-stat-num">{data.summary.noFranchise}</span><span>No Franchise</span></div>
          </div>

          <div className="org-health-sections">
            {sections.map(s => (
              <button
                key={s.id}
                className={`org-health-section-btn ${activeSection === s.id ? 'active' : ''}`}
                onClick={() => setActiveSection(s.id)}
              >
                {s.icon} {s.label}
                <span className={`org-health-badge ${s.count > 0 ? 'warn' : 'ok'}`}>{s.count ?? '…'}</span>
              </button>
            ))}
          </div>

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
        <label className="org-label">Gumroad CSV or model name list</label>
        <textarea
          className="org-textarea"
          rows={6}
          placeholder={'Paste CSV here — or one model name per line...\n\nCSV: must have a "Model Name" or "Name" column header\nPlain list: one name per line'}
          value={csv}
          onChange={e => setCsv(e.target.value)}
        />
      </div>

      <div className="org-row org-row-inline">
        <label className="org-label" style={{ marginBottom: 0 }}>Match threshold</label>
        <input
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
            <span style={{ color: '#cf7272' }}>Missing: <b>{result.stats.missing}</b></span>
            <span style={{ color: '#4caf7d' }}>Present: <b>{result.stats.present}</b></span>
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

// ── Main OrganizeModal ────────────────────────────────────────────────────────

const TABS = [
  { id: 'annotate', label: 'Annotate', icon: '✦' },
  { id: 'health',   label: 'Health',   icon: '⚕' },
  { id: 'gaps',     label: 'Gap Analysis', icon: '🔍' },
];

export default function OrganizeModal({ onClose }) {
  const [tab, setTab] = useState('annotate');

  return (
    <ModalOverlay onClose={onClose}>
      <div className="org-header">
        <div>
          <div className="org-title">🗂 ORGANIZE LIBRARY</div>
          <div className="org-subtitle">AI-powered annotation · Health scan · Gap analysis</div>
        </div>
        <button className="org-close" onClick={onClose}>✕</button>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'annotate' && <AnnotateTab />}
      {tab === 'health'   && <HealthTab />}
      {tab === 'gaps'     && <GapTab />}
    </ModalOverlay>
  );
}
