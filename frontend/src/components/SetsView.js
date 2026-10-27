import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiGet, errorMessage, isAbortError } from '../api';
import { cardEditions } from '../library';
import { cardImages } from '../thumbs';
import { useUniqueId } from './Modal';
import { setKindLabel, setSummaryLine, parseSetDetail, setChipLabel } from '../relations';

// Gallery "Sets" view (docs/relations.md sections 5 and 7.4): one row per set
// (release, theme, diorama) with a header and a strip of member cards. Theme
// rows load GET /api/sets/:id to group members by release, then loose cards.

const PAGE = 20;

const KIND_FILTER = [
  { value: '', label: 'All sets' },
  { value: 'diorama', label: 'Dioramas' },
  { value: 'release', label: 'Releases' },
  { value: 'theme', label: 'Themes' },
];

function SetCard({ card, onOpen, lead }) {
  const [bad, setBad] = useState(false);
  const src = cardImages(card)[0] || card.thumbnail_path;
  const eds = cardEditions(card);
  return (
    <li className={`set-card ${lead ? 'is-lead' : ''}`}>
      <button type="button" className="set-card-btn" onClick={() => onOpen && onOpen(card)} aria-label={`Open ${card.name}`}>
        {src && !bad
          ? <img className="set-card-img" src={src} alt="" loading="lazy" onError={() => setBad(true)} />
          : <span className="set-card-img ph" aria-hidden="true">🧩</span>}
        <span className="set-card-name" title={card.name}>{card.name}</span>
        {eds.length > 0 && <span className="set-card-eds">{eds.join(' · ')}</span>}
      </button>
    </li>
  );
}

function CardStrip({ cards, onOpen, label, leadId }) {
  if (!cards.length) return null;
  return (
    <ul className="set-strip" aria-label={label}>
      {cards.map(c => <SetCard key={c.id} card={c} onOpen={onOpen} lead={leadId != null && c.id === leadId} />)}
    </ul>
  );
}

