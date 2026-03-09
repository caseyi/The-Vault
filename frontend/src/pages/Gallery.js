import React, { useState, useEffect, useCallback } from 'react';

const STATUS_ICONS = {
  unprinted: '○', sliced: '◑', printing: '◕', printed: '●', painted: '★', failed: '✗'
};

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];
const STATUS_COLORS = {
  unprinted: '#4a4a5a', sliced: '#5b9bd5', printing: '#d4aa4c',
  printed: '#4caf7d', painted: '#9b72cf', failed: '#cf7272'
};

function ModelCard({ model, onClick, bulkMode, selected, onToggle }) {
  const imgs = model.images || [];
  const thumb = model.thumbnail_path || imgs[0];

  const handleClick = () => {
    if (bulkMode) { onToggle(model.id); return; }
    onClick(model);
  };

  return (
    <div className="model-card" onClick={handleClick}
      style={selected ? { borderColor: '#c17f3a', boxShadow: '0 0 0 2px rgba(193,127,58,0.4)' } : {}}>
      {bulkMode && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 2,
          width: 20, height: 20, borderRadius: 4,
          border: `2px solid ${selected ? '#c17f3a' : '#3f3f4d'}`,
          background: selected ? '#c17f3a' : 'rgba(13,13,15,0.8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: '#0d0d0f', fontWeight: 'bold'
        }}>
          {selected ? '✓' : ''}
        </div>
      )}
      {thumb ? (
        <img className="model-card-img" src={thumb} alt={model.name} loading="lazy"
          onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
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

function BulkActionBar({ selectedIds, onClearSelection, onBulkStatus, onBulkTag, onSelectAll, totalVisible }) {
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);

  const handleBulkStatus = async (status) => {
    setSaving(true); setShowStatusMenu(false);
    await onBulkStatus(status);
    setSaving(false);
  };

  const handleAddTag = async () => {
    if (!tagInput.trim()) return;
    setSaving(true);
    await onBulkTag([tagInput.trim().toLowerCase()], []);
    setTagInput(''); setSaving(false);
  };

  return (
    <div style={{
      background: '#1c1c21', borderTop: '2px solid #c17f3a',
      padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
      flexShrink: 0, boxShadow: '0 -8px 24px rgba(0,0,0,0.5)'
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#c17f3a', whiteSpace: 'nowrap' }}>
        {selectedIds.length} selected
      </div>
      <button onClick={onSelectAll} style={{ background: 'none', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>
        Select all {totalVisible}
      </button>

      <div style={{ position: 'relative' }}>
        <button onClick={() => { setShowStatusMenu(s => !s); setShowTagMenu(false); }}
          style={{ background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>
          Set Status ▾
        </button>
        {showStatusMenu && (
          <div style={{ position: 'absolute', bottom: '110%', left: 0, background: '#1c1c21', border: '1px solid #3f3f4d', borderRadius: 6, overflow: 'hidden', minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 30 }}>
            {STATUS_OPTIONS.map(s => (
              <button key={s} onClick={() => handleBulkStatus(s)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 12px', background: 'none', border: 'none', color: '#e8e8f0', cursor: 'pointer', fontSize: 12, textAlign: 'left' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[s], flexShrink: 0 }} />
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <button onClick={() => { setShowTagMenu(s => !s); setShowStatusMenu(false); }}
          style={{ background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>
          Add Tag ▾
        </button>
        {showTagMenu && (
          <div style={{ position: 'absolute', bottom: '110%', left: 0, background: '#1c1c21', border: '1px solid #3f3f4d', borderRadius: 6, padding: 10, minWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 30 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={tagInput} onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); }}
                placeholder="tag name" autoFocus
                style={{ flex: 1, background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '5px 8px', fontSize: 12, outline: 'none', fontFamily: 'var(--font-body)' }} />
              <button onClick={handleAddTag} style={{ background: '#c17f3a', border: 'none', borderRadius: 4, color: '#0d0d0f', padding: '5px 10px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-display)', letterSpacing: 0.5 }}>ADD</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {saving && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#c17f3a' }}>Saving...</span>}
        <button onClick={onClearSelection} style={{ background: 'none', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
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
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page, limit: 48,
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

  const toggleSelect = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const clearSelection = () => { setSelectedIds([]); setBulkMode(false); };

  const handleBulkStatus = async (status) => {
    await fetch('/api/models/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds, print_status: status })
    });
    fetchModels();
  };

  const handleBulkTag = async (tagsAdd, tagsRemove) => {
    await fetch('/api/models/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds, tags_add: tagsAdd, tags_remove: tagsRemove })
    });
    fetchModels();
  };

  const pageNums = [];
  for (let i = Math.max(1, page - 3); i <= Math.min(pages, page + 3); i++) pageNums.push(i);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="gallery-header">
        <div className="gallery-title">MODELS</div>
        <input className="search-input" placeholder="Search models, creators, tags..."
          value={filters.search} onChange={e => onFilterChange({ ...filters, search: e.target.value })} />
        <button onClick={() => { setBulkMode(b => !b); setSelectedIds([]); }}
          style={{
            background: bulkMode ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
            border: `1px solid ${bulkMode ? '#c17f3a' : 'var(--border)'}`,
            borderRadius: 'var(--radius)', color: bulkMode ? '#c17f3a' : 'var(--text-muted)',
            padding: '6px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)'
          }}>
          {bulkMode ? '✕ Cancel' : '⊡ Select'}
        </button>
        <div className="result-count">{total.toLocaleString()} models</div>
      </div>

      <div className="gallery-scroll">
        {loading && <div className="loading"><div className="spinner" /> Loading...</div>}

        {!loading && models.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">🗄️</div>
            <div className="empty-title">VAULT IS EMPTY</div>
            <div className="empty-msg">
              {total === 0 ? 'Click "Scan Library" in the sidebar to index your NAS folder.' : 'No models match your current filters.'}
            </div>
          </div>
        )}

        {!loading && models.length > 0 && (
          <>
            <div className="model-grid">
              {models.map(m => (
                <ModelCard key={m.id} model={m} onClick={onModelClick}
                  bulkMode={bulkMode} selected={selectedIds.includes(m.id)} onToggle={toggleSelect} />
              ))}
            </div>
            {pages > 1 && (
              <div className="pagination">
                <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
                {page > 4 && <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>1 ...</span>}
                {pageNums.map(n => (
                  <button key={n} className={`page-btn ${page === n ? 'active' : ''}`} onClick={() => setPage(n)}>{n}</button>
                ))}
                {page < pages - 3 && <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>... {pages}</span>}
                <button className="page-btn" disabled={page === pages} onClick={() => setPage(p => p + 1)}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>

      {bulkMode && selectedIds.length > 0 && (
        <BulkActionBar selectedIds={selectedIds} onClearSelection={clearSelection}
          onBulkStatus={handleBulkStatus} onBulkTag={handleBulkTag}
          onSelectAll={() => setSelectedIds(models.map(m => m.id))} totalVisible={models.length} />
      )}
    </div>
  );
}
