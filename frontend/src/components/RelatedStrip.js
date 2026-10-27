import React, { useState, useEffect, useRef } from 'react';
import { apiGet, apiSend, errorMessage } from '../api';
import { useNotify } from './Notices';
import { useUniqueId } from './Modal';
import AddToSet from './AddToSet';
import { cardEditions } from '../library';
import { cardImages } from '../thumbs';
import { decideToasts, splitDecideErrors, pct } from '../enrich';
import {
  relatedSections, sourceInfo, linkForSection, LINK_OPTIONS, linkBody, defaultLinkOption,
  setChipLabel, pendingLabel, suggestionOther,
} from '../relations';

// Card detail "Related" strip (docs/relations.md section 5): dioramas, figures,
// other releases, accessories, set chips, pending suggestions, Add link, Add to set.

function MiniThumb({ card }) {
  const [bad, setBad] = useState(false);
  const src = cardImages(card)[0] || card.thumbnail_path;
  if (!src || bad) return <span className="rel-thumb ph" aria-hidden="true">🧩</span>;
  return <img className="rel-thumb" src={src} alt="" loading="lazy" onError={() => setBad(true)} />;
}

function RelatedItem({ card, removed, busy, onOpen, onRemove, onUndo }) {
  const src = sourceInfo(card.source);
  const eds = cardEditions(card);
  return (
    <li className={`rel-item ${removed ? 'is-removed' : ''}`}>
      <button type="button" className="rel-open" onClick={() => onOpen(card)} disabled={!onOpen || removed}
        aria-label={`Open ${card.name}`}>
        <MiniThumb card={card} />
        <span className="rel-text">
          <span className="rel-name" title={card.name}>{card.name}</span>
          {(card.release_label || card.creator_name) && (
            <span className="rel-sub">{[card.creator_name, card.release_label].filter(Boolean).join(' · ')}</span>
          )}
          {eds.length > 0 && (
            <span className="rel-eds">{eds.map(e => <span key={e} className={`edition-chip ed-${e.toLowerCase()}`}>{e}</span>)}</span>
          )}
        </span>
      </button>
      <span className="rel-actions">
        {removed ? (
          <>
            <span className="rel-removed-note">Removed</span>
            <button type="button" className="link-btn rel-undo" disabled={busy} onClick={onUndo}
              aria-label={`Undo removing ${card.name}`}>Undo</button>
          </>
        ) : (
          <>
            <span className="rel-source" role="img" aria-label={src.label}
              title={`${src.label}${card.confidence != null && card.source !== 'user' ? ` (${pct(card.confidence)})` : ''}`}>{src.icon}</span>
            {card.relationId != null && (
              <button type="button" className="rel-remove" disabled={busy} onClick={onRemove}
                aria-label={`Remove link to ${card.name}`} title="Remove this link">✕</button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

function AddLinkPicker({ model, onLinked, onCancel }) {
  const notify = useNotify();
  const id = useUniqueId('add-link');
  const [opt, setOpt] = useState(() => defaultLinkOption(model.kind));
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  useEffect(() => {
    if (!q.trim()) { setResults(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ search: q.trim(), limit: '12', page: '1' });
      apiGet(`/api/models?${qs}`)
        .then(d => { if (alive) setResults(((d && d.models) || []).filter(m => m.id !== model.id)); })
        .catch(() => { if (alive) setResults([]); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, model.id]);

  const link = async (other) => {
    setBusy(true);
    try {
      await apiSend('/api/relations', 'POST', linkBody(opt, model.id, other.id));
      notify(`Linked ${other.name}`, { type: 'success' });
      onLinked();
    } catch (e) { notify(`Couldn't add the link: ${errorMessage(e)}`); }
    setBusy(false);
  };

  return (
    <div className="rel-picker" role="group" aria-label="Add link"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <div className="rel-picker-row">
        <label htmlFor={`${id}-type`} className="sr-only">Link type</label>
        <select id={`${id}-type`} className="gallery-select" value={opt} onChange={e => setOpt(e.target.value)}>
          {LINK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label htmlFor={`${id}-q`} className="sr-only">Find a card to link</label>
        <input id={`${id}-q`} ref={inputRef} type="search" className="search-input rel-picker-input" value={q}
          onChange={e => setQ(e.target.value)} placeholder="Find any card, any creator" />
        <button type="button" className="chip-btn" onClick={onCancel}>Cancel</button>
      </div>
      {results && (
        <ul className="rel-picker-results" aria-label="Cards to link">
          {results.length === 0 && <li className="attr-faint">No cards match</li>}
          {results.map(m => (
            <li key={m.id}>
              <button type="button" className="rel-picker-result" disabled={busy} onClick={() => link(m)}
                aria-label={`Link ${m.name}${m.creator_name ? ` by ${m.creator_name}` : ''}`}>
                <MiniThumb card={m} />
                <span className="rel-name">{m.name}</span>
                <span className="rel-sub">{m.creator_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RelatedStrip({ model, onOpenModel, onChanged, onShowSet, onShowRelated, onSuggestionsChange }) {
  const notify = useNotify();
  const [removed, setRemoved] = useState([]); // [{ section, card }]
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const related = model && model.related;

  useEffect(() => { setRemoved([]); setAdding(false); }, [model && model.id]);

  if (!related || typeof related !== 'object') return null;
  const sections = relatedSections(related);
  const sets = Array.isArray(related.sets) ? related.sets.filter(Boolean) : [];
  const pending = Array.isArray(model.relatedPending) ? model.relatedPending.filter(Boolean) : [];
  const refresh = () => { if (onChanged) return onChanged(); return undefined; };

  // Removed rows stay in place (with Undo) until the strip reloads for another card.
  const isRemoved = (section, card) => removed.some(r => r.section === section && r.card.id === card.id);
  const merged = sections.map(s => ({ ...s }));
  for (const r of removed) {
    let s = merged.find(x => x.key === r.section);
    if (!s) { s = { key: r.section, label: r.label, items: [] }; merged.push(s); }
    if (!s.items.some(c => c.id === r.card.id)) s.items = [...s.items, r.card];
  }

  const remove = async (section, card) => {
    setBusy(true);
    try {
      await apiSend(`/api/relations/${card.relationId}`, 'DELETE');
      setRemoved(prev => [...prev, { section: section.key, label: section.label, card }]);
      await refresh();
    } catch (e) { notify(`Couldn't remove the link: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const undo = async (sectionKey, card) => {
    setBusy(true);
    try {
      await apiSend('/api/relations', 'POST', linkForSection(sectionKey, model.id, card));
      setRemoved(prev => prev.filter(r => !(r.section === sectionKey && r.card.id === card.id)));
      await refresh();
    } catch (e) { notify(`Couldn't restore the link: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const decide = async (s, decision) => {
    setBusy(true);
    try {
      const r = await apiSend('/api/suggestions/decide', 'POST', { ids: [s.id], decision });
      const { failed } = splitDecideErrors(r);
      if (failed.length) notify(`Couldn't ${decision}: ${failed[0].error}`);
      else decideToasts(r).forEach(t => notify(t.message, { type: t.type }));
      if (onSuggestionsChange) onSuggestionsChange();
      await refresh();
    } catch (e) { notify(`Couldn't ${decision} the suggestion: ${errorMessage(e)}`); }
    setBusy(false);
  };

  const empty = !merged.length && !sets.length && !pending.length;

  return (
    <section className="detail-card related-strip" aria-labelledby={`related-title-${model.id}`}>
      <div className="related-head">
        <h2 className="detail-card-title related-title" id={`related-title-${model.id}`}>Related</h2>
        <div className="related-tools">
          {onShowRelated && merged.length > 0 && (
            <button type="button" className="chip-btn" onClick={() => onShowRelated(model)}>Show related in gallery</button>
          )}
          <button type="button" className="chip-btn" aria-expanded={adding} onClick={() => setAdding(a => !a)}>+ Add link</button>
          <AddToSet ids={[model.id]} creator={model.creator_name} onDone={refresh} />
        </div>
      </div>

      {sets.length > 0 && (
        <div className="related-sets" role="group" aria-label="Sets">
          {sets.map(s => (onShowSet ? (
            <button key={s.id} type="button" className={`set-chip set-${s.kind}`} onClick={() => onShowSet(s)}
              title="Show this set in the gallery">{setChipLabel(s)}</button>
          ) : (
            <span key={s.id} className={`set-chip set-${s.kind}`}>{setChipLabel(s)}</span>
          )))}
        </div>
      )}

      {adding && <AddLinkPicker model={model} onCancel={() => setAdding(false)} onLinked={() => { setAdding(false); refresh(); }} />}

      {pending.length > 0 && (
        <ul className="related-pending" aria-label="Suggested links">
          {pending.map(s => {
            const other = suggestionOther(s, model.id);
            const label = pendingLabel(s, model.id);
            return (
              <li key={s.id} className="rel-pending">
                <span className="rel-pending-tag">Suggested</span>
                {other && onOpenModel && s.type === 'relation' ? (
                  <button type="button" className="link-btn rel-pending-label" onClick={() => onOpenModel(other)}>{label}</button>
                ) : <span className="rel-pending-label">{label}</span>}
                {s.confidence != null && <span className="attr-faint">{pct(s.confidence)}</span>}
                {s.reason && <span className="rel-pending-reason">{s.reason}</span>}
                <span className="rel-pending-actions">
                  <button type="button" className="org-btn org-btn-sm org-btn-success" disabled={busy}
                    onClick={() => decide(s, 'accept')} aria-label={`Accept: ${label}`}>✓ Accept</button>
                  <button type="button" className="org-btn org-btn-sm" disabled={busy}
                    onClick={() => decide(s, 'reject')} aria-label={`Reject: ${label}`}>✕ Reject</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {merged.map(s => (
        <div key={s.key} className="related-section">
          <h3 className="related-section-label" id={`rel-${model.id}-${s.key}`}>{s.label}</h3>
          <ul className="related-list" aria-labelledby={`rel-${model.id}-${s.key}`}>
            {s.items.map(card => (
              <RelatedItem key={`${s.key}-${card.id}`} card={card} busy={busy}
                removed={isRemoved(s.key, card)}
                onOpen={onOpenModel}
                onRemove={() => remove(s, card)}
                onUndo={() => undo(s.key, card)} />
            ))}
          </ul>
        </div>
      ))}

      {empty && !adding && <div className="attr-faint related-empty">No linked cards yet.</div>}
    </section>
  );
}
