import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import TaskLog from './TaskLog';
import { apiGet, errorMessage, isAbortError } from '../api';
import { filterParams, hasActiveFilters } from '../filters';
import { usd, actualCost } from '../enrich';

// "Enrich metadata": fills character / genre / group / editions / tags with a
// cheap text pass (and optionally the render for hard cases), proposes merges,
// and sends anything uncertain to the Review list (docs/ai-enrichment.md).

const MAX_FILTER_IDS = 1500;

function storedKey() { try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; } }
function storedModel() { try { return localStorage.getItem('vault_ai_model') || ''; } catch { return ''; } }

/** Ids of the cards matching the gallery filter (paged, capped). */
export async function idsForFilter(filters, { signal } = {}) {
  const ids = [];
  let page = 1;
  let total = 0;
  for (;;) {
    const qs = new URLSearchParams({ ...filterParams(filters), page, limit: 500 });
    const d = await apiGet(`/api/models?${qs}`, { signal });
    total = (d && d.total) || 0;
    for (const m of (d && d.models) || []) ids.push(m.id);
    if (!d || page >= (d.pages || 1) || ids.length >= MAX_FILTER_IDS) break;
    page += 1;
  }
  return { ids: ids.slice(0, MAX_FILTER_IDS), total, capped: total > MAX_FILTER_IDS };
}

function ScopeButton({ value, scope, setScope, disabled, children }) {
  const on = scope === value;
  return (
    <button type="button" className={`facet-pill ${on ? 'active' : ''}`} aria-pressed={on}
      onClick={() => setScope(value)} disabled={disabled}>{children}</button>
  );
}

