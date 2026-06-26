import React, { useState, useEffect, useRef, useCallback } from 'react';
import TaskLog from './TaskLog';

export default function ScanModal({ onClose, onScanComplete }) {
  const [path, setPath] = useState('/library');
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState(null);
  const [lines, setLines] = useState([]);
  const [checking, setChecking] = useState(true); // loading state while checking scan status
  const [roots, setRoots] = useState(null); // mounted library roots (read-only)
  const [aiModel, setAiModel] = useState(() => localStorage.getItem('vault_ai_model') || '');
  const [aiModels, setAiModels] = useState([]);
  const [estimate, setEstimate] = useState(null);
  const [visionTagging, setVisionTagging] = useState(false);
  const visionEsRef = useRef(null);
  const [tagging, setTagging] = useState(false);
  const [tagResult, setTagResult] = useState(null);
  const [findingImages, setFindingImages] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('claude_api_key') || '');
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState(null); // null | 'ok' | 'error'
  const esRef = useRef(null);
  const imgEsRef = useRef(null);

  // Connect (or reconnect) to the SSE stream
  const connectToStream = useCallback(() => {
    if (esRef.current) esRef.current.close();

    const es = new EventSource('/api/scan/stream');
    esRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        setSummary(data);
        setDone(true);
        setRunning(false);
        es.close();
        if (onScanComplete) onScanComplete();
      } else if (data.type === 'idle') {
        // No scan running and no results — just close stream
        es.close();
        setRunning(false);
      } else {
        setLines(l => [...l, data]);
      }
    };

    es.onerror = () => {
      setLines(l => [...l, { level: 'error', msg: 'Connection lost — scan may still be running.', ts: new Date().toISOString() }]);
      setRunning(false);
      es.close();
    };
  }, [onScanComplete]);

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
      .then(d => setRoots(d.roots || []))
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

  if (checking) {
    return (
      <div className="modal-overlay">
        <div className="modal" style={{ width: 580 }}>
          <div className="modal-title">SCAN LIBRARY</div>
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
            Checking scan status…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal" style={{ width: 580 }}>
        <div className="modal-title">SCAN LIBRARY</div>
        <div className="modal-subtitle">Index your NAS folder to discover models and extract images</div>
        <div className="modal-hint" style={{ marginTop: 4 }}>
          Scans run on the server — you can close this window and the scan keeps going.
          Reopen Scan Library anytime to check progress. The first scan of a large or
          network (SMB) folder can take a while.
        </div>

        {/* Mounted library roots — quick pick */}
        {roots && roots.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1, marginBottom: 5 }}>
              MOUNTED LIBRARY FOLDERS
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {roots.map(r => (
                <button
                  key={r.path}
                  onClick={() => setPath(r.path)}
                  disabled={running || !r.accessible}
                  title={r.accessible ? `Scan ${r.path}` : `Not readable: ${r.path}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: path === r.path ? 'rgba(193,127,58,0.18)' : 'var(--bg3)',
                    border: `1px solid ${path === r.path ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4, padding: '5px 10px', cursor: r.accessible ? 'pointer' : 'not-allowed',
                    color: path === r.path ? 'var(--accent)' : 'var(--text-muted)',
                    fontSize: 12, fontFamily: 'var(--font-body)',
                  }}>
                  <span style={{ opacity: 0.85 }}>{r.accessible ? '🗂' : '⚠'}</span>
                  {r.name}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{r.modelCount}</span>
                </button>
              ))}
            </div>
            <div className="modal-hint" style={{ marginTop: 5 }}>
              Pick a folder to scan just that root, or scan <code>/library</code> for everything. Add folders in your <code>.env</code> file.
            </div>
          </div>
        )}

        <input
          className="modal-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/library"
          disabled={running}
        />
        <div className="modal-hint">
          Default: <code>/library</code> — mapped to your NAS folder(s) via Docker Compose / <code>.env</code>.
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
            />
            <button
              onClick={() => setShowKey(s => !s)}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-faint)', fontSize: 13,
              }}
              title={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? '◉' : '○'}
            </button>
          </div>
          {apiKey && (
            <button
              onClick={testApiKey}
              disabled={testingKey}
              style={{
                background: keyStatus === 'ok' ? 'rgba(76,175,125,0.15)' : keyStatus === 'error' ? 'rgba(207,114,114,0.15)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${keyStatus === 'ok' ? 'rgba(76,175,125,0.4)' : keyStatus === 'error' ? 'rgba(207,114,114,0.4)' : 'rgba(255,255,255,0.1)'}`,
                color: keyStatus === 'ok' ? 'var(--green)' : keyStatus === 'error' ? 'var(--red)' : 'var(--text-muted)',
                fontSize: 10, fontFamily: 'var(--font-mono)', padding: '4px 8px',
                borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
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
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1 }}>AI MODEL</span>
          <select
            value={aiModel}
            onChange={e => { setAiModel(e.target.value); localStorage.setItem('vault_ai_model', e.target.value); setEstimate(null); }}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '5px 8px', fontSize: 11, fontFamily: 'var(--font-mono)', outline: 'none' }}
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

        <div style={{ marginTop: 14 }}>
          <TaskLog lines={lines} running={running} title="SCAN LOG" height={240} />
        </div>

        {done && summary && (
          <div style={{
            marginTop: 12, padding: '10px 14px',
            background: summary.success ? 'rgba(76,175,125,0.08)' : 'rgba(207,114,114,0.08)',
            border: `1px solid ${summary.success ? 'rgba(76,175,125,0.3)' : 'rgba(207,114,114,0.3)'}`,
            borderRadius: 6, fontSize: 12,
            color: summary.success ? 'var(--green)' : 'var(--red)',
            fontFamily: 'var(--font-mono)',
          }}>
            {summary.success
              ? `✓ Complete — ${summary.modelsFound} found · ${summary.modelsAdded} added · ${summary.modelsUpdated} updated · ${summary.modelsSkipped ?? 0} skipped`
              : `✗ Error — ${summary.error}`}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn-cancel" onClick={onClose} disabled={running || tagging || findingImages || visionTagging}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {running && (
            <button className="btn-cancel" onClick={cancelScan}
              style={{ borderColor: 'rgba(207,114,114,0.5)', color: '#cf7272' }}
              title="Stop the running scan">
              ■ Stop Scan
            </button>
          )}
          <button className="btn-primary" onClick={() => { setDone(false); startScan(); }} disabled={running || tagging || findingImages || visionTagging}>
            {running ? 'Scanning…' : done ? 'Rescan' : 'Start Scan'}
          </button>
          <button
            className="btn-primary"
            onClick={generateTags}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            style={{ background: tagging ? 'var(--bg-card)' : 'rgba(155,114,207,0.15)', color: '#9b72cf', border: '1px solid rgba(155,114,207,0.3)', opacity: !apiKey ? 0.5 : 1 }}
            title={apiKey ? 'Uses Claude API credits — auto-generate tags for all models from names, creators, and folder structure' : 'Add a Claude API key above to enable'}
          >
            {tagging ? 'Tagging…' : '$ Generate Tags'}
          </button>
          <button
            className="btn-primary"
            onClick={() => visionTags(true)}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            style={{ background: visionTagging ? 'var(--bg-card)' : 'rgba(155,114,207,0.15)', color: '#9b72cf', border: '1px solid rgba(155,114,207,0.3)', opacity: !apiKey ? 0.5 : 1 }}
            title={apiKey ? 'Uses Claude API credits (vision — costs more) — analyses each render image to identify and tag the model' : 'Add a Claude API key above to enable'}
          >
            {visionTagging ? 'Looking…' : '$ 👁 Tags from Images (trial 10)'}
          </button>
          <button
            className="btn-primary"
            onClick={() => findImages(true)}
            disabled={running || tagging || findingImages || visionTagging || !apiKey}
            style={{ background: findingImages ? 'var(--bg-card)' : 'rgba(91,155,213,0.15)', color: '#5b9bd5', border: '1px solid rgba(91,155,213,0.3)', opacity: !apiKey ? 0.5 : 1 }}
            title={apiKey ? 'Uses Claude API credits — finds missing thumbnails online (trial: 10 best candidates first)' : 'Add a Claude API key above to enable'}
          >
            {findingImages ? 'Finding…' : '$ Find Images (trial 10)'}
          </button>
          {imgResult && imgResult.remaining > 0 && (
            <button
              className="btn-primary"
              onClick={() => findImages(false)}
              disabled={running || tagging || findingImages || visionTagging || !apiKey}
              style={{ background: 'rgba(91,155,213,0.25)', color: '#5b9bd5', border: '1px solid rgba(91,155,213,0.4)', opacity: !apiKey ? 0.5 : 1 }}
              title={apiKey ? `Uses Claude API credits — process all ${imgResult.remaining} remaining models` : 'Add a Claude API key above to enable'}
            >
              $ Continue All ({imgResult.remaining})
            </button>
          )}
          {done && (
            <button className="btn-primary" onClick={onClose}>View Results</button>
          )}
        </div>
      </div>
    </div>
  );
}
