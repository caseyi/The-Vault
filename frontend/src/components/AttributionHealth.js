import React, { useState, useEffect, useCallback } from 'react';
import { apiGet, apiSend, errorMessage } from '../api';
import { useNotify } from './Notices';
import { CONFIDENCE_LABELS, formatTerm, formatGB, isAttributed } from '../library';

// Health → Attribution: how much of the library is tied to a purchase, which
// owned products have no files on any library, and the _Meta loader status.

const ext = { target: '_blank', rel: 'noopener noreferrer' };
const CONF_ORDER = ['sidecar', 'exact', 'name', 'path', 'none'];
const COUNT_LABELS = {
  products: 'Products', productFiles: 'Product files', tracker: 'Tracker rows', driveFiles: 'Drive files',
  genreMap: 'Genre map', rules: 'Filing rules', sidecars: 'Sidecars',
};

function pct(a, t) { return t ? Math.round((a / t) * 100) : 0; }

function CoverageTable({ title, rows }) {
  if (!rows || !rows.length) return null;
  return (
    <div className="attr-cov">
      <div className="attr-subtitle">{title}</div>
      <table className="attr-cov-table">
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Attributed</th><th scope="col" className="sr-only-col"><span className="sr-only">Coverage</span></th></tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const p = pct(r.attributed || 0, r.total || 0);
            return (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td className="num">{(r.attributed || 0).toLocaleString()} / {(r.total || 0).toLocaleString()}</td>
                <td className="bar-cell">
                  <span className="attr-bar wide" role="img" aria-label={`${p}% attributed`}><span style={{ width: `${p}%` }} /></span>
                  <span className="num pct">{p}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GapsList({ products }) {
  const [creator, setCreator] = useState('');
  const creators = [...new Set(products.map(p => p.creator).filter(Boolean))].sort();
  const shown = creator ? products.filter(p => p.creator === creator) : products;
  const totalGB = shown.reduce((a, p) => a + (Number(p.sizeGB) || 0), 0);
  return (
    <div className="attr-gaps">
      <div className="attr-gaps-head">
        <div className="attr-subtitle">Owned, not on NAS <span className="attr-faint">{shown.length}{totalGB ? ` · ${formatGB(totalGB)}` : ''}</span></div>
        {creators.length > 1 && (
          <select className="gallery-select" value={creator} onChange={e => setCreator(e.target.value)} aria-label="Filter missing products by creator">
            <option value="">All creators</option>
            {creators.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="org-empty">Every owned product has files on a library 🎉</div>
      ) : (
        <ul className="attr-gap-list">
          {shown.map((p, i) => (
            <li key={`${p.name}-${i}`} className="org-health-row attr-gap-row">
              <span className="org-health-creator">{p.creator || '?'}</span>
              <span className="org-health-name" title={p.name}>{p.name}</span>
              {p.term && <span className="attr-faint">{formatTerm(p.term)}</span>}
              <span className="attr-faint num">{p.files ? `${p.files} file${p.files !== 1 ? 's' : ''}` : ''}{p.sizeGB ? ` · ${formatGB(p.sizeGB)}` : ''}</span>
              {(p.libraryUrl || p.productUrl) && (
                <a className="attr-link" href={p.libraryUrl || p.productUrl} {...ext}>
                  {p.libraryUrl ? 'Download' : 'Product page'}<span aria-hidden="true"> ↗</span>
                  <span className="sr-only"> {p.name} (opens in a new tab)</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetaStatus({ status }) {
  if (!status) return null;
  const counts = status.counts || {};
  const errors = Array.isArray(status.errors) ? status.errors : [];
  const loaded = status.loadedAt ? new Date(status.loadedAt) : null;
  return (
    <div className="attr-meta">
      <div className="attr-meta-counts">
        {Object.keys(counts).map(k => (
          <span key={k} className="attr-meta-count"><b>{Number(counts[k] || 0).toLocaleString()}</b> {COUNT_LABELS[k] || k}</span>
        ))}
      </div>
      <div className="org-hint-inline">
        {loaded && !Number.isNaN(loaded.getTime()) ? `Loaded ${loaded.toLocaleString()}` : 'Not loaded yet'}
        {Array.isArray(status.dirs) && status.dirs.length > 0 && <> · from <code>{status.dirs.join(', ')}</code></>}
      </div>
      {errors.length > 0 && (
        <div className="org-error attr-meta-errors" role="alert">
          <b>{errors.length} problem{errors.length !== 1 ? 's' : ''} reading _Meta:</b>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export default function AttributionHealth({ summary, onSummaryChange }) {
  const notify = useNotify();
  const [gaps, setGaps] = useState(null);
  const [gapsError, setGapsError] = useState('');
  const [status, setStatus] = useState(null);
  const [reloading, setReloading] = useState(false);

  const loadGaps = useCallback(async () => {
    setGapsError('');
    try {
      const d = await apiGet('/api/attribution/gaps');
      setGaps(Array.isArray(d && d.products) ? d.products : []);
    } catch (e) { setGapsError(errorMessage(e)); setGaps([]); }
  }, []);

  useEffect(() => {
    loadGaps();
    apiGet('/api/meta/status').then(setStatus).catch(() => setStatus(null));
  }, [loadGaps]);

  const reload = async () => {
    setReloading(true);
    try {
      const s = await apiSend('/api/meta/reload', 'POST');
      setStatus(s);
      const n = s && s.counts ? s.counts.products : undefined;
      const errs = s && Array.isArray(s.errors) ? s.errors.length : 0;
      notify(`Metadata reloaded${n != null ? `: ${n.toLocaleString()} products` : ''}${errs ? `, ${errs} problem${errs !== 1 ? 's' : ''}` : ''}`,
        { type: errs ? 'error' : 'success' });
      loadGaps();
      if (onSummaryChange) onSummaryChange();
    } catch (e) {
      notify(`Couldn't reload metadata: ${errorMessage(e)}`);
    }
    setReloading(false);
  };

  const byConf = (summary && summary.byConfidence) || {};
  const total = (summary && summary.total) || 0;
  const attributed = Object.keys(byConf).filter(isAttributed).reduce((a, k) => a + (byConf[k] || 0), 0);
  const confKeys = [...CONF_ORDER.filter(k => k in byConf), ...Object.keys(byConf).filter(k => !CONF_ORDER.includes(k))];

  return (
    <div className="attr-health">
      {summary && (
        <div className="attr-cov-summary">
          <div className="attr-cov-headline">
            <span className="attr-big">{pct(attributed, total)}%</span>
            <span>of {total.toLocaleString()} works are tied to a purchase or sidecar</span>
          </div>
          {confKeys.length > 0 && (
            <div className="attr-conf-row" aria-label="Works by match confidence">
              {confKeys.map(k => (
                <span key={k} className={`conf-badge conf-${k} ${isAttributed(k) ? '' : 'weak'}`}>
                  {CONFIDENCE_LABELS[k] || k} <b>{Number(byConf[k] || 0).toLocaleString()}</b>
                </span>
              ))}
            </div>
          )}
          <div className="attr-cov-grid">
            <CoverageTable title="By library" rows={summary.byLibrary} />
            <CoverageTable title="By studio" rows={summary.byStudio} />
          </div>
        </div>
      )}

      <div className="attr-meta-box">
        <div className="attr-gaps-head">
          <div className="attr-subtitle">Purchase metadata (_Meta)</div>
          <button className="org-btn org-btn-sm org-btn-blue" onClick={reload} disabled={reloading}>
            {reloading ? '⏳ Reloading…' : '↻ Reload metadata'}
          </button>
        </div>
        <div className="org-hint-inline" style={{ marginBottom: 6 }}>
          Re-reads Gumroad manifests, trackers, Drive listings and model.json sidecars. The Vault never writes to the library.
        </div>
        <MetaStatus status={status} />
      </div>

      {gapsError && <div className="org-error">{gapsError}</div>}
      {gaps === null ? <div className="org-hint-inline">Loading owned products…</div> : <GapsList products={gaps} />}
    </div>
  );
}
