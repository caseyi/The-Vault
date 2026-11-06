import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiGet, apiSend, errorMessage } from '../api';
import { useNotify } from './Notices';
import { useConfirm } from './ConfirmDialog';
import {
  REVIEW_GROUPS, FIELD_LABELS, BAND_LABELS, HIGH_MIN, band, pct, asValues, addedValues,
  formatRunDate, decideToasts, splitDecideErrors, actualCost,
} from '../enrich';
import { formatTerm } from '../library';
import { roleLabel, suggestionFolder } from '../folderRoles';
import { useNotifyRescan } from './RoleMenu';
import { relationLabel, setName, suggestionSetId, setSummaryLine } from '../relations';
import { ValueEditor, AnswerGroups, NudgeBar, RulesPanel, clearValuesCache } from './ReviewExtras';
import {
  GROUPED_BY_DEFAULT, groupable, fieldOf, fieldWord, canRule, showValue, nudgeOptions, appliedMessage,
} from '../reviewRules';

// Organize → Review: AI suggestions waiting for Casey (docs/ai-enrichment.md §5, §11).
// Grouped by type; field groups open "by answer" (Genre → Wildcard · 423 cards) so a few
// decisions clear most of the list. Filter by creator and a minimum confidence; decide one by one,
// by selection, a whole answer, or everything shown. Edit a proposal instead of rejecting it, and
// turn a decision into a rule ("Teach the AI"). j/k/a/r/e/x keys.

const PAGE = 50;

// Small cache of card details for merge rows (release label, file count, libraries)
const cardCache = new Map();
function useCardInfo(id) {
  const [info, setInfo] = useState(() => cardCache.get(id) || null);
  useEffect(() => {
    if (id == null || cardCache.has(id)) { setInfo(cardCache.get(id) || null); return undefined; }
    let alive = true;
    apiGet(`/api/models/${id}`).then(m => {
      const v = m ? {
        name: m.name, creator_name: m.creator_name, release_label: m.release_label, release_term: m.release_term,
        file_count: m.file_count, libraries: m.libraries, editions: m.editions, kind: m.kind,
      } : null;
      cardCache.set(id, v);
      if (alive) setInfo(v);
    }).catch(() => {});
    return () => { alive = false; };
  }, [id]);
  return info;
}
export function clearReviewCardCache() { cardCache.clear(); }

function Thumb({ src }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <div className="review-thumb ph" aria-hidden="true">🧩</div>;
  return <img className="review-thumb" src={src} alt="" loading="lazy" onError={() => setBad(true)} />;
}

function ConfidenceChip({ value }) {
  const b = band(value);
  if (!b) return null;
  return <span className={`conf-chip conf-${b}`} title={`${BAND_LABELS[b]} confidence`}>{BAND_LABELS[b]} {pct(value)}</span>;
}

function SourceChip({ source }) {
  if (!source) return null;
  return <span className="source-chip" title={source === 'vision' ? 'Answered from the render image' : 'Answered from names and metadata'}>{source === 'vision' ? '👁 vision' : 'text'}</span>;
}

function ValueDiff({ item }) {
  const field = item.field;
  if (field === 'tags' || field === 'editions' || Array.isArray(item.proposed)) {
    const cur = asValues(item.current);
    const added = addedValues(item.current, item.proposed);
    return (
      <span className="diff-list">
        {cur.map(v => <span key={`c-${v}`} className="diff-keep">{v}</span>)}
        {added.map(v => <ins key={`n-${v}`} className="diff-new">+ {v}</ins>)}
      </span>
    );
  }
  const cur = item.current == null || item.current === '' ? null : String(item.current);
  return (
    <span className="diff">
      {cur ? <del className="diff-old">{cur}</del> : <span className="diff-empty">empty</span>}
      <span className="diff-arrow" aria-hidden="true">→</span>
      <span className="sr-only"> becomes </span>
      <ins className="diff-new">{String(item.proposed ?? '')}</ins>
    </span>
  );
}

/** "Mark Misc/Terrain as Category (now Auto)" for a folder-role suggestion. */
export function RoleChange({ item }) {
  const folder = suggestionFolder(item);
  return (
    <span className="diff role-diff">
      Mark <b className="role-diff-folder" title={item.path}>{folder}</b> as <ins className="diff-new">{roleLabel(item.proposed)}</ins>
      <span className="attr-faint"> (now {roleLabel(item.current)})</span>
    </span>
  );
}

