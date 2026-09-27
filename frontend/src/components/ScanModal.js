import React, { useState, useEffect, useRef, useCallback } from 'react';
import TaskLog from './TaskLog';
import Modal, { useUniqueId } from './Modal';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_MAX_TRIES = 12;
const now = () => new Date().toISOString();

async function fetchScanStatus(timeoutMs = 5000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => controller && controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/scan/status', controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export default function ScanModal({ onClose, onScanComplete }) {
  const [path, setPath] = useState('/library');
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState(null);
  const [lines, setLines] = useState([]);
  const [checking, setChecking] = useState(true); // loading state while checking scan status
  const [roots, setRoots] = useState(null); // mounted library roots (read-only)
  const [libraryPath, setLibraryPath] = useState(''); // backend LIBRARY_PATH (scan-everything target)
  const [rootFilter, setRootFilter] = useState('');
  const [aiModel, setAiModel] = useState(() => localStorage.getItem('vault_ai_model') || '');
  const [aiModels, setAiModels] = useState([]);
  const [estimate, setEstimate] = useState(null);
  const [visionTagging, setVisionTagging] = useState(false);
  const visionEsRef = useRef(null);
  const [tagging, setTagging] = useState(false);
  const [, setTagResult] = useState(null);
  const [findingImages, setFindingImages] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('claude_api_key') || '');
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState(null); // null | 'ok' | 'error'
  const esRef = useRef(null);
  const imgEsRef = useRef(null);

  const [reconnecting, setReconnecting] = useState(false);
  const reconnectTimer = useRef(null);
  const reconnectTries = useRef(0);
  const replaceOnNext = useRef(false); // server replays the whole log on reconnect
  const unmounted = useRef(false);
  const onScanCompleteRef = useRef(onScanComplete);
  onScanCompleteRef.current = onScanComplete;
  const titleId = useUniqueId('scan-title');

  // Connect (or reconnect) to the SSE stream. If the stream drops while a scan
  // is still running, poll /api/scan/status and reconnect with backoff; the
  // server replays the log to late joiners, so the view catches up.
  const connectToStream = useCallback(function connect() {
    if (esRef.current) esRef.current.close();
    clearTimeout(reconnectTimer.current);

    const es = new EventSource('/api/scan/stream');
    esRef.current = es;

    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      reconnectTries.current = 0;
      setReconnecting(false);
      if (data.type === 'done') {
        replaceOnNext.current = false;
        setSummary(data);
        setDone(true);
        setRunning(false);
        es.close();
        if (onScanCompleteRef.current) onScanCompleteRef.current();
      } else if (data.type === 'idle') {
        // No scan running and no results — just close stream
        replaceOnNext.current = false;
        es.close();
        setRunning(false);
      } else if (replaceOnNext.current) {
        replaceOnNext.current = false;
        setLines([data]);
      } else {
        setLines(l => [...l, data]);
      }
    };

    es.onerror = async () => {
      es.close();
      if (esRef.current !== es || unmounted.current) return;
      let status = null;
      try { status = await fetchScanStatus(); } catch { status = null; }
      if (unmounted.current || esRef.current !== es) return;

      if (status && !status.inProgress) {
        // Finished while we were disconnected: show the final state
        setReconnecting(false);
        setRunning(false);
        if (status.log) setLines(status.log);
        if (status.summary) {
          setSummary(status.summary);
          setDone(true);
          if (onScanCompleteRef.current) onScanCompleteRef.current();
        }
        return;
      }

      // Still running (or server too busy to answer): reconnect with backoff
      const attempt = ++reconnectTries.current;
      if (attempt > RECONNECT_MAX_TRIES) {
        setReconnecting(false);
        setRunning(false);
        setLines(l => [...l, { level: 'error', msg: 'Lost connection to the scan progress stream. The scan may still be running — reopen this window to check.', ts: now() }]);
        return;
      }
      setRunning(true);
      setReconnecting(true);
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
      reconnectTimer.current = setTimeout(() => {
        if (unmounted.current) return;
        replaceOnNext.current = true;
        connect();
      }, delay);
    };
  }, []);

  useEffect(() => () => { unmounted.current = true; clearTimeout(reconnectTimer.current); }, []);

  // Attach to a scan that is already running (e.g. POST /api/scan returned 409)
  const attachToRunningScan = useCallback(async () => {
    try {
      const status = await fetchScanStatus();
      if (status.log) setLines(status.log);
      if (!status.inProgress) {
        setRunning(false);
        if (status.summary) { setSummary(status.summary); setDone(true); }
        return;
      }
    } catch { /* stream below will retry */ }
    setRunning(true);
    setLines(l => [...l, { level: 'info', msg: 'A scan is already running — showing its progress.', ts: now() }]);
    connectToStream();
  }, [connectToStream]);

  // On mount: check if a scan is already running and reconnect.
  // A scan in progress can keep the server busy, so time the status check out
  // after a few seconds and show the form anyway rather than hanging forever.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch('/api/scan/status', { signal: controller.signal });
        const status = await res.json();
        if (cancelled) return;

        if (status.inProgress) {
          // Scan is running — show existing log and connect to stream
          setRunning(true);
          setLines(status.log || []);
          connectToStream();
        } else if (status.summary?.success !== undefined) {
          // Scan finished before we opened — show results
          setLines(status.log || []);
          setSummary(status.summary);
          setDone(true);
        }
      } catch {
        // Timed out or unreachable (server may be busy scanning). Show the form;
        // try to attach to any running scan's progress stream in the background.
        if (!cancelled) {
          setLines(l => [...l, { level: 'info', msg: 'Could not confirm scan status (the server may be busy). A scan may already be running — its progress will appear below if so.', ts: new Date().toISOString() }]);
          try { connectToStream(); } catch {}
        }
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connectToStream]);

  // Load the list of mounted library roots so the user can pick one to scan
  useEffect(() => {
    fetch('/api/library/roots')
      .then(r => r.json())
      .then(d => {
        setRoots(d.roots || []);
        if (d.libraryPath) {
          setLibraryPath(d.libraryPath);
          // Default the scan target to the real library root (in the native app
          // that's the chosen folder, not "/library").
          setPath(p => (p === '/library' ? d.libraryPath : p));
        }
      })
      .catch(() => setRoots([]));
  }, []);

  // Load available AI models for the tagging model selector
  useEffect(() => {
    fetch('/api/ai/models')
      .then(r => r.json())
      .then(d => { setAiModels(d.models || []); setAiModel(m => m || d.default || ''); })
      .catch(() => {});
  }, []);

  const fetchEstimate = async (vision = false) => {
    const params = new URLSearchParams();
    if (aiModel) params.set('model', aiModel);
    if (vision) params.set('vision', '1');
    try { const r = await fetch(`/api/ai/tag-estimate?${params.toString()}`); setEstimate({ ...(await r.json()), vision }); } catch {}
  };

  const visionTags = (trial = true) => {
    setVisionTagging(true);
    const params = new URLSearchParams();
    if (apiKey) params.set('key', apiKey);
    if (aiModel) params.set('model', aiModel);
    if (!trial) params.set('trial', '0');
    const es = new EventSource(`/api/ai/vision-tags?${params.toString()}`);
    visionEsRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') { setVisionTagging(false); es.close(); if (onScanComplete) onScanComplete(); }
      else setLines(l => [...l, data]);
    };
    es.onerror = () => {
      setLines(l => [...l, { level: 'error', msg: 'Vision tagging connection lost', ts: new Date().toISOString() }]);
      setVisionTagging(false); es.close();
    };
  };

  // Cleanup SSE on unmount
  useEffect(() => () => esRef.current?.close(), []);

  const startScan = async () => {
    setRunning(true);
    setDone(false);
    setSummary(null);
    setLines([]);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, force }),
      });
      if (res.status === 409) {
        await attachToRunningScan();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Scan request failed' }));
        setLines(l => [...l, { level: 'error', msg: err.error || 'Failed to start scan', ts: new Date().toISOString() }]);
        setRunning(false);
        return;
      }
    } catch (e) {
      setLines(l => [...l, { level: 'error', msg: e.message, ts: new Date().toISOString() }]);
      setRunning(false);
      return;
    }

    // Connect to SSE stream for live updates
    connectToStream();
  };

  // Desktop (Tauri) only: native folder picker that sets LIBRARY_PATH and
  // restarts the bundled backend. Hidden in the browser/Docker build.
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;
  const chooseLibraryFolder = async () => {
    try {
      const dir = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: 'Choose your 3D print folder' });
      if (!dir) return;
      await window.__TAURI__.core.invoke('set_library_path', { path: dir });
      setLines(l => [...l, { level: 'info', msg: `Library folder set to ${dir} — restarting indexer…`, ts: new Date().toISOString() }]);
      setTimeout(() => { fetch('/api/library/roots').then(r => r.json()).then(d => setRoots(d.roots || [])).catch(() => {}); }, 1800);
    } catch (e) {
      setLines(l => [...l, { level: 'error', msg: `Folder pick failed: ${e}`, ts: new Date().toISOString() }]);
    }
  };

  const cancelScan = async () => {
    try {
      await fetch('/api/scan/cancel', { method: 'POST' });
      setLines(l => [...l, { level: 'warn', msg: 'Cancelling scan…', ts: new Date().toISOString() }]);
    } catch {}
  };

  const testApiKey = async () => {
    setTestingKey(true);
    setKeyStatus(null);
    try {
      const res = await fetch('/api/ai/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { 'x-claude-key': apiKey }) },
      });
      const data = await res.json();
      if (data.ok) {
        setKeyStatus('ok');
        setLines(l => [...l, { level: 'success', msg: `API key test: ${data.message}`, ts: new Date().toISOString() }]);
      } else {
        setKeyStatus('error');
        setLines(l => [...l, { level: 'error', msg: `API key test failed: ${data.error}`, ts: new Date().toISOString() }]);
      }
    } catch (e) {
      setKeyStatus('error');
      setLines(l => [...l, { level: 'error', msg: `API key test failed: ${e.message}`, ts: new Date().toISOString() }]);
    } finally {
      setTestingKey(false);
    }
  };

  const tagEsRef = useRef(null);

  const generateTags = () => {
    setTagging(true);
    setTagResult(null);

    const tagParams = new URLSearchParams();
    if (apiKey) tagParams.set('key', apiKey);
    if (aiModel) tagParams.set('model', aiModel);
    const es = new EventSource(`/api/ai/generate-tags?${tagParams.toString()}`);
    tagEsRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        setTagging(false);
        setTagResult(data);
        es.close();
        if (onScanComplete) onScanComplete(); // refresh gallery
      } else {
        setLines(l => [...l, data]);
      }
    };

    es.onerror = () => {
      setLines(l => [...l, { level: 'error', msg: 'Tag generation connection lost — check the server logs', ts: new Date().toISOString() }]);
      setTagging(false);
      es.close();
    };
  };

  const [imgResult, setImgResult] = useState(null); // stores last find-images result for "continue all"

  const findImages = (trial = true) => {
    setFindingImages(true);
    setImgResult(null);

    const params = new URLSearchParams();
    if (apiKey) params.set('key', apiKey);
    if (!trial) params.set('trial', '0');
    const es = new EventSource(`/api/ai/find-images?${params.toString()}`);
    imgEsRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        setFindingImages(false);
        setImgResult(data);
        es.close();
        if (onScanComplete) onScanComplete();
      } else {
        setLines(l => [...l, data]);
      }
    };

    es.onerror = () => {
      setLines(l => [...l, { level: 'error', msg: 'Image search connection lost', ts: new Date().toISOString() }]);
      setFindingImages(false);
      es.close();
    };
  };

  // Cleanup SSE connections on unmount
  useEffect(() => () => { imgEsRef.current?.close(); tagEsRef.current?.close(); visionEsRef.current?.close(); }, []);

  const busyAi = tagging || findingImages || visionTagging;

  if (checking) {
    return (
      <Modal onClose={onClose} labelledBy={titleId} className="modal modal-wide">
        <div className="modal-title" id={titleId}>SCAN LIBRARY</div>
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          Checking scan status…
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy={titleId} className="modal modal-wide"
      closeOnBackdrop={!busyAi} closeOnEscape={!busyAi}>
        <div className="modal-title" id={titleId}>SCAN LIBRARY</div>
        <div className="modal-subtitle">Index your NAS folder to discover models and extract images</div>
        <div className="modal-hint" style={{ marginTop: 4 }}>
          Scans run on the server — you can close this window and the scan keeps going.
          Reopen Scan Library anytime to check progress. The first scan of a large or
          network (SMB) folder can take a while.
        </div>

        {isTauri && (
          <button className="btn-primary" onClick={chooseLibraryFolder} disabled={running}
            style={{ marginBottom: 10 }}>
            📁 Choose library folder…
          </button>
        )}

        {/* What will be scanned + optional single-folder pick */}
        {roots && (
          <div style={{ marginBottom: 10 }}>
            {roots.length > 0 && (() => {
              const shown = roots.filter(r => r.name.toLowerCase().includes(rootFilter.trim().toLowerCase()));
              const scanningAll = !libraryPath || path === libraryPath;
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1 }}>
                      SCAN A FOLDER ({roots.length})
                    </span>
                    {libraryPath && (
                      <button onClick={() => setPath(libraryPath)} disabled={running}
                        title={`Scan everything under ${libraryPath}`} aria-pressed={scanningAll}
                        className={`root-chip ${scanningAll ? 'active' : ''}`} style={{ fontSize: 11, padding: '3px 9px' }}>
                        ⬚ Entire library
                      </button>
                    )}
                  </div>
                  {roots.length > 10 && (
                    <input className="modal-input" value={rootFilter} onChange={e => setRootFilter(e.target.value)}
                      aria-label="Filter folders" placeholder={`Filter ${roots.length} folders…`} style={{ marginBottom: 6 }} />
                  )}
                  <div className="root-list">
                    {shown.slice(0, 400).map(r => (
                      <button
                        key={r.path}
                        onClick={() => setPath(r.path)}
                        disabled={running || !r.accessible}
                        title={r.accessible ? `Scan only ${r.path}` : `Not readable: ${r.path}`}
                        aria-pressed={path === r.path}
                        className={`root-chip ${path === r.path ? 'active' : ''}`}>
                        <span style={{ opacity: 0.85, flexShrink: 0 }}>{r.accessible ? '🗂' : '⚠'}</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>{r.modelCount}</span>
                      </button>
                    ))}
                    {shown.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)', padding: 4 }}>No folders match "{rootFilter}".</span>}
                  </div>
                  <div className="modal-hint" style={{ marginTop: 5 }}>
                    Defaults to your whole library. Click a folder above to scan just that one.
                  </div>
                </>
              );
            })()}
          </div>
        )}

        <input
          className="modal-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/library"
          disabled={running}
          aria-label="Folder to scan"
          aria-describedby="scan-path-hint"
        />
        <div className="modal-hint" id="scan-path-hint">
          The folder that will be scanned. Set it above, or edit directly.
        </div>

        <label style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
          fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
        }}>
          <input
            type="checkbox"
            checked={force}
            onChange={e => setForce(e.target.checked)}
            disabled={running && !done}
            style={{ accentColor: 'var(--accent)' }}
          />
          Force full rescan (re-index all models, even unchanged ones)
        </label>

        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              className="modal-input"
              style={{ margin: 0, paddingRight: 36, fontSize: 11 }}
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); localStorage.setItem('claude_api_key', e.target.value); }}
              placeholder="sk-ant-... (Claude API key for AI features)"
              aria-label="Claude API key"
              autoComplete="off"
            />
            <button
              onClick={() => setShowKey(s => !s)}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-faint)', fontSize: 13,
              }}
              title={showKey ? 'Hide key' : 'Show key'}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              aria-pressed={showKey}
            >
              {showKey ? '◉' : '○'}
            </button>
          </div>
          {apiKey && (
            <button
              onClick={testApiKey}
              disabled={testingKey}
              className={`key-test-btn ${keyStatus || ''}`}
              title="Test your API key against the Claude API"
            >
              {testingKey ? '…' : keyStatus === 'ok' ? '✓ works' : keyStatus === 'error' ? '✗ failed' : 'Test'}
            </button>
          )}
        </div>
        <div className="modal-hint" style={{ marginTop: 2 }}>
          Required for the AI actions below (marked <b style={{ color: 'var(--accent)' }}>$</b> — they use your Claude API credits). Stored in your browser only.
          {!apiKey && (
            <> Need a key?{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)' }}>Create one at console.anthropic.com</a>.
            </>
          )}
        </div>

        {/* AI model + cost estimate */}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="scan-ai-model" style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1 }}>AI MODEL</label>
          <select
            id="scan-ai-model"
            value={aiModel}
            onChange={e => { setAiModel(e.target.value); localStorage.setItem('vault_ai_model', e.target.value); setEstimate(null); }}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '5px 8px', fontSize: 11, fontFamily: 'var(--font-mono)' }}
          >
            {aiModels.length === 0 && <option value="">(default)</option>}
            {aiModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button onClick={() => fetchEstimate(false)}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)' }}
            title="Rough cost estimate for tagging the whole library">
            Estimate cost
          </button>
          {estimate && (
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
              ~{estimate.models} models{estimate.vision ? ' (vision)' : ''} · <span style={{ color: 'var(--accent)' }}>~${estimate.estCostUsd}</span> <span style={{ color: 'var(--text-faint)' }}>(rough)</span>
            </span>
          )}
        </div>

        {reconnecting && (
          <div className="scan-reconnecting" role="status">
            <span className="spinner" style={{ width: 12, height: 12 }} /> Reconnecting to the running scan…
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <TaskLog lines={lines} running={running} title="SCAN LOG" height={240} />
        </div>

        {done && summary && (
          <div className={`scan-summary ${summary.success ? 'ok' : 'fail'}`} role="status">
            {summary.success
              ? `✓ Complete — ${summary.modelsFound} found · ${summary.modelsAdded} added · ${summary.modelsUpdated} updated · ${summary.modelsSkipped ?? 0} skipped`
              : `✗ Error — ${summary.error}`}
          </div>
        )}

        <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn-cancel" onClick={onClose} disabled={tagging || findingImages || visionTagging}
            title={running ? 'Hide this window — the scan keeps running in the background' : undefined}>
            {running ? '▸ Minimize (keep scanning)' : done ? 'Close' : 'Cancel'}
          </button>
          {running && (
            <button onClick={cancelScan}
              className="btn-cancel btn-stop"
              title="Stop the running scan">
              ■ Stop Scan
            </button>
          )}
          <button className="btn-primary" onClick={() => { setDone(false); startScan(); }} disabled={running || tagging || findingImages || visionTagging}>
            {reconnecting ? 'Reconnecting…' : running ? 'Scanning…' : done ? 'Rescan' : 'Start Scan'}
          </button>
          <button
            onClick={generateTags}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            className="btn-primary btn-ai btn-ai-purple"
            title={apiKey ? 'Uses Claude API credits — auto-generate tags for all models from names, creators, and folder structure' : 'Add a Claude API key above to enable'}
          >
            {tagging ? 'Tagging…' : '$ Generate Tags'}
          </button>
          <button
            onClick={() => visionTags(true)}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            className="btn-primary btn-ai btn-ai-purple"
            title={apiKey ? 'Uses Claude API credits (vision — costs more) — analyses each render image to identify and tag the model' : 'Add a Claude API key above to enable'}
          >
            {visionTagging ? 'Looking…' : '$ 👁 Tags from Images (trial 10)'}
          </button>
          <button
            onClick={() => findImages(true)}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            className="btn-primary btn-ai btn-ai-blue"
            title={apiKey ? 'Uses Claude API credits — finds missing thumbnails online (trial: 10 best candidates first)' : 'Add a Claude API key above to enable'}
          >
            {findingImages ? 'Finding…' : '$ Find Images (trial 10)'}
          </button>
          {imgResult && imgResult.remaining > 0 && (
            <button
              onClick={() => findImages(false)}
              disabled={running || tagging || findingImages || visionTagging || !apiKey}
              className="btn-primary btn-ai btn-ai-blue strong"
              title={apiKey ? `Uses Claude API credits — process all ${imgResult.remaining} remaining models` : 'Add a Claude API key above to enable'}
            >
              $ Continue All ({imgResult.remaining})
            </button>
          )}
          {done && (
            <button className="btn-primary" onClick={onClose}>View Results</button>
          )}
        </div>
    </Modal>
  );
}
