import React, { useState, useEffect, useRef } from 'react';
import TaskLog from './TaskLog';

export default function ScanModal({ onClose, onScanComplete }) {
  const [path, setPath] = useState('/library');
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState(null);
  const [lines, setLines] = useState([]);
  const esRef = useRef(null);

  const startScan = async () => {
    setRunning(true);
    setDone(false);
    setSummary(null);
    setLines([]);

    // Fire off scan
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, force }),
      });
    } catch (e) {
      setLines(l => [...l, { level: 'error', msg: e.message, ts: new Date().toISOString() }]);
      setRunning(false);
      return;
    }

    // Open SSE stream
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
  };

  useEffect(() => () => esRef.current?.close(), []);

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
            disabled={running}
            style={{ accentColor: 'var(--accent)' }}
          />
          Force full rescan (re-index all models, even unchanged ones)
        </label>

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

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn-cancel" onClick={onClose} disabled={running}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button className="btn-primary" onClick={startScan} disabled={running}>
              {running ? 'Scanning…' : 'Start Scan'}
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
