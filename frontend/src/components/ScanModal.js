import React, { useState, useEffect } from 'react';

export default function ScanModal({ onClose }) {
  const [path, setPath] = useState('/library');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let interval;
    if (scanning) {
      interval = setInterval(async () => {
        try {
          const r = await fetch('/api/scan/status');
          const data = await r.json();
          setProgress(data.progress);
          if (!data.inProgress) {
            setScanning(false);
            setDone(true);
            clearInterval(interval);
          }
        } catch {}
      }, 800);
    }
    return () => clearInterval(interval);
  }, [scanning]);

  const handleScan = async () => {
    setScanning(true);
    setDone(false);
    setProgress({ stage: 'starting' });
    try {
      await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });
    } catch (e) {
      setScanning(false);
      setProgress({ stage: 'error', error: e.message });
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !scanning) onClose(); }}>
      <div className="modal">
        <div className="modal-title">SCAN LIBRARY</div>
        <div className="modal-subtitle">Index your NAS folder to discover models and extract images</div>

        <input
          className="modal-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/library"
          disabled={scanning}
        />

        <div className="modal-hint">
          This should be the path where your library is mounted inside Docker.<br />
          Default: <code>/library</code> — maps to your NAS folder via Docker Compose.
        </div>

        {progress && (
          <div className="scan-progress">
            <div className="stage">
              {progress.stage === 'complete' ? '✓ Complete' :
               progress.stage === 'error' ? '✗ Error' :
               progress.stage === 'starting' ? '◌ Starting...' :
               '◎ Scanning...'}
            </div>
            {progress.stage === 'scanning' && (
              <div className="detail">
                {progress.creator && `Creator: ${progress.creator}`}<br />
                {progress.model && `Model: ${progress.model}`}<br />
                Found: {progress.found} models so far
              </div>
            )}
            {progress.stage === 'complete' && (
              <div className="detail">
                {progress.modelsFound} found · {progress.modelsAdded} added · {progress.modelsUpdated} updated
              </div>
            )}
            {progress.stage === 'error' && (
              <div className="detail" style={{ color: 'var(--red)' }}>{progress.error}</div>
            )}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: '20px' }}>
          <button className="btn-cancel" onClick={onClose} disabled={scanning}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button className="btn-primary" onClick={handleScan} disabled={scanning}>
              {scanning ? 'Scanning...' : 'Start Scan'}
            </button>
          )}
          {done && (
            <button className="btn-primary" onClick={onClose}>
              View Results
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
