import React, { useState, useEffect, useCallback, useRef, useMemo, memo, Suspense } from 'react';
import { apiGet, apiSend, errorMessage, isAbortError } from '../api';
import { useNotify } from '../components/Notices';
import { activeFilterChips, EMPTY_FILTERS, filterParams } from '../filters';
import { cardEditions, multiLibraryLabel, formatTerm, isAttributed } from '../library';
import { isTermLabel } from '../enrich';
import Modal from '../components/Modal';
import { cardImages, isMeshPreview } from '../thumbs';
import { relationBadges, cardSetChips, setChipLabel } from '../relations';
import AddToSet from '../components/AddToSet';
import SetsView from '../components/SetsView';

const EnrichPanel = React.lazy(() => import('../components/EnrichPanel'));

const STATUS_ICONS = {
  unprinted: '○', sliced: '◑', printing: '◕', printed: '●', painted: '★', failed: '✗'
};

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];

export const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 48;

/** Edition chips, a multi-library badge and (when asked) an unattributed marker. */
export function CardMeta({ model, showAttribution }) {
  const editions = cardEditions(model);
  const libs = multiLibraryLabel(model);
  const unattributed = showAttribution && !!model.confidence && !isAttributed(model.confidence);
  if (!editions.length && !libs && !unattributed && model.kind !== 'release-item') return null;
  return (
    <div className="card-meta">
      {editions.map(e => <span key={e} className={`edition-chip ed-${e.toLowerCase()}`}>{e}</span>)}
      {model.kind === 'release-item' && !editions.length && <span className="edition-chip ed-release">Release item</span>}
      {libs && <span className="library-badge" title={`Files in ${libs}`}><span aria-hidden="true">⇄ </span>{libs}</span>}
      {unattributed && <span className="unattributed-mark" title="No purchase record matched this work">◌ unattributed</span>}
    </div>
  );
}

/** "Features N" / "In N dioramas" badges; click shows the card's related set. */
export function RelationBadges({ model, onRelated, interactive }) {
  const badges = relationBadges(model);
  if (!badges.length) return null;
  return (
    <div className="card-rel-badges">
      {badges.map(b => (interactive && onRelated ? (
        <button key={b.key} type="button" className={`card-rel-badge rel-${b.key}`} title={b.title}
          aria-label={`${b.label}: show related cards for ${model.name}`}
          onClick={e => { e.stopPropagation(); onRelated(model); }}>{b.label}</button>
      ) : (
        <span key={b.key} className={`card-rel-badge rel-${b.key}`} title={b.title}>{b.label}</span>
      )))}
    </div>
  );
}

/** Release / theme / diorama chips from `rel.sets`; click filters the gallery to the set. */
export function CardSetChips({ model, onSet, interactive }) {
  const sets = cardSetChips(model);
  if (!sets.length) return null;
  return (
    <div className="card-set-chips">
      {sets.map(s => {
        const label = setChipLabel(s);
        return interactive && onSet ? (
          <button key={`${s.kind}-${s.id}`} type="button" className={`set-chip set-${s.kind}`} title={label}
            aria-label={`Show set ${label}`} onClick={e => { e.stopPropagation(); onSet(s); }}>{label}</button>
        ) : <span key={`${s.kind}-${s.id}`} className={`set-chip set-${s.kind}`} title={label}>{label}</span>;
      })}
    </div>
  );
}

