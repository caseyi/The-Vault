import React, { useState, useEffect, useRef } from 'react';
import {
  groupTermsByYear, formatTerm, KIND_OPTIONS, sourceLabel, ATTRIBUTION_OPTIONS,
} from '../library';
import { RELATION_FILTERS, SET_KIND_FILTERS, setChipLabel } from '../relations';
import { apiGet } from '../api';

// Sidebar filters for the library-metadata facets (library, kind, studio, genre,
// term, source, attribution). Options and counts come from GET /api/facets; when
// that endpoint is missing (older backend) only the Genre list is shown, built
// from the existing /api/stats franchises.

// Remembered collapse state for a sidebar section (same storage keys as Sidebar)
export function useCollapsed(key, defaultOpen = true) {
  const storageKey = 'vault_sec_' + key;
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(storageKey); return v === null ? defaultOpen : v === '1'; }
    catch { return defaultOpen; }
  });
  const toggle = () => setOpen(o => {
    const n = !o;
    try { localStorage.setItem(storageKey, n ? '1' : '0'); } catch {}
    return n;
  });
  return [open, toggle];
}

const norm = (list) => (Array.isArray(list) ? list : [])
  .map(x => (typeof x === 'string' ? { name: x } : x))
  .filter(x => x && x.name != null && x.name !== '');

const Count = ({ n }) => (n == null ? null : <span className="count">{Number(n).toLocaleString()}</span>);

function FacetSection({ id, label, total, defaultOpen = true, active, onClear, children }) {
  const [open, toggle] = useCollapsed(`facet_${id}`, defaultOpen);
  const bodyId = `facet-body-${id}`;
  return (
    <div className="sidebar-section facet-section">
      <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button type="button" className="sec-toggle" onClick={toggle} aria-expanded={open} aria-controls={bodyId}>
          <span className="sec-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
          {total != null && <span className="facet-total"> {total}</span>}
          {!open && active && <span className="facet-active-dot" title="Filter active" aria-label="(filter active)" />}
        </button>
        {active && onClear && (
          <button onClick={onClear} className="sec-clear-btn" aria-label={`Clear ${label} filter`}>CLEAR</button>
        )}
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </div>
  );
}