function MergeCard({ card, role }) {
  const info = useCardInfo(card && card.id);
  if (!card) return <div className="merge-card missing">Card not found</div>;
  const libs = Array.isArray(info?.libraries) ? [...info.libraries].sort().join(' + ') : '';
  const release = info?.release_label || (info?.release_term ? formatTerm(info.release_term) : '');
  return (
    <div className={`merge-card ${role}`}>
      <div className="merge-role">{role === 'source' ? 'Fold this card' : 'into this card'}</div>
      <div className="merge-card-main">
        <Thumb src={card.thumbnail_path} />
        <div style={{ minWidth: 0 }}>
          <div className="review-name" title={card.name}>{card.name}</div>
          <div className="review-creator">{card.creator_name || '?'}{card.kind ? ` · ${card.kind}` : ''}</div>
          <div className="merge-meta">
            {release ? <span title={info?.release_label || undefined}>Release: {release}</span> : <span className="attr-faint">No release label</span>}
            {info && <span>{info.file_count ?? '?'} files</span>}
            {libs && <span>{libs}</span>}
            {Array.isArray(info?.editions) && info.editions.length > 0 && <span>{info.editions.join(', ')}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A proposed relation: from card, relation type, to card. */
function RelationChange({ item }) {
  return (
    <span className="diff rel-diff">
      <b className="rel-diff-card">{item.model?.name || '?'}</b>
      <span className="rel-diff-type"> {relationLabel(item.field || item.proposed).toLowerCase()} </span>
      <ins className="diff-new">{item.target?.name || '?'}</ins>
      {item.target?.creator_name && item.target.creator_name !== item.model?.creator_name && (
        <span className="attr-faint"> ({item.target.creator_name})</span>
      )}
    </span>
  );
}

/** A proposed theme: name, counts and members, each with "Leave out". */
function ThemeProposal({ item, busy }) {
  const notify = useNotify();
  const [members, setMembers] = useState(() => (Array.isArray(item.members) ? item.members.filter(Boolean) : []));
  const [left, setLeft] = useState(0);
  const [working, setWorking] = useState(null);
  const sid = suggestionSetId(item);
  const name = setName(item);
  const counts = item.counts || {};
  const leaveOut = async (m) => {
    if (sid == null) return;
    setWorking(m.id);
    try {
      await apiSend(`/api/sets/${encodeURIComponent(sid)}/members/${m.id}`, 'DELETE');
      setMembers(prev => prev.filter(x => x.id !== m.id));
      setLeft(n => n + 1);
    } catch (e) { notify(`Couldn't leave out ${m.name}: ${errorMessage(e)}`); }
    setWorking(null);
  };
  const cards = counts.cards != null ? Math.max(0, Number(counts.cards) - left) : null;
  return (
    <div className="theme-proposal">
      <div className="theme-proposal-head">
        <span className="set-chip set-theme">Theme</span>
        <b className="theme-proposal-name">{name}</b>
        <span className="attr-faint">{setSummaryLine({ creator: item.model?.creator_name || item.creator, counts: { ...counts, cards } })}</span>
      </div>
      {members.length > 0 && (
        <ul className="theme-members" aria-label={`Members of ${name}`}>
          {members.map(m => (
            <li key={m.id} className="theme-member">
              <span className="theme-member-name" title={m.name}>{m.name}</span>
              {m.release_label && <span className="attr-faint theme-member-rel">{m.release_label}</span>}
              <button type="button" className="link-btn theme-leave-out" disabled={busy || working != null || sid == null}
                onClick={() => leaveOut(m)} aria-label={`Leave ${m.name} out of ${name}`}>Leave out</button>
            </li>
          ))}
        </ul>
      )}
      {cards != null && cards > members.length && (
        <div className="attr-faint">and {cards - members.length} more</div>
      )}
    </div>
  );
}

const EDITABLE = new Set(['field', 'rename']);

function ReviewRow({ item, active, selected, onSelect, onDecide, busy, rowRef, onFocus, editing, onStartEdit, onCancelEdit }) {
  const isMerge = item.type === 'merge';
  const isRole = item.type === 'role';
  const isRelation = item.type === 'relation';
  const isTheme = item.type === 'set';
  const isMember = item.type === 'set-member';
  const label = isMerge ? 'Same character' : item.type === 'rename' ? 'Name' : isRole ? 'Folder role'
    : isRelation ? 'Related card' : isTheme ? 'Theme' : isMember ? 'Theme member' : (FIELD_LABELS[item.field] || item.field);
  const rowName = isTheme ? setName(item) : (item.model?.name || '');
  return (
    <li ref={rowRef} className={`review-row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${isMerge ? 'is-merge' : ''}`}
      tabIndex={active ? 0 : -1} onFocus={onFocus} aria-label={`${label}: ${rowName}`}>
      <input type="checkbox" className="review-check" checked={selected} onChange={() => onSelect(item.id)}
        aria-label={`Select suggestion for ${rowName || item.id}`} />
      {isTheme ? (
        <div className="review-body">
          <ThemeProposal item={item} busy={busy} />
          <div className="review-meta"><ConfidenceChip value={item.confidence} /><span className="review-reason">{item.reason}</span></div>
        </div>
      ) : isMerge ? (
        <div className="review-body">
          <div className="merge-compare">
            <MergeCard card={item.model} role="source" />
            <div className="merge-arrow" aria-hidden="true">→</div>
            <MergeCard card={item.target} role="target" />
          </div>
          <div className="review-meta"><ConfidenceChip value={item.confidence} /><SourceChip source={item.source} /><span className="review-reason">{item.reason}</span></div>
        </div>
      ) : (
        <div className="review-body review-body-field">
          <Thumb src={item.model?.thumbnail_path} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="review-title-line">
              <span className="review-name" title={item.model?.name}>{item.model?.name}</span>
              <span className="review-creator">{item.model?.creator_name}</span>
            </div>
            <div className="review-change"><span className="review-field">{label}</span>{isRole ? <RoleChange item={item} />
              : isRelation ? <RelationChange item={item} />
                : isMember ? <span className="diff">Add to theme <ins className="diff-new">{setName(item)}</ins></span>
                  : <ValueDiff item={item} />}</div>
            <div className="review-meta"><ConfidenceChip value={item.confidence} /><SourceChip source={item.source} /><span className="review-reason">{item.reason}</span></div>
            {editing && (
              <ValueEditor field={item.type === 'rename' ? 'name' : item.field} initial={item.field === 'tags' ? addedValues(item.current, item.proposed) : item.proposed}
                busy={busy} onCancel={onCancelEdit} onSubmit={(value) => onDecide([item.id], 'accept', [item], value)} />
            )}
          </div>
        </div>
      )}
      <div className="review-actions">
        <button className="org-btn org-btn-sm org-btn-success" disabled={busy} onClick={() => onDecide([item.id], 'accept', [item])}
          aria-label={`Accept ${label} for ${rowName}`}>✓ {isMerge ? 'Merge' : 'Accept'}</button>
        {EDITABLE.has(item.type) && (
          <button className="org-btn org-btn-sm" disabled={busy || editing} onClick={() => onStartEdit(item.id)}
            aria-label={`Edit ${label} for ${rowName}`}>✎ Edit</button>
        )}
        <button className="org-btn org-btn-sm" disabled={busy} onClick={() => onDecide([item.id], 'reject', [item])}
          aria-label={`Reject ${label} for ${rowName}`}>✕ Reject</button>
      </div>
    </li>
  );
}

function unmergeMessage(r) {
  const x = (r && r.restored) || {};
  const parts = [];
  if (x.files) parts.push(`${x.files} file${x.files !== 1 ? 's' : ''}`);
  if (x.collections) parts.push(`${x.collections} collection${x.collections !== 1 ? 's' : ''}`);
  if (x.queue) parts.push('its print-queue entry');
  let msg = `Unmerged${parts.length ? `: restored ${parts.join(', ')}` : ''}${x.alias ? '; alias removed' : ''}.`;
  const kept = Array.isArray(r && r.notReverted) ? r.notReverted : [];
  if (kept.length) msg += ` Not reverted: ${kept.join('; ')}.`;
  return msg;
}

/** Merges already accepted, each with Unmerge (POST /api/suggestions/:id/unmerge). */
export function AcceptedMerges({ refreshKey, onUnmerged }) {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    apiGet('/api/suggestions?status=accepted&type=merge&limit=20')
      .then(d => { setItems((d && d.items) || []); setTotal((d && d.total) || 0); })
      .catch(() => setItems([]));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const unmerge = async (s) => {
    const ok = await askConfirm({
      title: `Unmerge "${s.model?.name}" from "${s.target?.name}"?`,
      message: (
        <>
          <p><b>{s.model?.name}</b> becomes its own card again, with its files, collections and print-queue entry. The alias is removed, and this merge is not proposed again.</p>
          <p>Tags, notes and print status that were merged into <b>{s.target?.name}</b> stay there.</p>
        </>
      ),
      confirmLabel: 'Unmerge',
      danger: true,
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      const r = await apiSend(`/api/suggestions/${s.id}/unmerge`, 'POST');
      notify(unmergeMessage(r), { type: 'success', duration: 9000 });
      clearReviewCardCache();
      load();
      if (onUnmerged) onUnmerged();
    } catch (e) {
      // an older backend has no unmerge route (plain 404 without a JSON error)
      if (e && e.status === 404 && !(e.body && typeof e.body === 'object' && e.body.error)) {
        setSupported(false);
        notify('Unmerge needs a newer backend; this server does not support it yet.');
      } else notify(`Couldn't unmerge: ${errorMessage(e)}`);
    }
    setBusy(null);
  };

  if (!items || items.length === 0) return null;
  return (
    <div className="review-runs accepted-merges">
      {confirmUi}
      <div className="attr-subtitle">Accepted merges <span className="attr-faint">{total.toLocaleString()}</span></div>
      <ul className="accepted-merge-list">
        {items.map(s => (
          <li key={s.id} className="org-health-row accepted-merge-row">
            <span className="org-health-name" title={`${s.model?.name} → ${s.target?.name}`}>
              {s.model?.name} <span className="diff-arrow" aria-hidden="true">→</span><span className="sr-only"> merged into </span> {s.target?.name}
            </span>
            <span className="org-health-creator">{s.model?.creator_name}</span>
            {s.decidedAt && <span className="attr-faint num">{formatRunDate(s.decidedAt)}</span>}
            {supported && (
              <button className="org-btn org-btn-sm org-btn-danger" disabled={busy != null} onClick={() => unmerge(s)}
                aria-label={`Unmerge ${s.model?.name} from ${s.target?.name}`}>↶ Unmerge</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RunsHistory({ refreshKey, onUndone }) {
  const notify = useNotify();
  const [confirmUi, askConfirm] = useConfirm();
  const [runs, setRuns] = useState(null);
  const load = useCallback(() => {
    apiGet('/api/ai/enrich/runs').then(d => setRuns(Array.isArray(d?.runs) ? d.runs : [])).catch(() => setRuns([]));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const undo = async (r) => {
    const ok = await askConfirm({
      title: `Undo run #${r.id}?`,
      message: (
        <>
          <p>Reverts the <b>{r.applied ?? 0}</b> value{r.applied === 1 ? '' : 's'} this run filled in automatically.</p>
          <p>Fields you or a later run changed since are kept. Suggestions you already accepted stay as they are.</p>
        </>
      ),
      confirmLabel: 'Undo run',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiSend(`/api/ai/enrich/runs/${r.id}/undo`, 'POST');
      notify(`Run #${r.id} undone: ${res?.reverted ?? 0} reverted${res?.skipped ? `, ${res.skipped} kept (changed since)` : ''}`, { type: 'success' });
      load();
      if (onUndone) onUndone();
    } catch (e) { notify(`Couldn't undo run #${r.id}: ${errorMessage(e)}`); }
  };

  if (!runs || runs.length === 0) return null;
  return (
    <div className="review-runs">
      {confirmUi}
      <div className="attr-subtitle">Enrich runs</div>
      <div className="runs-scroll">
      <table className="attr-cov-table runs-table">
        <thead><tr><th scope="col">Run</th><th scope="col">Started</th><th scope="col">Scope</th><th scope="col">Applied</th><th scope="col">Suggested</th><th scope="col">Merges</th><th scope="col">Actual cost</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.id}>
              <th scope="row">#{r.id}</th>
              <td className="num" title={r.model}>{formatRunDate(r.startedAt)}</td>
              <td>{r.scope}{r.status && r.status !== 'complete' ? ` · ${r.status}` : ''}</td>
              <td className="num">{r.applied ?? 0}</td>
              <td className="num">{r.suggested ?? 0}</td>
              <td className="num">{r.merges ?? 0}</td>
              <td className="num" title={actualCost(r) ? 'Tokens and USD actually used' : undefined}>{actualCost(r) || <span className="attr-faint">—</span>}</td>
              <td>
                {r.undone ? <span className="attr-faint">undone</span> : (
                  <button className="org-btn org-btn-sm org-btn-danger" onClick={() => undo(r)} disabled={!r.applied}
                    aria-label={`Undo run ${r.id}`}>↶ Undo</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}


/** Toasts for a group / bulk decision plus what a remembered rule did. */
const pctLabel = v => `${Math.round(v * 100)}%`;

export default function ReviewTab({ onSummary }) {
  const notify = useNotify();
  const notifyRescan = useNotifyRescan();
  const [confirmUi, askConfirm] = useConfirm();
  const [summary, setSummary] = useState(null);
  const [group, setGroup] = useState(null);
  const [creator, setCreator] = useState('');
  const [minConf, setMinConf] = useState(0); // 0 = everything; the slider sets Casey's own floor
  const [creators, setCreators] = useState([]);
  const [view, setView] = useState('list'); // 'answers' | 'list'
  const [answer, setAnswer] = useState(null); // { proposed?, tag?, label }: one answer opened one by one
  const [groupsSupported, setGroupsSupported] = useState(true);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [active, setActive] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runsKey, setRunsKey] = useState(0);
  const [groupsKey, setGroupsKey] = useState(0);
  const [rulesKey, setRulesKey] = useState(0);
  const [nudge, setNudge] = useState(null);
  const rowRefs = useRef([]);
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;

  const loadSummary = useCallback(async () => {
    try {
      const s = await apiGet('/api/suggestions/summary');
      setSummary(s);
      if (onSummaryRef.current) onSummaryRef.current(s);
      return s;
    } catch (e) { setError(errorMessage(e)); return null; }
  }, []);

  useEffect(() => {
    loadSummary().then(s => {
      const first = REVIEW_GROUPS.find(g => (g.count(s) || 0) > 0) || REVIEW_GROUPS[0];
      setGroup(g => g || first.id);
    });
    apiGet('/api/creators').then(d => setCreators(Array.isArray(d) ? d : [])).catch(() => {});
  }, [loadSummary]);

  const groupDef = REVIEW_GROUPS.find(g => g.id === group);
  const field = fieldOf(groupDef);
  const canGroup = groupable(groupDef) && groupsSupported;
  const showAnswers = canGroup && view === 'answers' && !answer;

  // a new group opens in its default view, with no answer picked
  useEffect(() => {
    if (!groupDef) return;
    setView(GROUPED_BY_DEFAULT.has(groupDef.id) ? 'answers' : 'list');
    setAnswer(null); setEditingId(null);
  }, [groupDef]);

  const filter = useMemo(() => groupDef ? {
    ...groupDef.filter, ...(creator && { creator }), ...(minConf > 0 && { minConfidence: minConf }),
    ...(answer && answer.tag != null ? { tag: answer.tag } : {}), ...(answer && answer.proposed != null ? { proposed: answer.proposed } : {}),
  } : null, [groupDef, creator, minConf, answer]);

  const load = useCallback(async (pageNum = 1) => {
    if (!filter) return;
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ status: 'pending', ...filter, page: pageNum, limit: PAGE });
      const d = await apiGet(`/api/suggestions?${qs}`);
      const list = (d && d.items) || [];
      setItems(prev => (pageNum === 1 ? list : [...prev, ...list.filter(x => !prev.some(p => p.id === x.id))]));
      setTotal((d && d.total) || 0);
      setPages((d && d.pages) || 1);
      setPage(pageNum);
      if (pageNum === 1) { setSelected(new Set()); setActive(0); }
    } catch (e) { setError(errorMessage(e)); }
    setLoading(false);
  }, [filter]);

  useEffect(() => { if (!showAnswers) load(1); }, [load, showAnswers]);

  const [mergesKey, setMergesKey] = useState(0);
  const refreshAll = useCallback(() => {
    loadSummary(); setGroupsKey(k => k + 1); setRunsKey(k => k + 1); setRulesKey(k => k + 1);
    if (!showAnswers) load(1);
  }, [loadSummary, load, showAnswers]);

  /** After a single decision: offer a rule built from it. */
  const offerNudge = useCallback((row, decision, value) => {
    if (!row || !EDITABLE.has(row.type)) { setNudge(null); return; }
    const f = row.type === 'rename' ? 'name' : row.field;
    const proposed = f === 'tags' ? addedValues(row.current, row.proposed) : row.proposed;
    const kind = value !== undefined ? 'edit' : decision;
    const options = nudgeOptions({ decision: kind, field: f, proposed, value, card: row.model });
    if (!options.length) { setNudge(null); return; }
    const what = kind === 'reject' ? `Rejected “${showValue(proposed)}” as ${fieldWord(f)}`
      : kind === 'edit' ? `Set ${fieldWord(f)} “${showValue(value)}” instead of “${showValue(proposed)}”`
        : `Accepted ${fieldWord(f)} “${showValue(proposed)}”`;
    setNudge({ text: `${what} for ${row.model?.name || 'this card'}.`, options });
  }, []);

  const runDecide = useCallback(async (ids, decision, rows = [], value) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const body = { ids, decision, ...(value !== undefined && decision === 'accept' ? { value } : {}) };
      const r = await apiSend('/api/suggestions/decide', 'POST', body);
      // superseded ("changed since") rows are no longer pending: they leave the list too
      const failed = new Set(splitDecideErrors(r).failed.map(e => e.id));
      setItems(prev => prev.filter(x => !ids.includes(x.id) || failed.has(x.id)));
      setTotal(t => Math.max(0, t - (ids.length - failed.size)));
      setSelected(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
      setEditingId(null);
      const merge = rows.length === 1 && rows[0].type === 'merge' && decision === 'accept' && r?.merged;
      const toasts = decideToasts(r);
      if (merge) {
        notify(`Merged "${rows[0].model?.name}" into "${rows[0].target?.name}". Its tags, notes and collections moved with it; Unmerge is under History.`, { type: 'success' });
        toasts.filter(t => t.type !== 'success').forEach(t => notify(t.message, { type: t.type }));
      } else toasts.forEach(t => notify(t.message, { type: t.type }));
      if (r?.merged) { clearReviewCardCache(); setMergesKey(k => k + 1); }
      if (decision === 'accept' && r?.accepted && rows.some(x => x.type === 'role')) {
        notifyRescan('Folder roles saved. They apply on the next scan.');
      }
      if (rows.length === 1 && ids.length === 1 && !failed.size) offerNudge(rows[0], decision, value);
      else setNudge(null);
      if (value !== undefined) clearValuesCache();
      loadSummary();
      setRunsKey(k => k + 1);
      setGroupsKey(k => k + 1);
    } catch (e) { notify(`Couldn't ${decision} suggestions: ${errorMessage(e)}`); }
    setBusy(false);
  }, [loadSummary, notify, notifyRescan, offerNudge]);

  // Accepting more than one suggestion, or any merge, asks first (merges are only reversible by Unmerge)
  const decide = useCallback(async (ids, decision, rows = [], value) => {
    if (!ids.length) return;
    if (decision === 'accept') {
      const merges = rows.filter(r => r.type === 'merge');
      if (merges.length || ids.length > 1) {
        const single = ids.length === 1 && merges.length === 1 ? merges[0] : null;
        const ok = await askConfirm({
          title: single ? `Merge "${single.model?.name}" into "${single.target?.name}"?` : `Accept ${ids.length} selected suggestion${ids.length !== 1 ? 's' : ''}?`,
          message: (
            <>
              {!single && <p>Accepts <b>{ids.length - merges.length}</b> field change{ids.length - merges.length !== 1 ? 's' : ''}{merges.length ? <> and <b>{merges.length}</b> merge{merges.length !== 1 ? 's' : ''}</> : null}.</p>}
              {merges.length > 0 && (
                <p>{merges.length} merge{merges.length !== 1 ? 's' : ''} will fold cards (a DB snapshot is taken first). Tags, notes and collections move to the card that stays; the alias is remembered for future scans. You can Unmerge later from History.</p>
              )}
            </>
          ),
          confirmLabel: single ? 'Merge' : `Accept ${ids.length}`,
        });
        if (!ok) return;
      }
    }
    await runDecide(ids, decision, rows, value);
  }, [askConfirm, runDecide]);

  /** Save a rule quietly as part of another action; reports what it did. */
  const saveRule = useCallback(async (rule) => {
    try {
      const r = await apiSend('/api/review-rules', 'POST', rule);
      notify(appliedMessage(r && r.applied), { type: 'success', duration: 7000 });
      return true;
    } catch (e) {
      notify(e && e.status === 404 ? 'Rules need a newer backend; the decision was saved without one.' : `Couldn't save the rule: ${errorMessage(e)}`);
      return false;
    }
  }, [notify]);

  /** A whole answer group: accept (maybe with another value), or reject (maybe never again). */
  const decideGroup = useCallback(async (g, decision, { value, remember } = {}) => {
    if (!groupDef) return;
    const isTags = field === 'tags';
    const label = isTags ? g.tag : showValue(g.proposed);
    const word = fieldWord(field);
    const n = g.count;
    const never = { current: canRule('block', field) };
    const ok = await askConfirm(decision === 'accept' ? {
      title: value !== undefined ? `Use “${showValue(value)}” for ${n} card${n !== 1 ? 's' : ''}?` : `Accept “${label}” for ${n} card${n !== 1 ? 's' : ''}?`,
      message: (
        <>
          <p>Sets the {word} {value !== undefined ? <>to <b>{showValue(value)}</b> (instead of “{label}”)</> : <><b>{label}</b></>} on <b>{n}</b> card{n !== 1 ? 's' : ''}{creator ? <> from <b>{creator}</b></> : null}{minConf > 0 ? <> at {pctLabel(minConf)} confidence or more</> : null}.</p>
          {!isTags && g.fromEmpty < n && <p>{n - g.fromEmpty} of them replace an existing {word}.</p>}
          {remember && <p>And remembers: use “{showValue(value)}” whenever the AI says “{label}”.</p>}
        </>
      ),
      confirmLabel: `Accept ${n}`,
    } : {
      title: `Reject “${label}” for ${n} card${n !== 1 ? 's' : ''}?`,
      message: (
        <>
          <p>Rejects {n} pending {word} suggestion{n !== 1 ? 's' : ''}{creator ? <> from <b>{creator}</b></> : null}. Rejected values are not proposed again for these cards.</p>
          {canRule('block', field) && (
            <label className="answer-remember">
              <input type="checkbox" defaultChecked onChange={e => { never.current = e.target.checked; }} />
              Never propose “{label}” as a {word} for any card (a rule)
            </label>
          )}
        </>
      ),
      confirmLabel: `Reject ${n}`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const f = {
        ...groupDef.filter, ...(creator && { creator }), ...(minConf > 0 && { minConfidence: minConf }),
        ...(isTags ? { tag: g.tag } : { proposed: g.key }),
      };
      const r = await apiSend('/api/suggestions/decide-filter', 'POST', { filter: f, decision, ...(value !== undefined ? { value } : {}) });
      decideToasts(r).forEach(t => notify(t.message, { type: t.type }));
      if (decision === 'reject' && never.current) await saveRule({ kind: 'block', field, match: label });
      if (decision === 'accept' && remember && value !== undefined) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v != null && String(v).toLowerCase() !== String(label).toLowerCase()) await saveRule({ kind: 'map', field, match: label, value: v });
      }
      if (value !== undefined) clearValuesCache();
      setNudge(null);
      refreshAll();
    } catch (e) { notify(`Couldn't ${decision}: ${errorMessage(e)}`); }
    setBusy(false);
  }, [groupDef, field, creator, minConf, askConfirm, notify, saveRule, refreshAll]);

  /** Everything the current filter shows (all creators / floor / answer applied). */
  const acceptShown = async () => {
    if (!filter) return;
    let n = 0;
    try {
      const qs = new URLSearchParams({ status: 'pending', ...filter, limit: 1 });
      n = (await apiGet(`/api/suggestions?${qs}`))?.total || 0;
    } catch (e) { notify(errorMessage(e)); return; }
    if (!n) { notify('Nothing to accept with these filters.', { type: 'info' }); return; }
    const what = groupDef.label.toLowerCase();
    const ok = await askConfirm({
      title: `Accept ${n} ${what}${minConf > 0 ? ` at ${pctLabel(minConf)}+` : ''}?`,
      message: (
        <>
          <p>Accepts <b>{n}</b> pending suggestion{n !== 1 ? 's' : ''} in <b>{groupDef.label}</b>{minConf > 0 ? <> with confidence of {pctLabel(minConf)} or more</> : null}{creator ? <> from <b>{creator}</b></> : ''}{answer ? <> answering <b>{answer.label}</b></> : null}.</p>
          {groupDef.id === 'merges' && <p>{n} merge{n !== 1 ? 's' : ''} will fold cards (a DB snapshot is taken first). Tags, notes and collections are kept and the alias is remembered for future scans; each can be undone with Unmerge.</p>}
          {minConf > 0 && summary && <p>Lower-confidence suggestions stay in the list.</p>}
        </>
      ),
      confirmLabel: `Accept ${n}`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await apiSend('/api/suggestions/decide-filter', 'POST', { filter: { ...filter, status: 'pending' }, decision: 'accept' });
      decideToasts(r).forEach(t => notify(t.message, { type: t.type }));
      if (r?.merged) { clearReviewCardCache(); setMergesKey(k => k + 1); }
      if (r?.accepted && groupDef.id === 'roles') notifyRescan('Folder roles saved. They apply on the next scan.');
      setNudge(null);
      refreshAll();
    } catch (e) { notify(`Couldn't accept: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const toggleSelect = useCallback((id) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }), []);

  const focusRow = (i) => {
    const idx = Math.max(0, Math.min(items.length - 1, i));
    setActive(idx);
    const el = rowRefs.current[idx];
    if (el) el.focus();
  };

  const onKeyDown = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'textarea' || (tag === 'input' && e.target.type !== 'checkbox')) return;
    if (e.metaKey || e.ctrlKey || e.altKey || busy) return;
    const item = items[active];
    switch (e.key) {
      case 'j': case 'ArrowDown': e.preventDefault(); focusRow(active + 1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); focusRow(active - 1); break;
      case 'a': if (item) { e.preventDefault(); decide([item.id], 'accept', [item]); } break;
      case 'r': if (item) { e.preventDefault(); decide([item.id], 'reject', [item]); } break;
      case 'e': if (item && EDITABLE.has(item.type)) { e.preventDefault(); setEditingId(item.id); } break;
      case 'x': if (item) { e.preventDefault(); toggleSelect(item.id); } break;
      default:
    }
  };

  // keep the active row in range (and focused) after rows disappear
  useEffect(() => {
    if (active >= items.length && items.length) setActive(items.length - 1);
  }, [items.length, active]);

  const onUnsupported = useCallback(() => { setGroupsSupported(false); setView('list'); }, []);
  const openAnswer = useCallback((g) => {
    setAnswer(field === 'tags' ? { tag: g.tag, label: `+ ${g.tag}` } : { proposed: g.key, label: showValue(g.proposed) });
    setView('list');
  }, [field]);
  const backToAnswers = () => { setAnswer(null); setView('answers'); };

  const selectedIds = [...selected];
  const groups = REVIEW_GROUPS.filter(g => !g.optional || (g.count(summary) || 0) > 0);
  const best = summary && Number.isFinite(Number(summary.maxConfidence)) ? Number(summary.maxConfidence) : null;

  const history = (
    <details className="review-history">
      <summary>History <span className="attr-faint">accepted merges and Enrich runs</span></summary>
      <AcceptedMerges refreshKey={mergesKey} onUnmerged={() => { loadSummary(); setRunsKey(k => k + 1); }} />
      <RunsHistory refreshKey={runsKey} onUndone={() => { loadSummary(); if (!showAnswers) load(1); setGroupsKey(k => k + 1); }} />
    </details>
  );

  if (summary && summary.pending === 0) {
    return (
      <div className="org-tab-body review-tab">
        <div className="org-empty">Nothing to review. Run Enrich metadata (Scan Library → AI) to get suggestions.</div>
        <RulesPanel refreshKey={rulesKey} onChanged={refreshAll} />
        {history}
      </div>
    );
  }

  return (
    <div className="org-tab-body review-tab">
      {confirmUi}
      <p className="org-desc">
        AI suggestions that would change an existing value, merge cards, or were not confident enough to apply on their own.
        {summary ? <> <b>{summary.pending.toLocaleString()}</b> pending.</> : null}
        {best != null && best > 0 && best < HIGH_MIN ? <> None is above {pctLabel(HIGH_MIN)} (the best is {pctLabel(best)}), so decide by answer, or set your own floor with the slider.</> : null}
      </p>

      <div className="org-health-sections" role="tablist" aria-label="Suggestion groups">
        {groups.map(g => {
          const n = g.count(summary) || 0;
          return (
            <button key={g.id} role="tab" aria-selected={group === g.id}
              className={`org-health-section-btn ${group === g.id ? 'active' : ''}`} onClick={() => setGroup(g.id)}>
              {g.label}<span className={`org-health-badge ${n > 0 ? 'warn' : 'ok'}`}>{n}</span>
            </button>
          );
        })}
      </div>

      <div className="review-toolbar">
        {canGroup && (
          <div className="seg" role="group" aria-label="Show suggestions">
            <button type="button" className={`seg-btn ${view === 'answers' && !answer ? 'active' : ''}`} aria-pressed={view === 'answers' && !answer} onClick={backToAnswers}>By answer</button>
            <button type="button" className={`seg-btn ${view === 'list' || answer ? 'active' : ''}`} aria-pressed={view === 'list' || !!answer} onClick={() => { setAnswer(null); setView('list'); }}>One by one</button>
          </div>
        )}
        <select className="gallery-select" value={creator} onChange={e => setCreator(e.target.value)} aria-label="Filter suggestions by creator">
          <option value="">All creators</option>
          {creators.map(c => <option key={c.id ?? c.name} value={c.name}>{c.name}</option>)}
        </select>
        <label className="conf-slider">
          <span>Min. confidence</span>
          <input type="range" min="0" max="0.95" step="0.05" value={minConf} onChange={e => setMinConf(Number(e.target.value))}
            aria-label="Minimum confidence" aria-valuetext={minConf > 0 ? pctLabel(minConf) : 'any'} />
          <span className="num conf-slider-value">{minConf > 0 ? `${pctLabel(minConf)}+` : 'any'}</span>
        </label>
        {!showAnswers && <span className="attr-faint">{total.toLocaleString()} in {groupDef?.label || ''}</span>}
        <span className="review-toolbar-spacer" />
        {selectedIds.length > 0 && !showAnswers ? (
          <>
            <button className="org-btn org-btn-sm org-btn-success" disabled={busy} onClick={() => decide(selectedIds, 'accept', items.filter(i => selected.has(i.id)))}>✓ Accept {selectedIds.length}</button>
            <button className="org-btn org-btn-sm" disabled={busy} onClick={() => decide(selectedIds, 'reject', items.filter(i => selected.has(i.id)))}>✕ Reject {selectedIds.length}</button>
            <button className="link-btn attr-faint" onClick={() => setSelected(new Set())}>clear</button>
          </>
        ) : (
          <button className="org-btn org-btn-sm org-btn-accent" disabled={busy || (!showAnswers && !total)} onClick={acceptShown}>
            ✓ Accept all{minConf > 0 ? ` ${pctLabel(minConf)}+` : ''} in {answer ? answer.label : groupDef?.label || 'group'}
          </button>
        )}
      </div>

      {answer && (
        <div className="answer-filter" role="status">
          Showing <ins className="diff-new">{answer.label}</ins> one by one.
          <button className="link-btn" onClick={backToAnswers}>‹ Back to answers</button>
        </div>
      )}

      <NudgeBar nudge={nudge} onDismiss={() => setNudge(null)} onSaved={() => refreshAll()} />

      {error && <div className="org-error">{error}</div>}

      {showAnswers ? (
        <div className="org-health-list review-list-wrap">
          <AnswerGroups type={groupDef.filter.type} field={field} creator={creator} minConfidence={minConf} refreshKey={groupsKey}
            busy={busy} onDecide={decideGroup} onReviewOne={openAnswer} onUnsupported={onUnsupported} />
        </div>
      ) : (
        <>
          <div className="review-help" id="review-help">Keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> accept · <kbd>r</kbd> reject · <kbd>e</kbd> edit · <kbd>x</kbd> select</div>
          <div className="org-health-list review-list-wrap">
            {items.length === 0 && !loading ? (
              <div className="org-empty">Nothing pending in {groupDef?.label || 'this group'}{creator ? ` for ${creator}` : ''}{minConf > 0 ? ` at ${pctLabel(minConf)}+` : ''}.</div>
            ) : (
              <ul className="review-list" onKeyDown={onKeyDown} aria-describedby="review-help" aria-label={`${groupDef?.label || ''} suggestions`}>
                {items.map((it, i) => (
                  <ReviewRow key={it.id} item={it} active={i === active} selected={selected.has(it.id)}
                    onSelect={toggleSelect} onDecide={decide} busy={busy}
                    editing={editingId === it.id} onStartEdit={setEditingId} onCancelEdit={() => setEditingId(null)}
                    rowRef={el => { rowRefs.current[i] = el; }} onFocus={() => setActive(i)} />
                ))}
              </ul>
            )}
            {loading && <div className="org-hint-inline" style={{ padding: 8 }}>Loading…</div>}
            {!loading && page < pages && (
              <button className="sec-more-btn" onClick={() => load(page + 1)}>▼ Load more ({(total - items.length).toLocaleString()} left)</button>
            )}
          </div>
        </>
      )}

      <RulesPanel refreshKey={rulesKey} onChanged={refreshAll} />
      {history}
    </div>
  );
}
