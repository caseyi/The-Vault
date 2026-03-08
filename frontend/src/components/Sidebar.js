import React from 'react';

const STATUS_OPTIONS = [
  { value: '', label: 'All Models', dot: '#4a4a5a' },
  { value: 'unprinted', label: 'Unprinted', dot: '#4a4a5a' },
  { value: 'sliced', label: 'Sliced', dot: '#5b9bd5' },
  { value: 'printing', label: 'Printing', dot: '#d4aa4c' },
  { value: 'printed', label: 'Printed', dot: '#4caf7d' },
  { value: 'painted', label: 'Painted', dot: '#9b72cf' },
  { value: 'failed', label: 'Failed', dot: '#cf7272' },
];

export default function Sidebar({ open, onToggle, stats, creators, filters, onFilterChange, onScanClick, onHomeClick }) {
  const byStatus = stats?.byStatus || [];
  const getCount = (status) => {
    const found = byStatus.find(b => b.print_status === status);
    return found ? found.n : 0;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        {open && (
          <button className="sidebar-logo" onClick={onHomeClick} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            THE <span>VAULT</span>
          </button>
        )}
        <button className="sidebar-toggle" onClick={onToggle} title={open ? 'Collapse' : 'Expand'}>
          {open ? '◀' : '▶'}
        </button>
      </div>

      {open && (
        <>
          <div className="sidebar-section">
            <div className="sidebar-section-label">Library</div>
            <div className="sidebar-stat">
              <span className="sidebar-stat-label">Total models</span>
              <span className="sidebar-stat-val">{stats?.total ?? '—'}</span>
            </div>
            <div className="sidebar-stat">
              <span className="sidebar-stat-label">Creators</span>
              <span className="sidebar-stat-val">{stats?.creators ?? '—'}</span>
            </div>
            <div className="sidebar-stat">
              <span className="sidebar-stat-label">With images</span>
              <span className="sidebar-stat-val">{stats?.withImages ?? '—'}</span>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-label">Filter by Status</div>
            {STATUS_OPTIONS.map(s => (
              <button
                key={s.value}
                className={`status-filter-btn ${filters.status === s.value ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, status: s.value })}
              >
                <span className="dot" style={{ background: s.dot }} />
                {s.label}
                {s.value && <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-faint)' }}>
                  {getCount(s.value)}
                </span>}
              </button>
            ))}
          </div>

          <div className="sidebar-section" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="sidebar-section-label">Creators</div>
            <div className="creator-list">
              <button
                className={`creator-btn ${filters.creator === '' ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, creator: '' })}
              >
                <span>All Creators</span>
                <span className="count">{stats?.creators ?? ''}</span>
              </button>
              {creators.map(c => (
                <button
                  key={c.id}
                  className={`creator-btn ${filters.creator === c.name ? 'active' : ''}`}
                  onClick={() => onFilterChange({ ...filters, creator: c.name })}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  <span className="count">{c.model_count}</span>
                </button>
              ))}
            </div>
          </div>

          <button className="scan-btn" onClick={onScanClick}>
            ⟳ SCAN LIBRARY
          </button>
        </>
      )}

      {!open && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '16px 0' }}>
          <button onClick={onScanClick} title="Scan Library" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' }}>⟳</button>
          <button onClick={onHomeClick} title="Gallery" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}>⊞</button>
        </div>
      )}
    </aside>
  );
}
