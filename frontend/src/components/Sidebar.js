import React, { useState } from 'react';
import RenderHintPanel from './RenderHintPanel';

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
  const [hintCreator, setHintCreator] = useState(null); // { id, name, render_zip_hint }
  const byStatus = stats?.byStatus || [];
  const getCount = (status) => (byStatus.find(b => b.print_status === status) || {}).n || 0;

  return (
    <>
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
              <div className="sidebar-stat"><span className="sidebar-stat-label">Total models</span><span className="sidebar-stat-val">{stats?.total ?? '—'}</span></div>
              <div className="sidebar-stat"><span className="sidebar-stat-label">Creators</span><span className="sidebar-stat-val">{stats?.creators ?? '—'}</span></div>
              <div className="sidebar-stat"><span className="sidebar-stat-label">With images</span><span className="sidebar-stat-val">{stats?.withImages ?? '—'}</span></div>
            </div>

            <div className="sidebar-section">
              <div className="sidebar-section-label">Filter by Status</div>
              {STATUS_OPTIONS.map(s => (
                <button key={s.value} className={`status-filter-btn ${filters.status === s.value ? 'active' : ''}`}
                  onClick={() => onFilterChange({ ...filters, status: s.value })}>
                  <span className="dot" style={{ background: s.dot }} />
                  {s.label}
                  {s.value && <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-faint)' }}>{getCount(s.value)}</span>}
                </button>
              ))}
            </div>

            <div className="sidebar-section" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="sidebar-section-label">Creators</div>
              <div className="creator-list">
                <button className={`creator-btn ${filters.creator === '' ? 'active' : ''}`}
                  onClick={() => onFilterChange({ ...filters, creator: '' })}>
                  <span>All Creators</span>
                  <span className="count">{stats?.creators ?? ''}</span>
                </button>
                {creators.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <button
                      className={`creator-btn ${filters.creator === c.name ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => onFilterChange({ ...filters, creator: c.name })}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{c.name}</span>
                      {c.render_zip_hint && (
                        <span title={`Render hint: ${c.render_zip_hint}`}
                          style={{ fontSize: 9, color: 'var(--accent)', flexShrink: 0, marginRight: 2 }}>📦</span>
                      )}
                      <span className="count">{c.model_count}</span>
                    </button>
                    <button
                      title="Configure render ZIP hint"
                      onClick={e => { e.stopPropagation(); setHintCreator(hintCreator?.id === c.id ? null : c); }}
                      style={{
                        background: hintCreator?.id === c.id ? 'rgba(193,127,58,0.15)' : 'none',
                        border: `1px solid ${hintCreator?.id === c.id ? 'var(--accent)' : 'transparent'}`,
                        borderRadius: 3, color: hintCreator?.id === c.id ? 'var(--accent)' : 'var(--text-faint)',
                        cursor: 'pointer', fontSize: 11, padding: '2px 4px', flexShrink: 0, lineHeight: 1,
                      }}>
                      ⚙
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <button className="scan-btn" onClick={onScanClick}>⟳ SCAN LIBRARY</button>
          </>
        )}

        {!open && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '16px 0' }}>
            <button onClick={onScanClick} title="Scan Library" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' }}>⟳</button>
            <button onClick={onHomeClick} title="Gallery" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}>⊞</button>
          </div>
        )}
      </aside>

      {/* Render hint flyout — appears as an overlay panel next to sidebar */}
      {hintCreator && open && (
        <div style={{
          position: 'fixed', left: 220, top: 0, bottom: 0,
          width: 360, zIndex: 200, background: 'var(--bg)',
          borderRight: '1px solid var(--border-bright)',
          boxShadow: '4px 0 24px rgba(0,0,0,0.5)',
          overflowY: 'auto', padding: 16,
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 12 }}>
            {hintCreator.name}
          </div>
          <RenderHintPanel
            mode="creator"
            creatorId={hintCreator.id}
            currentHint={hintCreator.render_zip_hint}
            onClose={() => setHintCreator(null)}
            onSaved={(hint) => {
              // Refresh creator list so hint badge updates
              setHintCreator(prev => prev ? { ...prev, render_zip_hint: hint } : null);
            }}
          />
        </div>
      )}
    </>
  );
}
