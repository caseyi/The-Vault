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

export default function Sidebar({ open, onToggle, stats, creators, tags, filters, onFilterChange, onScanClick, onOrganizeClick, onHomeClick, showHidden, onToggleHidden, appVersion, onRescanCreator, franchises }) {
  const [hintCreator, setHintCreator] = useState(null); // { id, name, render_zip_hint }
  const [showAllTags, setShowAllTags] = useState(false);
  const [rescanningId, setRescanningId] = useState(null);

  const handleRescanCreator = async (e, creator) => {
    e.stopPropagation();
    if (rescanningId) return;
    setRescanningId(creator.id);
    try {
      await fetch(`/api/scan/creator/${creator.id}`, { method: 'POST' });
      if (onRescanCreator) onRescanCreator(creator);
    } catch {}
    // Keep spinner showing until scan modal closes/refreshes
    setTimeout(() => setRescanningId(null), 1500);
  };

  const activeTags = filters.tags ? filters.tags.split(',').filter(Boolean) : [];
  const toggleTag = (tag) => {
    const newTags = activeTags.includes(tag)
      ? activeTags.filter(t => t !== tag)
      : [...activeTags, tag];
    onFilterChange({ ...filters, tags: newTags.join(',') });
  };
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
              {(stats?.totalHidden > 0) && (
                <div className="sidebar-stat">
                  <span className="sidebar-stat-label">Hidden</span>
                  <span className="sidebar-stat-val" style={{ color: 'var(--text-faint)' }}>{stats.totalHidden}</span>
                </div>
              )}
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

            {/* Show Hidden toggle */}
            {(stats?.totalHidden > 0 || showHidden) && (
              <div className="sidebar-section" style={{ paddingTop: 0 }}>
                <button
                  className={`status-filter-btn ${showHidden ? 'active' : ''}`}
                  onClick={onToggleHidden}
                  style={{ color: showHidden ? 'var(--accent)' : 'var(--text-muted)' }}
                  title={showHidden ? 'Hide hidden models' : 'Show hidden models'}
                >
                  <span className="dot" style={{ background: showHidden ? '#c17f3a' : '#2a2a35' }} />
                  Show Hidden
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-faint)' }}>
                    {stats?.totalHidden ?? 0}
                  </span>
                </button>
              </div>
            )}

            {/* Thumbnail filter + Recently Added */}
            <div className="sidebar-section" style={{ paddingTop: 0 }}>
              {(stats?.recentlyAdded > 0 || filters.recently_added) && (
                <button
                  className={`status-filter-btn ${filters.recently_added ? 'active' : ''}`}
                  onClick={() => onFilterChange({ ...filters, recently_added: !filters.recently_added })}
                  style={{ color: filters.recently_added ? '#4caf7d' : 'var(--text-muted)', marginBottom: 2 }}
                >
                  <span className="dot" style={{ background: filters.recently_added ? '#4caf7d' : '#2a2a35' }} />
                  New This Scan
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-faint)' }}>
                    {stats?.recentlyAdded ?? 0}
                  </span>
                </button>
              )}
              <button
                className={`status-filter-btn ${filters.has_thumbnail ? 'active' : ''}`}
                onClick={() => onFilterChange({ ...filters, has_thumbnail: !filters.has_thumbnail })}
                style={{ color: filters.has_thumbnail ? 'var(--accent)' : 'var(--text-muted)' }}
              >
                <span className="dot" style={{ background: filters.has_thumbnail ? 'var(--accent)' : '#2a2a35' }} />
                Has Thumbnail
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-faint)' }}>
                  {stats?.withImages ?? 0}
                </span>
              </button>
            </div>

            {/* Franchise filter */}
            {franchises && franchises.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Franchise
                  {filters.franchise && (
                    <button onClick={() => onFilterChange({ ...filters, franchise: '' })}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
                      CLEAR
                    </button>
                  )}
                </div>
                <div className="creator-list">
                  {franchises.map(f => (
                    <button
                      key={f.franchise}
                      className={`creator-btn ${filters.franchise === f.franchise ? 'active' : ''}`}
                      onClick={() => onFilterChange({ ...filters, franchise: filters.franchise === f.franchise ? '' : f.franchise })}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{f.franchise}</span>
                      <span className="count">{f.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tag Cloud */}
            {tags && tags.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Tags
                  {activeTags.length > 0 && (
                    <button onClick={() => onFilterChange({ ...filters, tags: '' })}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
                      CLEAR
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: showAllTags ? 400 : 160, overflowY: 'auto', padding: '2px 0' }}>
                  {(showAllTags ? tags : tags.slice(0, 30)).map(t => {
                    const isActive = activeTags.includes(t.tag);
                    return (
                      <button
                        key={t.tag}
                        onClick={() => toggleTag(t.tag)}
                        style={{
                          background: isActive ? 'rgba(193,127,58,0.2)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${isActive ? 'var(--accent)' : 'rgba(255,255,255,0.08)'}`,
                          borderRadius: 12, padding: '3px 10px', cursor: 'pointer',
                          fontSize: 11, fontFamily: 'var(--font-mono)',
                          color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                          whiteSpace: 'nowrap', lineHeight: '18px',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {t.tag}
                        <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.6 }}>{t.count}</span>
                      </button>
                    );
                  })}
                  {!showAllTags && tags.length > 30 && (
                    <button
                      onClick={() => setShowAllTags(true)}
                      style={{
                        background: 'none', border: '1px dashed rgba(255,255,255,0.1)',
                        borderRadius: 12, padding: '3px 10px', cursor: 'pointer',
                        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
                      }}
                    >
                      +{tags.length - 30} more
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Creators — collapsed by default when tags are available */}
            <div className="sidebar-section" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
                      title="Rescan this creator's folder"
                      onClick={e => handleRescanCreator(e, c)}
                      style={{
                        background: 'none', border: '1px solid transparent',
                        borderRadius: 3, color: rescanningId === c.id ? 'var(--accent)' : 'var(--text-faint)',
                        cursor: rescanningId ? 'default' : 'pointer', fontSize: 11, padding: '2px 4px', flexShrink: 0, lineHeight: 1,
                        animation: rescanningId === c.id ? 'spin 0.8s linear infinite' : 'none',
                      }}>
                      ⟳
                    </button>
                    <button
                      title="Configure render ZIP hint / notes"
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
            <button className="scan-btn" onClick={onOrganizeClick} style={{ background: 'rgba(193,127,58,0.12)', color: 'var(--accent)', marginTop: 4 }}>🗂 ORGANIZE</button>
            {appVersion && (
              <div style={{ padding: '8px 16px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', letterSpacing: 1, textAlign: 'center' }}>
                v{appVersion}
              </div>
            )}
          </>
        )}

        {!open && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '16px 0' }}>
            <button onClick={onScanClick} title="Scan Library" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' }}>⟳</button>
            <button onClick={onOrganizeClick} title="Organize Library" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' }}>🗂</button>
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
            currentNotes={hintCreator.notes}
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
