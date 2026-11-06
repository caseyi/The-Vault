import React, { useState, useEffect, useCallback, useRef, useId } from 'react';
import { apiGet, apiSend, errorMessage } from '../api';
import { useNotify } from './Notices';
import { useConfirm } from './ConfirmDialog';
import { pct, band } from '../enrich';
import {
  parseGroups, parseRules, showValue, fieldWord, appliedMessage, canRule,
} from '../reviewRules';

// Review tab pieces (docs/ai-enrichment.md §5, §11): edit a proposed value, answer groups,
// the nudge bar that turns a decision into a rule, and the rules list.

const EDITIONS = ['Sculpture', 'Bust', 'Accessory', 'Diorama'];
const valuesCache = new Map();
export function clearValuesCache() { valuesCache.clear(); }

/** Known values for a field (GET /api/suggestions/values), cached per field. */
function useKnownValues(field) {
  const [values, setValues] = useState(() => valuesCache.get(field) || []);
  useEffect(() => {
    if (!field || valuesCache.has(field)) { setValues(valuesCache.get(field) || []); return undefined; }
    let alive = true;
    apiGet(`/api/suggestions/values?field=${encodeURIComponent(field)}`)
      .then(d => { const v = d && Array.isArray(d.values) ? d.values.filter(x => typeof x === 'string') : []; valuesCache.set(field, v); if (alive) setValues(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, [field]);
  return values;
}

/**
 * Inline editor for a proposed value: text with suggestions from values already in the library,
 * a select for editions. Enter submits, Escape cancels.
 */
export function ValueEditor({ field, initial, onSubmit, onCancel, submitLabel = 'Accept', busy, children }) {
  const values = useKnownValues(field);
  const listId = useId();
  const start = Array.isArray(initial) ? initial.join(', ') : (initial ?? '');
  const [value, setValue] = useState(field === 'editions' ? (Array.isArray(initial) && initial[0]) || EDITIONS[0] : start);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) { ref.current.focus(); if (ref.current.select) ref.current.select(); } }, []);
  const submit = () => {
    const v = String(value || '').trim();
    if (!v) return;
    onSubmit(field === 'tags' ? v.split(',').map(s => s.trim()).filter(Boolean) : field === 'editions' ? [v] : v);
  };
  const onKey = (e) => {
    e.stopPropagation(); // keep the list's j/k/a/r keys out of the input
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  const label = `New ${fieldWord(field)}`;
  return (
    <div className="value-editor" onKeyDown={onKey}>
      {field === 'editions' ? (
        <select ref={ref} className="gallery-select" value={value} onChange={e => setValue(e.target.value)} aria-label={label}>
          {EDITIONS.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      ) : (
        <>
          <input ref={ref} className="value-editor-input" value={value} onChange={e => setValue(e.target.value)} aria-label={label}
            list={listId} placeholder={field === 'tags' ? 'tag, another tag' : `Type a ${fieldWord(field)}`} maxLength={field === 'name' ? 100 : 80} />
          <datalist id={listId}>{values.slice(0, 300).map(v => <option key={v} value={v} />)}</datalist>
        </>
      )}
      <button type="button" className="org-btn org-btn-sm org-btn-success" disabled={busy || !String(value || '').trim()} onClick={submit}>✓ {submitLabel}</button>
      <button type="button" className="link-btn attr-faint" onClick={onCancel}>cancel</button>
      {children}
    </div>
  );
}

function Thumb({ src }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <span className="answer-sample-thumb ph" aria-hidden="true">🧩</span>;
  return <img className="answer-sample-thumb" src={src} alt="" loading="lazy" onError={() => setBad(true)} />;
}

function confRange(lo, hi) {
  if (lo == null && hi == null) return '';
  return lo === hi || lo == null || hi == null ? pct(hi ?? lo) : `${pct(lo)}–${pct(hi)}`;
}

/** One answer: "Genre → Wildcard · 423 cards", sample cards, decide all / edit / review one by one. */
function AnswerGroup({ g, field, busy, onDecide, onReviewOne }) {
  const [editing, setEditing] = useState(false);
  const [remember, setRemember] = useState(true);
  const word = fieldWord(field);
  const isTags = field === 'tags';
  const title = isTags ? `+ ${g.tag}` : showValue(g.proposed);
  const n = g.count;
  const more = n - g.samples.length;
  const canMap = canRule('map', field);
  return (
    <li className="answer-group" aria-label={`${title}: ${n} card${n !== 1 ? 's' : ''}`}>
      <div className="answer-main">
        <div className="answer-title">
          <ins className="diff-new answer-value">{title}</ins>
          <span className="answer-count">{n.toLocaleString()} card{n !== 1 ? 's' : ''}</span>
        </div>
        <div className="answer-meta">
          <span className={`conf-chip conf-${band(g.maxConfidence) || 'low'}`} title="Confidence range in this group">{confRange(g.minConfidence, g.maxConfidence)}</span>
          {!isTags && g.fromEmpty > 0 && <span>{g.fromEmpty === n ? `all fill an empty ${word}` : `${g.fromEmpty} fill an empty ${word}`}</span>}
          {!isTags && g.fromEmpty < n && <span className="answer-warn">{n - g.fromEmpty} change an existing {word}</span>}
          {g.creators.length > 0 && <span className="attr-faint">{g.creators.map(c => `${c.name || '?'} ${c.count}`).join(' · ')}</span>}
        </div>
        <ul className="answer-samples" aria-label={`Cards in ${title}`}>
          {g.samples.map(s => (
            <li key={s.suggestionId ?? s.id} className="answer-sample" title={`${s.name}${s.creator_name ? ` · ${s.creator_name}` : ''}${!isTags ? ` · now: ${showValue(s.current)}` : ''}`}>
              <Thumb src={s.thumbnail_path} /><span className="answer-sample-name">{s.name}</span>
            </li>
          ))}
          {more > 0 && <li className="answer-sample attr-faint">+{more.toLocaleString()} more</li>}
        </ul>
        {editing && (
          <ValueEditor field={field} initial={isTags ? g.tag : g.proposed} busy={busy} submitLabel={`Accept ${n} as this`}
            onCancel={() => setEditing(false)}
            onSubmit={(value) => { setEditing(false); onDecide(g, 'accept', { value, remember: canMap && remember }); }}>
            {canMap && (
              <label className="answer-remember">
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Remember: use this whenever the AI says “{isTags ? g.tag : showValue(g.proposed)}”
              </label>
            )}
          </ValueEditor>
        )}
      </div>
      <div className="review-actions">
        <button className="org-btn org-btn-sm org-btn-success" disabled={busy} onClick={() => onDecide(g, 'accept')}
          aria-label={`Accept ${title} for ${n} cards`}>✓ Accept {n.toLocaleString()}</button>
        <button className="org-btn org-btn-sm" disabled={busy || editing} onClick={() => setEditing(true)}
          aria-label={`Use a different ${word} than ${title}`}>✎ Different {word}</button>
        <button className="org-btn org-btn-sm" disabled={busy} onClick={() => onDecide(g, 'reject')}
          aria-label={`Reject ${title} for ${n} cards`}>✕ Reject {n.toLocaleString()}</button>
        <button className="link-btn answer-one-by-one" onClick={() => onReviewOne(g)} aria-label={`Review ${title} one by one`}>One by one ›</button>
      </div>
    </li>
  );
}

/**
 * Pending proposals of one field grouped by answer (GET /api/suggestions/groups). Calls
 * onUnsupported() when the backend has no groups route, so the tab falls back to the list.
 */
export function AnswerGroups({ type, field, creator, minConfidence, refreshKey, busy, onDecide, onReviewOne, onUnsupported }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (page = 1) => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ type, ...(type === 'field' ? { field } : {}), page, limit: 40 });
      if (creator) qs.set('creator', creator);
      if (minConfidence > 0) qs.set('minConfidence', String(minConfidence));
      const d = parseGroups(await apiGet(`/api/suggestions/groups?${qs}`));
      if (!d) { if (onUnsupported) onUnsupported(); setLoading(false); return; }
      setData(prev => (page === 1 || !prev ? d : { ...d, items: [...prev.items, ...d.items.filter(x => !prev.items.some(p => p.key === x.key))] }));
    } catch (e) {
      if (e && e.status === 404 && onUnsupported) onUnsupported(); else setError(errorMessage(e));
    }
    setLoading(false);
  }, [type, field, creator, minConfidence, onUnsupported]);
  useEffect(() => { load(1); }, [load, refreshKey]);

  if (error) return <div className="org-error">{error}</div>;
  if (!data) return loading ? <div className="org-hint-inline" style={{ padding: 8 }}>Loading…</div> : null;
  if (!data.items.length) return <div className="org-empty">Nothing pending here{creator ? ` for ${creator}` : ''}.</div>;
  return (
    <>
      <div className="answer-summary attr-faint">
        {data.suggestions.toLocaleString()} suggestion{data.suggestions !== 1 ? 's' : ''} in {data.total.toLocaleString()} answer{data.total !== 1 ? 's' : ''}. Decide a whole answer at once, or open it one by one.
      </div>
      <ul className="answer-list" aria-label="Answers">
        {data.items.map(g => <AnswerGroup key={g.key} g={g} field={field} busy={busy} onDecide={onDecide} onReviewOne={onReviewOne} />)}
      </ul>
      {loading && <div className="org-hint-inline" style={{ padding: 8 }}>Loading…</div>}
      {!loading && data.page < data.pages && (
        <button className="sec-more-btn" onClick={() => load(data.page + 1)}>▼ More answers ({(data.total - data.items.length).toLocaleString()} left)</button>
      )}
    </>
  );
}