export default function EnrichPanel({ apiKey: apiKeyProp, filters, presetIds, onDone, onOpenReview, disabled, onRunningChange }) {
  const apiKey = apiKeyProp !== undefined ? apiKeyProp : storedKey();
  const selection = useMemo(() => (Array.isArray(presetIds) ? presetIds.filter(Boolean) : []), [presetIds]);
  const filterActive = !!filters && hasActiveFilters(filters);
  const [scope, setScope] = useState(selection.length ? 'ids' : 'all');
  const [creator, setCreator] = useState('');
  const [creators, setCreators] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(storedModel);
  const [vision, setVision] = useState(false);
  const [force, setForce] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState('');
  const [filterInfo, setFilterInfo] = useState(null); // { ids, total, capped }
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [lines, setLines] = useState([]);
  const [result, setResult] = useState(null);
  const esRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    apiGet('/api/ai/models').then(d => {
      setModels((d && d.models) || []);
      setModel(m => m || (d && d.default) || '');
    }).catch(() => {});
    apiGet('/api/creators').then(d => setCreators(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);
  useEffect(() => { if (onRunningChange) onRunningChange(running); }, [running, onRunningChange]);

  const filterKey = useMemo(() => JSON.stringify(filters ? filterParams(filters) : {}), [filters]);

  // Cards to send for the "Current filter" scope
  useEffect(() => {
    if (scope !== 'filter') return undefined;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setFilterInfo(null);
    idsForFilter(filters, { signal: ctl?.signal }).then(setFilterInfo).catch(e => { if (!isAbortError(e)) setEstimateError(errorMessage(e)); });
    return () => ctl && ctl.abort();
  }, [scope, filterKey]); // eslint-disable-line

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (scope === 'filter') {
      p.set('scope', 'ids');
      p.set('ids', (filterInfo?.ids || []).join(','));
    } else if (scope === 'ids') {
      p.set('scope', 'ids');
      p.set('ids', selection.join(','));
    } else {
      p.set('scope', scope);
      if (scope === 'creator' && creator) p.set('creator', creator);
    }
    if (vision) p.set('vision', '1');
    if (force) p.set('force', '1');
    if (model) p.set('model', model);
    return p;
  }, [scope, creator, vision, force, model, filterInfo, selection]);

  const ready = !(scope === 'creator' && !creator) && !(scope === 'filter' && !filterInfo) && !(scope === 'ids' && !selection.length);

  // Live estimate (debounced)
  useEffect(() => {
    if (!ready) { setEstimate(null); return undefined; }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(async () => {
      setEstimating(true); setEstimateError('');
      try {
        setEstimate(await apiGet(`/api/ai/enrich/estimate?${params}`, { signal: ctl?.signal }));
      } catch (e) {
        if (!isAbortError(e)) { setEstimate(null); setEstimateError(errorMessage(e)); }
      }
      setEstimating(false);
    }, 250);
    return () => { clearTimeout(t); if (ctl) ctl.abort(); };
  }, [params, ready]);

  const log = useCallback((level, msg) => setLines(l => [...l, { level, msg, ts: new Date().toISOString() }]), []);

  const run = () => {
    if (esRef.current) esRef.current.close();
    setRunning(true); setResult(null); setProgress(null); setLines([]);
    doneRef.current = false;
    const p = new URLSearchParams(params);
    if (apiKey) p.set('key', apiKey);
    const es = new EventSource(`/api/ai/enrich?${p}`);
    esRef.current = es;
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === 'progress') setProgress(data);
      else if (data.type === 'done') {
        doneRef.current = true;
        es.close();
        setRunning(false);
        setResult(data);
        if (!data.success && data.error) log('error', data.error);
        if (onDone) onDone(data);
      } else if (data.msg) setLines(l => [...l, data]);
    };
    es.onerror = () => {
      es.close();
      if (doneRef.current) return;
      log('error', 'Connection lost, or another AI job is already running. Check the server log.');
      setRunning(false);
    };
  };

  const stop = () => {
    if (esRef.current) esRef.current.close();
    log('warn', 'Stopped. The server ends the run when the connection closes; finished batches are kept.');
    setRunning(false);
  };

  const toProcess = estimate ? estimate.toProcess : null;
  const pctDone = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const pending = result ? (result.suggested || 0) + (result.merges || 0) : 0;
  const blocked = disabled || running || !ready || !apiKey || toProcess === 0;

  return (
    <section className="enrich-panel" aria-labelledby="enrich-title">
      <div className="enrich-head">
        <div id="enrich-title" className="enrich-title"><span className="enrich-dollar" aria-hidden="true">$</span> Enrich metadata</div>
        <div className="modal-hint" style={{ margin: 0 }}>
          Fills empty character, genre, group, editions and tags when the AI is confident. Changes to existing values,
          merges and unsure answers go to the Review list. Files and folders are never touched.
        </div>
      </div>

      <div className="enrich-row">
        <span className="enrich-label" id="enrich-scope-label">SCOPE</span>
        <div className="facet-pills enrich-pills" role="group" aria-labelledby="enrich-scope-label">
          {selection.length > 0 && <ScopeButton value="ids" scope={scope} setScope={setScope} disabled={running}>Selection ({selection.length})</ScopeButton>}
          <ScopeButton value="all" scope={scope} setScope={setScope} disabled={running}>All</ScopeButton>
          <ScopeButton value="unattributed" scope={scope} setScope={setScope} disabled={running}>Unattributed</ScopeButton>
          <ScopeButton value="creator" scope={scope} setScope={setScope} disabled={running}>This creator</ScopeButton>
          {filterActive && <ScopeButton value="filter" scope={scope} setScope={setScope} disabled={running}>Current filter</ScopeButton>}
        </div>
      </div>
      {scope === 'creator' && (
        <div className="enrich-row">
          <label className="enrich-label" htmlFor="enrich-creator">CREATOR</label>
          <select id="enrich-creator" className="gallery-select" value={creator} onChange={e => setCreator(e.target.value)} disabled={running}>
            <option value="">Choose a creator…</option>
            {creators.map(c => <option key={c.id ?? c.name} value={c.name}>{c.name}{c.model_count != null ? ` (${c.model_count})` : ''}</option>)}
          </select>
        </div>
      )}
      {scope === 'filter' && filterInfo?.capped && (
        <div className="modal-hint">The filter matches {filterInfo.total.toLocaleString()} cards; the first {filterInfo.ids.length.toLocaleString()} are sent. Narrow the filter or use another scope.</div>
      )}

      <div className="enrich-row">
        <label className="enrich-label" htmlFor="enrich-model">MODEL</label>
        <select id="enrich-model" className="gallery-select" value={model} disabled={running}
          onChange={e => { setModel(e.target.value); try { localStorage.setItem('vault_ai_model', e.target.value); } catch {} }}>
          {models.length === 0 && <option value="">(default)</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
        </select>
        <label className="enrich-check">
          <input type="checkbox" checked={vision} onChange={e => setVision(e.target.checked)} disabled={running} />
          Use renders for hard cases
        </label>
        <label className="enrich-check" title="Normally cards whose evidence has not changed since the last run are skipped">
          <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} disabled={running} />
          Re-run unchanged cards
        </label>
      </div>

      <div className="enrich-estimate" aria-live="polite">
        {estimateError ? <span className="enrich-err">Estimate failed: {estimateError}</span>
          : !ready ? <span className="attr-faint">{scope === 'creator' ? 'Choose a creator to see the estimate.' : 'Collecting the cards…'}</span>
            : !estimate ? <span className="attr-faint">{estimating ? 'Estimating…' : ''}</span>
              : (
                <>
                  <span><b>{estimate.toProcess.toLocaleString()}</b> card{estimate.toProcess !== 1 ? 's' : ''} to process</span>
                  <span className="attr-faint">{(estimate.unchanged || 0).toLocaleString()} unchanged{estimate.batches ? ` · ${estimate.batches} batch${estimate.batches !== 1 ? 'es' : ''}` : ''}</span>
                  <span>Text <b className="enrich-cost">≈{usd(estimate.text?.usd)}</b></span>
                  {vision && (estimate.vision?.maxItems ? (
                    <span>Vision up to {estimate.vision.maxItems.toLocaleString()} card{estimate.vision.maxItems !== 1 ? 's' : ''} <b className="enrich-cost">≈{usd(estimate.vision.usd)}</b></span>
                  ) : <span className="attr-faint">Vision: no cards with a render in this scope</span>)}
                  <span>Total <b className="enrich-cost">≈{usd(vision ? estimate.totalUsd : estimate.text?.usd)}</b></span>
                  <span className="attr-faint" title="Token counts are estimated from the evidence size; the run reports what it actually used">{estimate.approx === false ? 'estimate' : 'approximate'}</span>
                  {vision && estimate.vision?.note && <span className="attr-faint enrich-note">{estimate.vision.note}</span>}
                  {estimating && <span className="attr-faint">updating…</span>}
                </>
              )}
      </div>

      <div className="enrich-actions">
        {!running ? (
          <button className="btn-primary btn-ai btn-ai-purple" onClick={run} disabled={blocked}
            title={!apiKey ? 'Add a Claude API key to enable' : 'Uses Claude API credits'}>
            $ Enrich {toProcess ? `${toProcess.toLocaleString()} card${toProcess !== 1 ? 's' : ''}` : 'metadata'}
          </button>
        ) : (
          <button className="btn-cancel btn-stop" onClick={stop}>■ Stop</button>
        )}
        {!apiKey && <span className="attr-faint">Needs a Claude API key.</span>}
        {toProcess === 0 && !force && <span className="attr-faint">Nothing changed since the last run. Tick "Re-run unchanged cards" to redo them.</span>}
      </div>

      {(running || progress) && (
        <div className="enrich-progress" role="status" aria-label="Enrich progress">
          <div className="enrich-bar"><span style={{ width: `${pctDone}%` }} /></div>
          <div className="enrich-counts">
            <span>{progress ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}` : 'Starting…'}</span>
            {progress && <><span className="c-applied">{progress.applied} applied</span><span className="c-suggested">{progress.suggested} suggested</span><span className="c-merges">{progress.merges} merges</span></>}
          </div>
        </div>
      )}
      {lines.length > 0 && <TaskLog lines={lines} running={running} title="ENRICH LOG" height={180} />}

      {result && (
        <div className={`scan-summary ${result.success ? 'ok' : 'fail'} enrich-result`} role="status">
          {result.success ? (
            <>
              <span>✓ Run #{result.runId}: {result.applied} applied · {result.suggested} suggestions · {result.merges} merges · {(result.unchanged || 0).toLocaleString()} unchanged{result.visionUsed ? ` · ${result.visionUsed} with renders` : ''}{result.errors ? ` · ${result.errors} errors` : ''}</span>
              {actualCost(result) && <span className="enrich-actual" title="What this run actually used">Actual: {actualCost(result)}</span>}
              {pending > 0 && onOpenReview && <button className="link-btn enrich-review-link" onClick={onOpenReview}>Review {pending} →</button>}
            </>
          ) : <span>✗ {result.error || 'Run failed'}</span>}
        </div>
      )}
    </section>
  );
}