const ModelCard = memo(function ModelCard({ model, onClick, bulkMode, selected, onToggle, onHide, onFavorite, showAttribution, onRelated, onSet }) {
  // Small cached copies (thumb_url / thumb_urls) when the backend has them;
  // the originals otherwise (older backend).
  const imgs = useMemo(() => cardImages(model), [model]);
  const [imgIdx, setImgIdx] = useState(0);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [useOriginal, setUseOriginal] = useState(false); // a /thumbs/ URL failed: try the original once
  const idx = imgIdx < imgs.length ? imgIdx : 0;
  const thumbSrc = imgs[idx] || model.thumbnail_path;
  const originalSrc = (model.images || [])[idx] || model.thumbnail_path;
  const currentImg = useOriginal && originalSrc ? originalSrc : thumbSrc;
  const isHidden = model.hidden === 1 || model.hidden === true;
  const isFav = model.is_favorite === 1 || model.is_favorite === true;
  const showImg = currentImg && !imgFailed;
  const meshPreview = isMeshPreview(model);

  const onImgError = () => {
    if (!useOriginal && typeof thumbSrc === 'string' && thumbSrc.startsWith('/thumbs/') && originalSrc && originalSrc !== thumbSrc) {
      setUseOriginal(true);
      return;
    }
    setImgFailed(true);
  };

  const handleClick = () => {
    if (bulkMode) { onToggle(model.id); return; }
    onClick(model);
  };

  const cycleImg = (e, dir) => {
    e.stopPropagation();
    setImgFailed(false);
    setUseOriginal(false);
    setImgIdx(prev => {
      const next = prev + dir;
      if (next < 0) return imgs.length - 1;
      if (next >= imgs.length) return 0;
      return next;
    });
  };

  const handleHide = (e) => { e.stopPropagation(); onHide(model.id, !isHidden); };
  const handleFav = (e) => { e.stopPropagation(); onFavorite(model.id, !isFav); };

  const cls = ['model-card'];
  if (selected) cls.push('selected');
  if (isHidden) cls.push('is-hidden');

  return (
    <div className={cls.join(' ')} onClick={handleClick}>
      {/* Full-card button: makes the card focusable and opens it on Enter/Space.
          Clicks bubble to the card's onClick. */}
      <button type="button" className="model-card-open"
        aria-label={bulkMode ? `${selected ? 'Deselect' : 'Select'} ${model.name}` : `Open ${model.name}`}
        aria-pressed={bulkMode ? selected : undefined} />
      {bulkMode && (
        <div className={`card-check ${selected ? 'on' : ''}`} aria-hidden="true">
          {selected ? '✓' : ''}
        </div>
      )}
      {isHidden && <div className="card-hidden-badge">HIDDEN</div>}
      {!bulkMode && (
        <button onClick={handleFav} title={isFav ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFav ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`}
          aria-pressed={isFav}
          className={`card-action card-fav ${isFav ? 'on' : 'card-hover-only'}`}>
          {isFav ? '★' : '☆'}
        </button>
      )}
      {!bulkMode && (
        <button onClick={handleHide} title={isHidden ? 'Unhide model' : 'Hide model'}
          aria-label={isHidden ? `Unhide ${model.name}` : `Hide ${model.name}`}
          className={`card-action card-hide card-hover-only ${isHidden ? 'on' : ''}`}>
          {isHidden ? '👁' : '🙈'}
        </button>
      )}
      <div className="model-card-media">
        {showImg ? (
          <img className="model-card-img" src={currentImg} alt={model.name} loading="lazy" decoding="async"
            width={480} height={360}
            style={{ opacity: imgLoaded ? 1 : 0 }}
            onLoad={() => setImgLoaded(true)}
            onError={onImgError} />
        ) : (
          <div className="model-card-no-img" role="img" aria-label={`No picture for ${model.name}`}><span aria-hidden="true">🧩</span></div>
        )}
        {showImg && meshPreview && (
          <span className="card-3d-badge" role="img" title="Preview rendered from the 3D model" aria-label="3D preview rendered from the model">3D</span>
        )}
        <RelationBadges model={model} onRelated={onRelated} interactive={!bulkMode} />
      </div>
      {imgs.length > 1 && !bulkMode && (
        <>
          <button onClick={e => cycleImg(e, -1)} className="card-nav prev card-hover-only" aria-label="Previous image">‹</button>
          <button onClick={e => cycleImg(e, 1)} className="card-nav next card-hover-only" aria-label="Next image">›</button>
          <div className="card-img-count card-hover-only" aria-hidden="true">{idx + 1}/{imgs.length}</div>
        </>
      )}
      <div className="model-card-body">
        <div className="model-card-name" title={model.name}>{model.name}</div>
        <div className="model-card-sub">
          <span className="model-card-creator">{model.creator_name || 'Unknown'}</span>
          {model.release_term && <span className="model-card-term" title={`Release term ${formatTerm(model.release_term)}`}>{formatTerm(model.release_term)}</span>}
        </div>
        {model.release_label && !isTermLabel(model.release_label) && (
          <div className="model-card-release" title={`Release: ${model.release_label}`}>{model.release_label}</div>
        )}
        <CardMeta model={model} showAttribution={showAttribution} />
        <CardSetChips model={model} onSet={onSet} interactive={!bulkMode} />
        <div className="model-card-footer">
          <span className={`status-badge status-${model.print_status}`}>
            {STATUS_ICONS[model.print_status]} {model.print_status}
          </span>
          <div className="file-icons">
            {model.has_stl ? <span className="file-icon stl">STL</span> : null}
            {model.has_chitubox ? <span className="file-icon slicer">CHI</span> : null}
            {model.has_lychee ? <span className="file-icon slicer">LYS</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
});

function BulkActionBar({ selectedIds, onClearSelection, onBulkStatus, onBulkTag, onBulkHide, onSelectAll, totalVisible, collections, onRefreshCollections, onEnrich, setsEnabled, onSetsChanged }) {
  const notify = useNotify();
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [showCollectionMenu, setShowCollectionMenu] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [commonTags, setCommonTags] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [saving, setSaving] = useState(false);

  const loadCommonTags = async () => {
    try {
      const d = await apiGet(`/api/models/common-tags?ids=${selectedIds.join(',')}`);
      setCommonTags((d && d.commonTags) || []);
      setAllTags((d && d.allTags) || []);
    } catch (e) {
      notify(`Couldn't load tags for the selection: ${errorMessage(e)}`);
    }
  };

  const run = async (fn, what) => {
    setSaving(true);
    try { await fn(); } catch (e) { notify(`${what} failed: ${errorMessage(e)}`); }
    setSaving(false);
  };

  const handleAddToCollection = (colId) => {
    setShowCollectionMenu(false);
    return run(async () => {
      await apiSend(`/api/collections/${colId}/models`, 'POST', { modelIds: selectedIds });
      if (onRefreshCollections) onRefreshCollections();
    }, 'Add to collection');
  };

  const handleBulkStatus = (status) => {
    setShowStatusMenu(false);
    return run(() => onBulkStatus(status), 'Set status');
  };

  const openTagMenu = async () => {
    const open = !showTagMenu;
    setShowTagMenu(open);
    setShowStatusMenu(false);
    setShowCollectionMenu(false);
    if (open && selectedIds.length) await loadCommonTags();
  };

  const handleAddTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (!t) return undefined;
    return run(async () => {
      await onBulkTag([t], []);
      setTagInput('');
      await loadCommonTags();
    }, 'Add tag');
  };

  const handleRemoveTag = (tag) => run(async () => {
    await onBulkTag([], [tag]);
    setAllTags(ts => ts.filter(x => x !== tag));
    setCommonTags(ts => ts.filter(x => x !== tag));
  }, 'Remove tag');

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-count">{selectedIds.length} selected</div>
      <button onClick={onSelectAll} className="bulk-btn bulk-btn-ghost">
        Select all {totalVisible}
      </button>

      <div className="bulk-menu-wrap">
        <button onClick={() => { setShowStatusMenu(s => !s); setShowTagMenu(false); setShowCollectionMenu(false); }}
          aria-expanded={showStatusMenu} aria-haspopup="menu" className="bulk-btn">
          Set Status ▾
        </button>
        {showStatusMenu && (
          <div className="bulk-menu" role="menu">
            {STATUS_OPTIONS.map(s => (
              <button key={s} role="menuitem" onClick={() => handleBulkStatus(s)} className="bulk-menu-item">
                <span className={`status-dot dot-${s}`} />
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bulk-menu-wrap">
        <button onClick={openTagMenu} aria-expanded={showTagMenu} className={`bulk-btn ${showTagMenu ? 'active' : ''}`}>
          🏷 Tags ▾
        </button>
        {showTagMenu && (
          <div className="bulk-menu bulk-tag-menu">
            <label htmlFor="bulk-tag-input" className="bulk-menu-label">ADD TAG</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input id="bulk-tag-input" value={tagInput} onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); }}
                placeholder="tag name" autoFocus className="bulk-input" />
              <button onClick={handleAddTag} disabled={saving} className="bulk-add-btn">ADD</button>
            </div>
            {allTags.length > 0 && (
              <>
                <div className="bulk-menu-label">
                  REMOVE TAG <span className="bulk-menu-hint">(★ = on all selected)</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {allTags.map(t => {
                    const common = commonTags.includes(t);
                    return (
                      <button key={t} onClick={() => handleRemoveTag(t)} disabled={saving}
                        aria-label={`Remove tag ${t} from selected models`}
                        className={`bulk-tag ${common ? 'common' : ''}`}>
                        {common ? '★ ' : ''}{t} ×
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {collections && collections.length > 0 && (
        <div className="bulk-menu-wrap">
          <button onClick={() => { setShowCollectionMenu(s => !s); setShowStatusMenu(false); setShowTagMenu(false); }}
            aria-expanded={showCollectionMenu} aria-haspopup="menu" className="bulk-btn">
            📁 Collection ▾
          </button>
          {showCollectionMenu && (
            <div className="bulk-menu" role="menu">
              {collections.map(c => (
                <button key={c.id} role="menuitem" onClick={() => handleAddToCollection(c.id)} disabled={saving} className="bulk-menu-item">
                  <span className="status-dot" style={{ background: c.color }} />
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {setsEnabled && <AddToSet ids={selectedIds} buttonClass="bulk-btn" onDone={onSetsChanged} />}

      {onEnrich && <button onClick={onEnrich} className="bulk-btn bulk-btn-ai" title="Uses Claude API credits">$ ✦ Enrich selected</button>}
      <button onClick={() => run(() => onBulkHide(true), 'Hide')} className="bulk-btn bulk-btn-muted">🙈 Hide</button>
      <button onClick={() => run(() => onBulkHide(false), 'Unhide')} className="bulk-btn bulk-btn-muted">👁 Unhide</button>

      <div className="bulk-right">
        {saving && <span className="bulk-saving">Saving...</span>}
        <button onClick={onClearSelection} className="bulk-btn bulk-btn-ghost">Cancel</button>
      </div>
    </div>
  );
}

function FilterChips({ chips, onRemove, onClearAll }) {
  if (!chips.length) return null;
  return (
    <div className="filter-chips" aria-label="Active filters">
      <span className="filter-chips-label">FILTERS:</span>
      {chips.map(c => (
        <span key={c.key} className="filter-chip" title={c.title}>
          <span className="filter-chip-label">{c.label}</span>
          {c.value && <span className="filter-chip-value">{c.value}</span>}
          <button className="filter-chip-x" onClick={() => onRemove(c)} aria-label={`Remove filter ${c.label}${c.value ? ` ${c.value}` : ''}`}>✕</button>
        </span>
      ))}
      <button className="filter-clear-all" onClick={onClearAll}>Clear all</button>
    </div>
  );
}

/** Name + description of the collection being browsed (e.g. "Was: DC" from the regroup). */
export function CollectionBanner({ collection }) {
  if (!collection || !collection.description) return null;
  return (
    <div className="collection-banner" role="note" aria-label={`About collection ${collection.name}`}>
      <span className="collection-banner-dot" style={{ background: collection.color }} aria-hidden="true" />
      <div className="collection-banner-body">
        <div className="collection-banner-name">{collection.name}</div>
        <div className="collection-banner-desc">{collection.description}</div>
      </div>
    </div>
  );
}

const SORT_OPTIONS = [
  { value: 'creator', label: 'Creator / Name' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'date_added', label: 'Date Added' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'status', label: 'Print Status' },
];

const CARD_MIN = { small: 150, medium: 200, large: 290 };

export default function Gallery({ filters, onFilterChange, onModelClick, showHidden, onToggleHidden, onRefreshStats, refreshKey, collections, onRefreshCollections, onScanClick, onOpenReview, onSuggestionsChange, relations }) {
  const [enrichIds, setEnrichIds] = useState(null);
  const [enrichRunning, setEnrichRunning] = useState(false);
  const notify = useNotify();
  const [models, setModels] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [sort, setSort] = useState('creator');
  const relationsOn = !!relations;
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('vault_gallery_view') === 'sets' ? 'sets' : 'cards'; } catch { return 'cards'; }
  });
  const pickView = (v) => { setViewMode(v); try { localStorage.setItem('vault_gallery_view', v); } catch {} };
  const setsMode = relationsOn && viewMode === 'sets';
  const [cardSize, setCardSize] = useState(() => {
    try { return localStorage.getItem('vault_card_size') || 'medium'; } catch { return 'medium'; }
  });
  const setSize = (s) => { setCardSize(s); try { localStorage.setItem('vault_card_size', s); } catch {} };
  const sentinelRef = useRef(null);
  const loadingRef = useRef(false);  // a request (reset or append) is in flight
  const requestIdRef = useRef(0);    // latest request id; older responses are ignored
  const abortRef = useRef(null);

  // ── Search box: local state, debounced into filters.search ────────────────
  const [searchText, setSearchText] = useState(filters.search || '');
  const searchTimer = useRef(null);
  const lastSentSearch = useRef(filters.search || '');
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    // External change (chip ✕, Clear all, logo click) → reflect it in the box
    if ((filters.search || '') !== lastSentSearch.current) {
      clearTimeout(searchTimer.current);
      lastSentSearch.current = filters.search || '';
      setSearchText(filters.search || '');
    }
  }, [filters.search]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const onSearchChange = (value) => {
    setSearchText(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      lastSentSearch.current = value;
      onFilterChange({ ...filtersRef.current, search: value });
    }, SEARCH_DEBOUNCE_MS);
  };

  const params = useMemo(() => filterParams(filters, { showHidden }), [filters, showHidden]);

  const buildExportUrl = () => `/api/export?${new URLSearchParams(params)}`;

  const fetchModels = useCallback(async (pageNum, append = false) => {
    if (append && loadingRef.current) return; // don't stack "load more" on top of a pending request
    if (abortRef.current) abortRef.current.abort();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = controller;
    const id = ++requestIdRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: pageNum, limit: PAGE_SIZE, ...params, sort });
      const data = await apiGet(`/api/models?${qs}`, { signal: controller?.signal });
      if (id !== requestIdRef.current) return; // superseded by a newer request
      const incoming = (data && data.models) || [];
      if (append) setModels(prev => [...prev, ...incoming]);
      else setModels(incoming);
      setTotal((data && data.total) || 0);
      setHasMore(!!data && data.page < data.pages);
    } catch (e) {
      if (isAbortError(e) || id !== requestIdRef.current) return;
      notify(`Couldn't load models: ${errorMessage(e)}`);
      setHasMore(false);
    } finally {
      if (id === requestIdRef.current) {
        loadingRef.current = false;
        setLoading(false);
        setLoadedOnce(true);
      }
    }
  }, [params, sort, notify]);

  // Reset and reload when filters/sort/showHidden/refreshKey change
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    fetchModels(1, false);
  }, [params, sort, refreshKey]); // eslint-disable-line

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // Load more when page increments (triggered by sentinel)
  useEffect(() => {
    if (page === 1) return;
    fetchModels(page, true);
  }, [page]); // eslint-disable-line

  // IntersectionObserver — fires when sentinel scrolls into view
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingRef.current && hasMore) setPage(p => p + 1);
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  const toggleSelect = useCallback((id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const clearSelection = () => { setSelectedIds(new Set()); setBulkMode(false); };
  const selectedList = useMemo(() => [...selectedIds], [selectedIds]);

  const reload = () => { setPage(1); setHasMore(true); fetchModels(1, false); };

  const handleBulkStatus = async (status) => {
    await apiSend('/api/models/bulk', 'POST', { ids: selectedList, print_status: status });
    reload();
    if (onRefreshStats) onRefreshStats();
  };

  const handleBulkTag = async (tagsAdd, tagsRemove) => {
    await apiSend('/api/models/bulk', 'POST', { ids: selectedList, tags_add: tagsAdd, tags_remove: tagsRemove });
    reload();
  };

  const handleBulkHide = async (hide) => {
    const r = await apiSend('/api/models/bulk', 'POST', { ids: selectedList, hidden: hide });
    const skipped = (r && r.skippedFolded) || 0;
    if (!hide && skipped > 0) {
      notify(`${skipped} card${skipped !== 1 ? 's were' : ' was'} folded into a work when the library was regrouped and stay${skipped !== 1 ? '' : 's'} hidden. Open the work instead; its tags, notes and collections are there.`,
        { type: 'info', duration: 10000 });
    }
    clearSelection();
    reload();
    if (onRefreshStats) onRefreshStats();
  };

  const handleHideModel = useCallback(async (id, hide) => {
    try {
      await apiSend(`/api/models/${id}`, 'PATCH', { hidden: hide });
      reload();
      if (onRefreshStats) onRefreshStats();
    } catch (e) {
      // 409: the row was folded into a work by the regroup; the server explains where its data went
      if (e && e.status === 409) notify(errorMessage(e), { duration: 12000 });
      else notify(`Couldn't ${hide ? 'hide' : 'unhide'} model: ${errorMessage(e)}`);
      reload(); // re-sync the card with the server either way
    }
  }, [fetchModels, onRefreshStats, notify]); // eslint-disable-line

  const handleFavorite = useCallback(async (id, fav) => {
    setModels(prev => prev.map(m => m.id === id ? { ...m, is_favorite: fav ? 1 : 0 } : m));
    try {
      await apiSend(`/api/models/${id}`, 'PATCH', { is_favorite: fav });
      if (onRefreshStats) onRefreshStats();
      if (filtersRef.current.favorite && !fav) reload();
    } catch (e) {
      setModels(prev => prev.map(m => m.id === id ? { ...m, is_favorite: fav ? 0 : 1 } : m));
      notify(`Couldn't update favorite: ${errorMessage(e)}`);
    }
  }, [fetchModels, onRefreshStats, notify]); // eslint-disable-line

  const showRelated = useCallback((m) => {
    onFilterChange({ ...filtersRef.current, relatedTo: String(m.id), relatedToName: m.name || '' });
  }, [onFilterChange]);
  const showSet = useCallback((s) => {
    onFilterChange({ ...filtersRef.current, set: String(s.id), setName: setChipLabel(s) });
    pickView('cards');
  }, [onFilterChange]); // eslint-disable-line

  const chips = activeFilterChips(filters, { collections });
  if (showHidden && onToggleHidden) {
    chips.push({ key: 'show_hidden', label: 'Showing hidden', value: '', clearHidden: true });
  }
  const filtered = chips.length > 0;
  const removeChip = (c) => {
    if (c.clearHidden) { onToggleHidden(); return; }
    onFilterChange(c.clear(filtersRef.current));
  };
  const clearAll = () => {
    clearTimeout(searchTimer.current);
    if (showHidden && onToggleHidden) onToggleHidden();
    onFilterChange({ ...EMPTY_FILTERS });
  };

  return (
    <div className="gallery-page">
      <div className="gallery-header">
        <div className="gallery-title">MODELS</div>
        <input className="search-input" placeholder="Search models, creators, tags..." aria-label="Search models"
          type="search" value={searchText} onChange={e => onSearchChange(e.target.value)} />

        <div className="gallery-controls">
          <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort models" className="gallery-select">
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <div className="size-toggle" role="group" aria-label="Thumbnail size" title="Thumbnail size">
            {[['small', 'S', 'Small'], ['medium', 'M', 'Medium'], ['large', 'L', 'Large']].map(([val, label, full]) => (
              <button key={val} onClick={() => setSize(val)} aria-label={`${full} thumbnails`} aria-pressed={cardSize === val}
                className={cardSize === val ? 'active' : ''}>
                {label}
              </button>
            ))}
          </div>

          {relationsOn && (
            <div className="size-toggle view-toggle" role="group" aria-label="Gallery view">
              {[['cards', 'Cards'], ['sets', 'Sets']].map(([v, label]) => (
                <button key={v} type="button" onClick={() => pickView(v)} aria-pressed={viewMode === v}
                  className={viewMode === v ? 'active' : ''}>{label}</button>
              ))}
            </div>
          )}

          {!setsMode && <button onClick={() => { setBulkMode(b => !b); setSelectedIds(new Set()); }}
            aria-pressed={bulkMode} className={`chip-btn ${bulkMode ? 'active' : ''}`}>
            {bulkMode ? '✕ Cancel' : '⊡ Select'}
          </button>}

          <a href={buildExportUrl()} download className="chip-btn" title="Export current view to CSV">
            ⬇ CSV
          </a>
        </div>

        {!setsMode && <div className="result-count">{total.toLocaleString()} models</div>}
      </div>

      <FilterChips chips={chips} onRemove={removeChip} onClearAll={clearAll} />
      {filters.collection && Array.isArray(collections) && (
        <CollectionBanner collection={collections.find(c => String(c.id) === String(filters.collection))} />
      )}

      {setsMode && (
        <div className="gallery-scroll">
          <SetsView filters={filters} onModelClick={onModelClick} onShowSet={showSet} />
        </div>
      )}

      <div className="gallery-scroll" hidden={setsMode}>
        {models.length === 0 && !loading && loadedOnce && (
          filtered ? (
            <div className="empty-state">
              <div className="empty-icon">🔍</div>
              <div className="empty-title">NO MATCHES</div>
              <div className="empty-msg">No models match these filters.</div>
              <button className="btn-primary" onClick={clearAll}>Clear filters</button>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">🗄️</div>
              <div className="empty-title">VAULT IS EMPTY</div>
              <div className="empty-msg">Scan your library folder to index your models and pull preview images.</div>
              {onScanClick && <button className="btn-primary" onClick={onScanClick}>⟳ Scan library</button>}
            </div>
          )
        )}

        {models.length > 0 && (
          <div className={`model-grid card-${cardSize}`} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${CARD_MIN[cardSize]}px, 100%), 1fr))` }}>
            {models.map(m => (
              <ModelCard key={m.id} model={m} onClick={onModelClick}
                bulkMode={bulkMode} selected={selectedIds.has(m.id)}
                onToggle={toggleSelect} onHide={handleHideModel} onFavorite={handleFavorite}
                showAttribution={!!filters.attributed}
                onRelated={showRelated} onSet={showSet} />
            ))}
          </div>
        )}

        <div ref={sentinelRef} style={{ height: 1 }} />

        {loading && (
          <div className="gallery-loading">
            <div className="spinner" /> Loading...
          </div>
        )}
        {!loading && !hasMore && models.length > 0 && (
          <div className="gallery-end">— {total.toLocaleString()} models —</div>
        )}
      </div>

      {bulkMode && !setsMode && selectedIds.size > 0 && (
        <BulkActionBar selectedIds={selectedList} onClearSelection={clearSelection}
          onBulkStatus={handleBulkStatus} onBulkTag={handleBulkTag} onBulkHide={handleBulkHide}
          onSelectAll={() => setSelectedIds(new Set(models.map(m => m.id)))} totalVisible={models.length}
          collections={collections} onRefreshCollections={onRefreshCollections}
          onEnrich={() => setEnrichIds(selectedList)}
          setsEnabled={relationsOn} onSetsChanged={reload} />
      )}

      {enrichIds && (
        <Modal onClose={() => setEnrichIds(null)} label="Enrich selected cards" className="modal modal-wide"
          closeOnBackdrop={!enrichRunning} closeOnEscape={!enrichRunning}>
          <div className="modal-title">ENRICH SELECTED</div>
          <Suspense fallback={<div className="modal-hint">Loading…</div>}>
            <EnrichPanel presetIds={enrichIds} filters={filters} onRunningChange={setEnrichRunning}
              onOpenReview={onOpenReview ? () => { setEnrichIds(null); onOpenReview(); } : undefined}
              onDone={() => { reload(); if (onRefreshStats) onRefreshStats(); if (onSuggestionsChange) onSuggestionsChange(); }} />
          </Suspense>
          <div className="modal-actions">
            <button className="btn-cancel" onClick={() => setEnrichIds(null)} disabled={enrichRunning}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