/**
 * After a decision: offer to turn it into a rule ("Never propose X as a genre"). One at a time;
 * a new decision replaces it. `nudge` = { text, options: [{ label, rule }] }.
 */
export function NudgeBar({ nudge, onDismiss, onSaved }) {
  const notify = useNotify();
  const [saving, setSaving] = useState(false);
  if (!nudge || !nudge.options || !nudge.options.length) return null;
  const save = async (o) => {
    setSaving(true);
    try {
      const r = await apiSend('/api/review-rules', 'POST', o.rule);
      notify(appliedMessage(r && r.applied), { type: 'success', duration: 7000 });
      onDismiss();
      if (onSaved) onSaved(r);
    } catch (e) {
      notify(e && e.status === 404 ? 'Rules need a newer backend; this server does not support them yet.' : `Couldn't save the rule: ${errorMessage(e)}`);
    }
    setSaving(false);
  };
  return (
    <div className="nudge-bar" role="status" aria-label="Teach the AI">
      <span className="nudge-text">{nudge.text} <span className="attr-faint">Teach the AI:</span></span>
      {nudge.options.map(o => (
        <button key={o.label} type="button" className="org-btn org-btn-sm org-btn-accent" disabled={saving} onClick={() => save(o)}>{o.label}</button>
      ))}
      <button type="button" className="link-btn attr-faint" onClick={onDismiss} aria-label="Dismiss suggestion to make a rule">not now</button>
    </div>
  );
}

