import React, { useState, useEffect, useCallback } from 'react';

const STATUS_ICONS = {
  unprinted: '○', sliced: '◑', printing: '◕', printed: '●', painted: '★', failed: '✗'
};

function ModelCard({ model, onClick }) {
  const imgs = model.images || [];
  const thumb = model.thumbnail_path || imgs[0];

  return (
    <div className="model-card" onClick={() => onClick(model)}>
      {thumb ? (
        <img
          className="model-card-img"
          src={thumb}
          alt={model.name}
          loading="lazy"
          onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
        />
      ) : null}
      <div className="model-card-no-img" style={{ display: thumb ? 'none' : 'flex' }}>🧩</div>
      <div className="model-card-body">
        <div className="model-card-name" title={model.name}>{model.name}</div>
        <div className="model-card-creator">{model.creator_name || 'Unknown'}</div>
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
}

export default function Gallery({ filters, onFilterChange, onModelClick }) {
  const [models, setModels] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page,
        limit: 48,
        ...(filters.search && { search: filters.search }),
        ...(filters.creator && { creator: filters.creator }),
        ...(filters.status && { status: filters.status }),
        ...(filters.tags && { tags: filters.tags }),
      });
      const r = await fetch(`/api/models?${params}`);
      const data = await r.json();
      setModels(data.models || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {}
    setLoading(false);
  }, [filters, page]);

  useEffect(() => { setPage(1); }, [filters]);
  useEffect(() => { fetchModels(); }, [fetchModels]);

  const pageNums = [];
  for (let i = 1; i <= Math.min(pages, 7); i++) pageNums.push(i);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="gallery-header">
        <div className="gallery-title">MODELS</div>
        <input
          className="search-input"
          placeholder="Search models, creators, tags..."
          value={filters.search}
          onChange={e => onFilterChange({ ...filters, search: e.target.value })}
        />
        <div className="result-count">{total.toLocaleString()} models</div>
      </div>

      <div className="gallery-scroll">
        {loading && (
          <div className="loading">
            <div className="spinner" /> Loading...
          </div>
        )}

        {!loading && models.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">🗄️</div>
            <div className="empty-title">VAULT IS EMPTY</div>
            <div className="empty-msg">
              {total === 0
                ? 'Click "Scan Library" in the sidebar to index your NAS folder.'
                : 'No models match your current filters.'}
            </div>
          </div>
        )}

        {!loading && models.length > 0 && (
          <>
            <div className="model-grid">
              {models.map(m => (
                <ModelCard key={m.id} model={m} onClick={onModelClick} />
              ))}
            </div>

            {pages > 1 && (
              <div className="pagination">
                <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
                {pageNums.map(n => (
                  <button key={n} className={`page-btn ${page === n ? 'active' : ''}`} onClick={() => setPage(n)}>{n}</button>
                ))}
                {pages > 7 && <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>... {pages}</span>}
                <button className="page-btn" disabled={page === pages} onClick={() => setPage(p => p + 1)}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
