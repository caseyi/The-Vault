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
  const [tagging, setTagging] = useState(false);
  const [tagResult, setTagResult] = useState(null);
  const [findingImages, setFindingImages] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('claude_api_key') || '');
  const [showKey, setShowKey] = useState(false);
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

  // On mount: check if a scan is already running and reconnect
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/scan/status');
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
        // API unreachable — just show the start form
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connectToStream]);

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

  const generateTags = async () => {
    setTagging(true);
    setTagResult(null);
    setLines(l => [...l, { level: 'info', msg: 'Generating tags with Claude AI…', ts: new Date().toISOString() }]);
    try {
      const res = await fetch('/api/ai/generate-tags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey && { 'x-claude-key': apiKey }),
        },
      });
      const data = await res.json();
      if (!res.ok) {
        setLines(l => [...l, { level: 'error', msg: data.error || 'Tag generation failed', ts: new Date().toISOString() }]);
        setTagResult({ success: false, error: data.error });
      } else {
        setLines(l => [...l, { level: 'success', msg: `✓ Tagged ${data.tagged} of ${data.total} models`, ts: new Date().toISOString() }]);
        setTagResult(data);
        if (onScanComplete) onScanComplete(); // refresh gallery
      }
    } catch (e) {
      setLines(l => [...l, { level: 'error', msg: e.message, ts: new Date().toISOString() }]);
      setTagResult({ success: false, error: e.message });
    } finally {
      setTagging(false);
    }
  };

  const findImages = () => {
    setFindingImages(true);
    setLines(l => [...l, { level: 'info', msg: 'Searching for images for models without thumbnails…', ts: new Date().toISOString() }]);

    const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
    const es = new EventSource(`/api/ai/find-images${keyParam}`);
    imgEsRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        setFindingImages(false);
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

  // Cleanup image finder SSE on unmount
  useEffect(() => () => imgEsRef.current?.close(), []);

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

        <input
          className="modal-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/library"
          disabled={running}
        />
        <div className="modal-hint">
          Default: <code>/library</code> — mapped to your NAS folder via Docker Compose.
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
            <span style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              ✓ saved
            </span>
          )}
        </div>
        <div className="modal-hint" style={{ marginTop: 2 }}>
          Required for Generate Tags and Find Online. Stored in browser only.
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
          <button className="btn-cancel" onClick={onClose} disabled={running || tagging || findingImages}>
            {done ? 'Close' : 'Cancel'}
          </button>
          <button className="btn-primary" onClick={() => { setDone(false); startScan(); }} disabled={running || tagging || findingImages}>
            {running ? 'Scanning…' : done ? 'Rescan' : 'Start Scan'}
          </button>
          <button
            className="btn-primary"
            onClick={generateTags}
            disabled={running || tagging || findingImages}
            style={{ background: tagging ? 'var(--bg-card)' : 'rgba(155,114,207,0.15)', color: '#9b72cf', border: '1px solid rgba(155,114,207,0.3)' }}
            title="Use Claude AI to auto-generate tags for all models based on names, creators, and folder structure"
          >
            {tagging ? 'Tagging…' : 'Generate Tags'}
          </button>
          <button
            className="btn-primary"
            onClick={findImages}
            disabled={running || tagging || findingImages}
            style={{ background: findingImages ? 'var(--bg-card)' : 'rgba(91,155,213,0.15)', color: '#5b9bd5', border: '1px solid rgba(91,155,213,0.3)' }}
            title="Use Claude AI to search online and download images for models without thumbnails"
          >
            {findingImages ? 'Finding…' : 'Find Images'}
          </button>
          {done && (
            <button className="btn-primary" onClick={onClose}>View Results</button>
          )}
        </div>
      </div>
    </div>
  );
}
