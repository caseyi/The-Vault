import React, { useCallback, useEffect, useRef, useState } from 'react';
import TaskLog from './TaskLog';
import { apiGet, apiSend, errorMessage, isAbortError } from '../api';
import { formatBytes } from '../thumbs';

const POLL_MS = 5000;
const now = () => new Date().toISOString();
const n = (v) => (Number(v) || 0).toLocaleString();

/**
 * Scan window section "Thumbnails": picture counts and cache size, the
 * "Find missing pictures" job (SSE /api/thumbs/fill) and "Rebuild cache".
 * Hidden when the backend has no thumbnail support (older version).
 */
export default function ThumbnailsPanel({ disabled = false, onChanged, onRunningChange }) {
  const [status, setStatus] = useState(null);
  const [supported, setSupported] = useState(true);
  const [lines, setLines] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [retryAll, setRetryAll] = useState(false);
  const [render3d, setRender3d] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const esRef = useRef(null);
  const doneRef = useRef(false);
  const gotMessageRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const log = useCallback((level, msg) => setLines(l => [...l, { level, msg, ts: now() }]), []);

  const loadStatus = useCallback(async (signal) => {
    try {
      const s = await apiGet('/api/thumbs/status', { signal });
      if (s && typeof s === 'object') setStatus(s);
    } catch (e) {
      if (isAbortError(e)) return;
      if (e && e.status === 404) setSupported(false);
    }
  }, []);

  useEffect(() => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    loadStatus(ctl?.signal);
    return () => { if (ctl) ctl.abort(); };
  }, [loadStatus]);

  // While the background cache fill is working, refresh the counts now and then.
  const generating = !!(status && status.generating > 0);
  useEffect(() => {
    if (!generating || running) return undefined;
    const t = setInterval(() => loadStatus(), POLL_MS);
    return () => clearInterval(t);
  }, [generating, running, loadStatus]);

  useEffect(() => { if (onRunningChange) onRunningChange(running); }, [running, onRunningChange]);
  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);

  const startFill = () => {
    if (esRef.current) esRef.current.close();
    doneRef.current = false;
    gotMessageRef.current = false;
    setRunning(true); setProgress(null); setResult(null); setLines([]);
    const p = new URLSearchParams({ scope: retryAll ? 'all' : 'missing', steps: render3d ? 'peek,render' : 'peek' });
    const es = new EventSource(`/api/thumbs/fill?${p}`);
    esRef.current = es;
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      gotMessageRef.current = true;
      if (data.type === 'progress') setProgress(data);
      else if (data.type === 'done') {
        doneRef.current = true;
        es.close();
        setRunning(false);
        setResult(data);
        if (data.success === false && data.error) log('error', data.error);
        loadStatus();
        if (onChangedRef.current) onChangedRef.current(data);
      } else if (data.msg) setLines(l => [...l, data]);
    };
    es.onerror = () => {
      es.close();
      if (doneRef.current) return;
      setRunning(false);
      if (!gotMessageRef.current) {
        // EventSource cannot read the 409 body; this is the usual cause.
        log('error', 'Could not start: a thumbnail job is probably already running. Try again when it finishes.');
      } else {
        log('error', 'Connection lost. The server stops the job when the connection closes; pictures found so far are kept.');
        if (onChangedRef.current) onChangedRef.current(null);
      }
      loadStatus();
    };
  };

  const stopFill = () => {
    if (esRef.current) esRef.current.close();
    log('warn', 'Stopped. Pictures found so far are kept.');
    setRunning(false);
    loadStatus();
    if (onChangedRef.current) onChangedRef.current(null);
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const r = await apiSend('/api/thumbs/rebuild', 'POST');
      log('info', `Thumbnail cache cleared; ${n(r && r.queued)} image${r && r.queued === 1 ? '' : 's'} queued to rebuild in the background.`);
      await loadStatus();
    } catch (e) {
      log('error', `Rebuild failed: ${errorMessage(e)}`);
    } finally {
      setRebuilding(false);
    }
  };

  if (!supported) return null;

  const cards = (status && status.cards) || null;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const found = (result && result.found) || (progress && progress.found) || null;
  const foundText = found
    ? `folder ${n(found.folder)}, archive ${n(found.archive)}, inside zips ${n(found.peek)}, 3D renders ${n(found.stl)}`
    : '';

  return (
    <section className="thumbs-panel" aria-labelledby="thumbs-panel-title">
      <div className="thumbs-panel-title" id="thumbs-panel-title">THUMBNAILS</div>
      {status ? (
        <dl className="thumbs-stats">
          {cards && <div className="thumbs-stat"><dt>With picture</dt><dd>{n(cards.withPicture)}</dd></div>}
          {cards && <div className="thumbs-stat"><dt>Rendered 3D</dt><dd>{n(cards.rendered)}</dd></div>}
          {cards && <div className="thumbs-stat"><dt>Missing</dt><dd>{n(cards.missing)}</dd></div>}
          <div className="thumbs-stat">
            <dt>Cache</dt>
            <dd title={`${n(status.cached)} cached, ${n(status.missing)} not cached yet`}>
              {formatBytes(status.bytes)}
              <span className="modal-hint" style={{ display: 'block', margin: 0 }}>
                {n(status.cached)} cached{status.missing ? `, ${n(status.missing)} to go` : ''}{generating ? ' (building)' : ''}
              </span>
            </dd>
          </div>
        </dl>
      ) : (
        <div className="modal-hint" role="status">Loading thumbnail status…</div>
      )}
      {status && status.sharp === false && (
        <div className="modal-hint">Small thumbnails are not available on this server (image library missing), so cards load the full-size pictures.</div>
      )}

      <div className="thumbs-actions">
        <label className="enrich-check" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={render3d} onChange={e => setRender3d(e.target.checked)} disabled={running} />
          Render from 3D files when nothing else is found
        </label>
        <label className="enrich-check" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={retryAll} onChange={e => setRetryAll(e.target.checked)} disabled={running} />
          Recheck every card (ignore earlier attempts)
        </label>
      </div>
      <div className="thumbs-actions">
        {!running ? (
          <button className="btn-primary" onClick={startFill} disabled={disabled || rebuilding}
            title="Look for pictures in folders and zips, then render the model for cards still without one">
            Find missing pictures
          </button>
        ) : (
          <button className="btn-cancel btn-stop" onClick={stopFill}>■ Stop</button>
        )}
        <button className="btn-cancel" onClick={rebuild} disabled={disabled || running || rebuilding}
          title="Delete the small cached copies and make them again in the background">
          {rebuilding ? 'Rebuilding…' : 'Rebuild cache'}
        </button>
      </div>

      {(running || progress) && (
        <div className="thumbs-progress" role="status">
          {progress
            ? `${n(progress.done)} / ${n(progress.total)} cards checked${progress.failed ? `, ${n(progress.failed)} failed` : ''}`
            : 'Starting…'}
          {foundText && <div>Found: {foundText}</div>}
          <progress max={100} value={pct} aria-label="Find missing pictures progress">{pct}%</progress>
        </div>
      )}
      {result && (
        <div className={`scan-summary ${result.success === false ? 'fail' : 'ok'}`} role="status">
          {result.success === false
            ? `✗ Stopped with an error${result.error ? `: ${result.error}` : ''}`
            : `✓ Done: ${n(result.done)} cards checked${foundText ? `; found ${foundText}` : ''}${result.failed ? `; ${n(result.failed)} failed` : ''}`}
        </div>
      )}
      {lines.length > 0 && <TaskLog lines={lines} running={running} title="THUMBNAIL LOG" height={160} />}
    </section>
  );
}