/** Small set of options as wrapping pills (library, kind, source, attribution). */
function PillGroup({ label, options, value, onPick }) {
  return (
    <div className="facet-pills" role="group" aria-label={label}>
      {options.map(o => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" className={`facet-pill ${on ? 'active' : ''}`} aria-pressed={on}
            onClick={() => onPick(on ? '' : o.value)}>
            {o.label}{o.count != null && <span className="facet-pill-count">{Number(o.count).toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Longer lists (studio, genre) with a "Show all" toggle. */
function FacetList({ label, items, value, onPick, collapsedCount = 8 }) {
  const [expanded, setExpanded] = useState(false);
  const activeIdx = items.findIndex(i => i.name === value);
  const showAll = expanded || activeIdx >= collapsedCount;
  const shown = showAll ? items : items.slice(0, collapsedCount);
  return (
    <>
      <div className="creator-list facet-list" role="group" aria-label={label}
        style={{ maxHeight: showAll ? 320 : undefined, overflowY: showAll ? 'auto' : undefined, padding: '2px 0' }}>
        {shown.map(i => {
          const on = value === i.name;
          return (
            <button key={i.name} className={`creator-btn ${on ? 'active' : ''}`} aria-pressed={on}
              onClick={() => onPick(on ? '' : i.name)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{i.label || i.name}</span>
              <Count n={i.count} />
            </button>
          );
        })}
      </div>
      {items.length > collapsedCount && (
        <button onClick={() => setExpanded(e => !e)} aria-expanded={showAll} className="sec-more-btn">
          {showAll ? '▲ Show less' : `▼ Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

/** Release terms grouped by year (newest first); each year folds open. */
function TermPicker({ terms, value, onPick }) {
  const groups = groupTermsByYear(terms);
  const activeYear = value ? (String(value).match(/^(\d{4})/) || [])[1] || 'Other' : null;
  const [openYears, setOpenYears] = useState(() => new Set(groups.length ? [groups[0].year] : []));
  const toggleYear = (y) => setOpenYears(prev => {
    const n = new Set(prev);
    if (n.has(y)) n.delete(y); else n.add(y);
    return n;
  });
  return (
    <div className="term-picker">
      {groups.map(g => {
        const open = openYears.has(g.year) || g.year === activeYear;
        const total = g.terms.reduce((a, t) => a + (Number(t.count) || 0), 0);
        return (
          <div key={g.year} className="term-year">
            <button type="button" className="term-year-btn" aria-expanded={open} onClick={() => toggleYear(g.year)}>
              <span aria-hidden="true" className="sec-chevron">{open ? '▾' : '▸'}</span> {g.year}
              {total > 0 && <span className="count">{total.toLocaleString()}</span>}
            </button>
            {open && (
              <div className="facet-pills term-months" role="group" aria-label={`Release terms ${g.year}`}>
                {g.terms.map(t => {
                  const on = value === t.name;
                  return (
                    <button key={t.name} type="button" className={`facet-pill ${on ? 'active' : ''}`} aria-pressed={on}
                      aria-label={`${formatTerm(t.name)}${t.count != null ? `, ${t.count} models` : ''}`}
                      title={formatTerm(t.name)} onClick={() => onPick(on ? '' : t.name)}>
                      {t.label}{t.count != null && <span className="facet-pill-count">{t.count}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function sumCounts(list, names) {
  let n = 0; let any = false;
  for (const i of list) if (names.includes(i.name) && i.count != null) { n += Number(i.count) || 0; any = true; }
  return any ? n : undefined;
}

/** Searches GET /api/sets for the set picker (current creator/studio filter). */
export function SetPicker({ filters, onPick }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const timer = useRef(null);
  const creator = filters.creator || filters.studio || '';
  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) { setItems(null); return undefined; }
    let alive = true;
    timer.current = setTimeout(() => {
      const qs = new URLSearchParams({ search: q.trim(), limit: '12', ...(creator && { creator }) });
      apiGet(`/api/sets?${qs}`)
        .then(d => { if (alive) setItems(Array.isArray(d && d.items) ? d.items : []); })
        .catch(() => { if (alive) setItems([]); });
    }, 200);
    return () => { alive = false; clearTimeout(timer.current); };
  }, [q, creator]);
  return (
    <div className="set-picker">
      <input type="search" className="set-picker-input" value={q} onChange={e => setQ(e.target.value)}
        placeholder={creator ? `Find a set by ${creator}` : 'Find a set'} aria-label="Find a set" />
      {items && (
        <div className="creator-list facet-list" role="group" aria-label="Matching sets">
          {items.length === 0 && <div className="set-picker-empty">No sets match</div>}
          {items.map(s => (
            <button key={s.id} type="button" className={`creator-btn ${String(filters.set) === String(s.id) ? 'active' : ''}`}
              aria-pressed={String(filters.set) === String(s.id)}
              onClick={() => { onPick(s); setQ(''); }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{setChipLabel(s)}</span>
              {s.creator && <span className="count">{s.creator}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Relations" and "Sets" sidebar sections; shown only when GET /api/relations/summary answered. */
export function RelationFacets({ relations, filters, onFilterChange }) {
  if (!relations) return null;
  const counts = (relations && relations.filters) || {};
  const setCounts = (relations && relations.sets) || {};
  const relActive = RELATION_FILTERS.some(r => filters[r.key]);
  const setsActive = !!(filters.inSet || filters.noTheme || filters.set);
  const clearRel = () => onFilterChange(RELATION_FILTERS.reduce((f, r) => ({ ...f, [r.key]: false }), { ...filters }));
  const kindCount = k => (k === 'release' || k === 'theme' ? setCounts[k] : counts[`inSet:${k}`]);
  return (
    <>
      <FacetSection id="relations" label="Relations" active={relActive} onClear={relActive ? clearRel : null}>
        <div className="facet-pills" role="group" aria-label="Relations">
          {RELATION_FILTERS.map(r => {
            const on = !!filters[r.key];
            const n = counts[r.key];
            return (
              <button key={r.key} type="button" className={`facet-pill ${on ? 'active' : ''}`} aria-pressed={on}
                onClick={() => onFilterChange({ ...filters, [r.key]: !on })}>
                {r.label}{n != null && <span className="facet-pill-count">{Number(n).toLocaleString()}</span>}
              </button>
            );
          })}
        </div>
      </FacetSection>
      <FacetSection id="sets" label="Sets" active={setsActive}
        onClear={setsActive ? () => onFilterChange({ ...filters, inSet: '', noTheme: false, set: '', setName: '' }) : null}>
        <PillGroup label="Set kind" value={filters.inSet} onPick={v => onFilterChange({ ...filters, inSet: v })}
          options={SET_KIND_FILTERS.map(o => ({ ...o, count: kindCount(o.value) }))} />
        <div className="facet-pills" role="group" aria-label="Themes">
          <button type="button" className={`facet-pill ${filters.noTheme ? 'active' : ''}`} aria-pressed={!!filters.noTheme}
            onClick={() => onFilterChange({ ...filters, noTheme: !filters.noTheme })}>
            Not in a theme{counts.noTheme != null && <span className="facet-pill-count">{Number(counts.noTheme).toLocaleString()}</span>}
          </button>
        </div>
        <SetPicker filters={filters} onPick={s => onFilterChange({ ...filters, set: String(s.id), setName: setChipLabel(s) })} />
      </FacetSection>
    </>
  );
}

export default function FacetFilters({ facets, franchises, filters, onFilterChange, relations }) {
  const set = (key) => (v) => onFilterChange({ ...filters, [key]: v });
  const clear = (key) => (filters[key] ? () => onFilterChange({ ...filters, [key]: '' }) : null);
  const hasFacets = !!facets;

  const libraries = norm(facets && facets.libraries);
  const studios = norm(facets && facets.studios);
  const terms = norm(facets && facets.terms);
  const sources = norm(facets && facets.sources);
  const confidence = norm(facets && facets.confidence);
  let genres = norm(facets && facets.genres);
  if (!genres.length) genres = norm((franchises || []).map(f => ({ name: f.franchise, count: f.count })));

  const kindFacet = norm(facets && facets.kinds);
  const kinds = kindFacet.length
    ? KIND_OPTIONS
      .map(o => ({ ...o, count: (kindFacet.find(k => k.name === o.value) || {}).count, listed: kindFacet.some(k => k.name === o.value) }))
      .filter(o => o.listed && (o.count == null || o.count > 0 || o.value === filters.kind))
    : KIND_OPTIONS.filter(o => o.value !== 'model');

  const attribution = ATTRIBUTION_OPTIONS.map(o => ({
    ...o,
    count: sumCounts(confidence, o.value === 'yes' ? ['sidecar', 'exact', 'name'] : ['path', 'none']),
  }));

  return (
    <>
      {hasFacets && (libraries.length > 1 || filters.library) && (
        <FacetSection id="library" label="Libraries" active={!!filters.library} onClear={clear('library')}>
          <PillGroup label="Library" value={filters.library} onPick={set('library')}
            options={libraries.map(l => ({ value: l.name, label: l.name, count: l.count }))} />
        </FacetSection>
      )}

      {hasFacets && (
        <FacetSection id="kind" label="Kind" active={!!filters.kind} onClear={clear('kind')}>
          <PillGroup label="Kind" value={filters.kind} onPick={set('kind')} options={kinds} />
        </FacetSection>
      )}

      {hasFacets && studios.length > 0 && (
        <FacetSection id="studio" label="Studio" total={studios.length} active={!!filters.studio} onClear={clear('studio')}>
          <FacetList label="Studio" items={studios} value={filters.studio} onPick={set('studio')} />
        </FacetSection>
      )}

      {genres.length > 0 && (
        <FacetSection id="genre" label="Genre" total={genres.length} active={!!filters.franchise} onClear={clear('franchise')}>
          <FacetList label="Genre" items={genres} value={filters.franchise} onPick={set('franchise')} />
        </FacetSection>
      )}

      {hasFacets && terms.length > 0 && (
        <FacetSection id="term" label="Release term" total={terms.length} active={!!filters.term} onClear={clear('term')}>
          <TermPicker terms={terms} value={filters.term} onPick={set('term')} />
        </FacetSection>
      )}

      {hasFacets && sources.length > 0 && (
        <FacetSection id="source" label="Source" defaultOpen={false} active={!!filters.source} onClear={clear('source')}>
          <PillGroup label="Source" value={filters.source} onPick={set('source')}
            options={sources.map(s => ({ value: s.name, label: sourceLabel(s.name), count: s.count }))} />
        </FacetSection>
      )}

      <RelationFacets relations={relations} filters={filters} onFilterChange={onFilterChange} />

      {hasFacets && (
        <FacetSection id="attribution" label="Attribution" defaultOpen={false} active={!!filters.attributed} onClear={clear('attributed')}>
          <PillGroup label="Attribution" value={filters.attributed} onPick={set('attributed')} options={attribution} />
        </FacetSection>
      )}
    </>
  );
}