/** Theme detail grouped by release, then loose cards. */
function ThemeMembers({ set, onOpen }) {
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    apiGet(`/api/sets/${encodeURIComponent(set.id)}`)
      .then(d => { if (alive) setDetail(parseSetDetail(d)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [set.id]);
  const fallback = Array.isArray(set.members) ? set.members : [];
  if (failed || !detail) return <CardStrip cards={fallback} onOpen={onOpen} label={`${set.name} members`} />;
  if (!detail.releases.length && !detail.loose.length) {
    return <CardStrip cards={detail.members.length ? detail.members : fallback} onOpen={onOpen} label={`${set.name} members`} />;
  }
  return (
    <div className="set-groups">
      {detail.releases.map(r => (
        <div key={r.id} className="set-group">
          <div className="set-group-label">{setChipLabel({ kind: 'release', name: r.name, term: r.term })}<span className="attr-faint"> · {r.members.length}</span></div>
          <CardStrip cards={r.members} onOpen={onOpen} label={`${r.name} cards`} />
        </div>
      ))}
      {detail.loose.length > 0 && (
        <div className="set-group">
          <div className="set-group-label">Loose cards<span className="attr-faint"> · {detail.loose.length}</span></div>
          <CardStrip cards={detail.loose} onOpen={onOpen} label={`${set.name} loose cards`} />
        </div>
      )}
    </div>
  );
}

function SetRow({ set, onOpen, onShowSet }) {
  const members = Array.isArray(set.members) ? set.members.filter(Boolean) : [];
  const accessories = Array.isArray(set.accessories) ? set.accessories.filter(Boolean) : [];
  let cards = members;
  if (set.kind === 'diorama' && set.diorama) {
    cards = [set.diorama, ...members.filter(m => m.id !== set.diorama.id), ...accessories.filter(a => !members.some(m => m.id === a.id))];
  }
  const headId = `set-row-${String(set.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <section className={`set-row set-row-${set.kind}`} aria-labelledby={headId}>
      <header className="set-row-head">
        <span className={`set-chip set-${set.kind}`}>{setKindLabel(set.kind)}</span>
        <h3 className="set-row-name" id={headId}>{set.name}</h3>
        <span className="set-row-meta">{setSummaryLine(set)}</span>
        {onShowSet && (
          <button type="button" className="link-btn set-row-show" onClick={() => onShowSet(set)}
            aria-label={`Show ${set.name} as cards`}>Show as cards</button>
        )}
      </header>
      {set.kind === 'theme'
        ? <ThemeMembers set={set} onOpen={onOpen} />
        : <CardStrip cards={cards} onOpen={onOpen} label={`${set.name} members`} leadId={set.kind === 'diorama' && set.diorama ? set.diorama.id : null} />}
    </section>
  );
}

export default function SetsView({ filters, onModelClick, onShowSet }) {
  const kindId = useUniqueId('sets-kind');
  const [kind, setKind] = useState(() => {
    try { return localStorage.getItem('vault_sets_kind') || ''; } catch { return ''; }
  });
  const [includeSolo, setIncludeSolo] = useState(false);
  const [items, setItems] = useState([]);
  const [solo, setSolo] = useState([]);
  const [soloTotal, setSoloTotal] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  const pickKind = (k) => { setKind(k); try { localStorage.setItem('vault_sets_kind', k); } catch {} };
  const creator = filters.creator || filters.studio || '';
  const genre = filters.franchise || '';
  const search = filters.search || '';

  const load = useCallback(async (pageNum) => {
    if (abortRef.current) abortRef.current.abort();
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ctl;
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({
        page: String(pageNum), limit: String(PAGE),
        ...(kind && { kind }), ...(creator && { creator }), ...(genre && { genre }), ...(search && { search }),
        ...(includeSolo && { includeSolo: '1' }),
      });
      const d = await apiGet(`/api/sets?${qs}`, { signal: ctl?.signal });
      const list = Array.isArray(d && d.items) ? d.items : [];
      setItems(prev => (pageNum === 1 ? list : [...prev, ...list.filter(x => !prev.some(p => p.id === x.id))]));
      setTotal((d && d.total) || list.length);
      setPages((d && d.pages) || 1);
      setPage(pageNum);
      if (pageNum === 1) {
        setSolo(Array.isArray(d && d.solo) ? d.solo : []);
        setSoloTotal((d && d.soloTotal) || (Array.isArray(d && d.solo) ? d.solo.length : 0));
      }
    } catch (e) {
      if (!isAbortError(e)) setError(errorMessage(e));
    }
    setLoading(false);
  }, [kind, creator, genre, search, includeSolo]);

  useEffect(() => { load(1); }, [load]);
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  return (
    <div className="sets-view">
      <div className="sets-toolbar">
        <label htmlFor={kindId} className="sr-only">Set kind</label>
        <select id={kindId} className="gallery-select" value={kind} onChange={e => pickKind(e.target.value)}>
          {KIND_FILTER.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <label className="sets-solo">
          <input type="checkbox" checked={includeSolo} onChange={e => setIncludeSolo(e.target.checked)} />
          Show figures without a diorama
        </label>
        <span className="result-count">{total.toLocaleString()} set{total !== 1 ? 's' : ''}</span>
      </div>

      {error && <div className="org-error" role="alert">Couldn't load sets: {error}</div>}
      {!loading && !error && items.length === 0 && !solo.length && (
        <div className="empty-state">
          <div className="empty-title">NO SETS</div>
          <div className="empty-msg">No releases, themes or dioramas match these filters.</div>
        </div>
      )}

      <div className="sets-list">
        {items.map(s => <SetRow key={s.id} set={s} onOpen={onModelClick} onShowSet={onShowSet} />)}
      </div>

      {includeSolo && solo.length > 0 && (
        <section className="set-row set-row-solo" aria-labelledby="set-row-solo">
          <header className="set-row-head">
            <h3 className="set-row-name" id="set-row-solo">Figures without a diorama</h3>
            <span className="set-row-meta">{soloTotal.toLocaleString()} card{soloTotal !== 1 ? 's' : ''}</span>
          </header>
          <CardStrip cards={solo} onOpen={onModelClick} label="Figures without a diorama" />
        </section>
      )}

      {loading && <div className="gallery-loading"><div className="spinner" /> Loading...</div>}
      {!loading && page < pages && (
        <button type="button" className="sec-more-btn sets-more" onClick={() => load(page + 1)}>
          ▼ Load more sets ({Math.max(0, total - items.length).toLocaleString()} left)
        </button>
      )}
    </div>
  );
}