const KIND_LABEL = { block: 'Never', map: 'Use instead', set: 'Set' };

/** The rules list: what each does, how often it applied, remove (set rules can clear their values). */
export function RulesPanel({ refreshKey, onChanged }) {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [rules, setRules] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    apiGet('/api/review-rules').then(d => setRules(parseRules(d))).catch(() => setRules([]));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const remove = async (r) => {
    const revert = { current: r.kind === 'set' };
    const ok = await askConfirm({
      title: 'Remove this rule?',
      message: (
        <>
          <p>{r.label}</p>
          <p>Suggestions it already rejected or rewrote stay as they are.</p>
          {r.kind === 'set' && (
            <label className="answer-remember">
              <input type="checkbox" defaultChecked onChange={e => { revert.current = e.target.checked; }} />
              Also clear the values it set (only where nobody changed them since)
            </label>
          )}
        </>
      ),
      confirmLabel: 'Remove rule',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiSend(`/api/review-rules/${r.id}${revert.current ? '?revert=1' : ''}`, 'DELETE');
      notify(`Rule removed${res && res.reverted ? `; ${res.reverted} value${res.reverted !== 1 ? 's' : ''} cleared` : ''}.`, { type: 'success' });
      load();
      if (onChanged) onChanged();
    } catch (e) { notify(`Couldn't remove the rule: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const reapply = async () => {
    setBusy(true);
    try {
      const a = await apiSend('/api/review-rules/apply', 'POST');
      notify(appliedMessage(a).replace('Rule saved', 'Rules applied'), { type: 'success' });
      load();
      if (onChanged) onChanged();
    } catch (e) { notify(`Couldn't apply the rules: ${errorMessage(e)}`); }
    setBusy(false);
  };

  if (!rules) return null;
  return (
    <details className="review-rules">
      {confirmUi}
      <summary>Rules <span className="attr-faint">{rules.length}</span></summary>
      <p className="org-desc">
        Rules teach the AI your house style. They apply at once to what is pending, to every later Enrich run, and are sent to the AI as instructions.
        Make one from the “Teach the AI” bar after you reject or edit a suggestion.
      </p>
      {rules.length === 0 ? <div className="org-hint-inline">No rules yet.</div> : (
        <ul className="rules-list">
          {rules.map(r => (
            <li key={r.id} className="org-health-row rules-row">
              <span className={`rule-kind rule-${r.kind}`}>{KIND_LABEL[r.kind] || r.kind}</span>
              <span className="rules-label" title={r.path || undefined}>{r.label || `${r.kind} ${r.field}`}</span>
              <span className="attr-faint num" title="Times it applied">{(r.applied || 0).toLocaleString()}×</span>
              <button className="org-btn org-btn-sm org-btn-danger" disabled={busy} onClick={() => remove(r)} aria-label={`Remove rule: ${r.label}`}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {rules.length > 0 && (
        <button className="org-btn org-btn-sm" disabled={busy} onClick={reapply} style={{ marginTop: 6 }}>↻ Re-apply rules now</button>
      )}
    </details>
  );
}
