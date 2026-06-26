import React, { useState } from 'react';
import RenderHintPanel from './RenderHintPanel';
import FolderTree from './FolderTree';

const COLLAPSED_HEIGHT = 200; // px — show ~6 items before "Show more"

/** Scrollable, collapsible sidebar list with a "Show N more" toggle */
function CollapsibleList({ label, onClear, items, renderItem, activeKey, getKey, extraControls }) {
  const [expanded, setExpanded] = useState(false);
  const hasActive = activeKey && items.some(i => getKey(i) === activeKey);
  // If the active item is past the fold, always expand
  const shouldExpand = expanded || hasActive;

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{label} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>{items.length}</span></span>
        <div style={{ display: 'flex', gap: 4 }}>
          {extraControls}
          {onClear && (
            <button onClick={onClear}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
              CLEAR
            </button>
          )}
        </div>
      </div>
      <div className="creator-list" style={{ maxHeight: shouldExpand ? 320 : COLLAPSED_HEIGHT, overflowY: 'auto' }}>
        {items.map(item => renderItem(item))}
      </div>
      {items.length > 6 && (
        <button onClick={() => setExpanded(e => !e)}
          style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)', padding: '3px 0', width: '100%', textAlign: 'left' }}>
          {shouldExpand ? '▲ Show less' : `▼ Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Models', dot: '#4a4a5a' },
  { value: 'unprinted', label: 'Unprinted', dot: '#4a4a5a' },
  { value: 'sliced', label: 'Sliced', dot: '#5b9bd5' },
  { value: 'printing', label: 'Printing', dot: '#d4aa4c' },
  { value: 'printed', label: 'Printed', dot: '#4caf7d' },
  { value: 'painted', label: 'Painted', dot: '#9b72cf' },
  { value: 'failed', label: 'Failed', dot: '#cf7272' },
];

export default function Sidebar({ open, onToggle, stats, creators, tags, filters, onFilterChange, onScanClick, onOrganizeClick, onHomeClick, showHidden, onToggleHidden, appVersion, onRescanCreator, franchises, collections, queueCount, onQueueClick, onWishlistClick, wishlistCount, onCollectionClick, onCollectionsChange, recentlyViewed, onRecentClick, folderTree, onFolderSelect }) {
  const [hintCreator, setHintCreator] = useState(null); // { id, name, render_zip_hint }
  const [showAllTags, setShowAllTags] = useState(false);
  const [rescanningId, setRescanningId] = useState(null);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showNewCollection, setShowNewCollection] = useState(false);

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) return;
    await fetch('/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCollectionName.trim() }),
    });
    setNewCollectionName(''); setShowNewCollection(false);
    if (onCollectionsChange) onCollectionsChange();
  };

  const handleDeleteCollection = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Delete this collection?')) return;
    await fetch(`/api/collections/${id}`, { method: 'DELETE' });
    if (onCollectionsChange) onCollectionsChange();
    if (filters.collection === String(id)) onFilterChange({ ...filters, collection: '' });
  };

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
            {/* Always-visible scan/organize actions, pinned just under the header */}
            <div className="sidebar-actions">
              <button className="scan-btn" onClick={onScanClick} style={{ margin: 0, flex: 1 }}>⟳ SCAN LIBRARY</button>
              <button className="scan-btn" onClick={onOrganizeClick} title="Organize Library"
                style={{ margin: 0, flex: '0 0 auto', background: 'rgba(193,127,58,0.12)', color: 'var(--accent)', padding: '10px 12px' }}>🗂</button>
            </div>

            <div className="sidebar-scroll">
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
              <button
                onClick={onQueueClick}
                style={{ marginTop: 8, width: '100%', background: queueCount > 0 ? 'rgba(193,127,58,0.12)' : 'var(--bg3)', border: `1px solid ${queueCount > 0 ? 'rgba(193,127,58,0.4)' : 'var(--border)'}`, borderRadius: 4, color: queueCount > 0 ? '#c17f3a' : 'var(--text-muted)', padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 6 }}>
                🖨 Print Queue
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{queueCount > 0 ? queueCount : ''}</span>
              </button>
              <button
                onClick={onWishlistClick}
                style={{ marginTop: 4, width: '100%', background: wishlistCount > 0 ? 'rgba(91,155,213,0.1)' : 'var(--bg3)', border: `1px solid ${wishlistCount > 0 ? 'rgba(91,155,213,0.4)' : 'var(--border)'}`, borderRadius: 4, color: wishlistCount > 0 ? '#5b9bd5' : 'var(--text-muted)', padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 6 }}>
                ☆ Wishlist
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{wishlistCount > 0 ? wishlistCount : ''}</span>
              </button>
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
              <CollapsibleList
                label="Franchise"
                onClear={filters.franchise ? () => onFilterChange({ ...filters, franchise: '' }) : null}
                items={franchises}
                renderItem={f => (
                  <button
                    key={f.franchise}
                    className={`creator-btn ${filters.franchise === f.franchise ? 'active' : ''}`}
                    onClick={() => onFilterChange({ ...filters, franchise: filters.franchise === f.franchise ? '' : f.franchise })}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{f.franchise}</span>
                    <span className="count">{f.count}</span>
                  </button>
                )}
                activeKey={filters.franchise}
                getKey={f => f.franchise}
              />
            )}

            {/* Collections */}
            <div className="sidebar-section">
              <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                Collections
                <div style={{ display: 'flex', gap: 4 }}>
                  {filters.collection && (
                    <button onClick={() => onFilterChange({ ...filters, collection: '' })}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
                      CLEAR
                    </button>
                  )}
                  <button onClick={() => setShowNewCollection(s => !s)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
                    title="New collection">+</button>
                </div>
              </div>
              {showNewCollection && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                  <input value={newCollectionName} onChange={e => setNewCollectionName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateCollection(); if (e.key === 'Escape') setShowNewCollection(false); }}
                    placeholder="Collection name" autoFocus
                    style={{ flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 7px', fontSize: 11, outline: 'none', fontFamily: 'var(--font-body)' }} />
                  <button onClick={handleCreateCollection}
                    style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#0d0d0f', padding: '4px 8px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-display)' }}>
                    ADD
                  </button>
                </div>
              )}
              {collections && collections.length > 0 ? (
                <div className="creator-list" style={{ maxHeight: 180, overflowY: 'auto' }}>
                  {collections.map(c => (
                    <button key={c.id}
                      className={`creator-btn ${filters.collection === String(c.id) ? 'active' : ''}`}
                      onClick={() => { onFilterChange({ ...filters, collection: filters.collection === String(c.id) ? '' : String(c.id) }); }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{c.name}</span>
                      <span className="count">{c.model_count}</span>
                      <span onClick={e => handleDeleteCollection(e, c.id)}
                        style={{ color: 'var(--text-faint)', fontSize: 10, padding: '0 2px', opacity: 0.6 }}
                        title="Delete collection">✕</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 0' }}>
                  No collections yet. Press + to create one.
                </div>
              )}
            </div>

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

            {/* Folder tree */}
            {folderTree && folderTree.children && folderTree.children.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Folders
                  {filters.folder && (
                    <button onClick={() => onFolderSelect && onFolderSelect('')}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
                      CLEAR
                    </button>
                  )}
                </div>
                {filters.folder && (
                  <div title={filters.folder}
                    style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)', padding: '0 2px 5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ▸ {filters.folder.split('/').filter(Boolean).slice(-1)[0]}
                  </div>
                )}
                <FolderTree
                  tree={folderTree}
                  activePath={filters.folder}
                  onSelect={(p) => onFolderSelect && onFolderSelect(p)}
                />
              </div>
            )}

            {/* Creators */}
            <div className="sidebar-section" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="sidebar-section-label">
                Creators <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>{creators.length}</span>
              </div>
              <div className="creator-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
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

            {/* Recently Viewed */}
            {recentlyViewed && recentlyViewed.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Recently Viewed
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>{recentlyViewed.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {recentlyViewed.map(m => (
                    <button
                      key={m.id}
                      onClick={() => onRecentClick && onRecentClick(m)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        background: 'none', border: 'none', borderRadius: 4,
                        padding: '3px 4px', cursor: 'pointer', textAlign: 'left',
                        width: '100%',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      {m.thumbnail_path ? (
                        <img src={m.thumbnail_path} alt="" style={{ width: 28, height: 28, borderRadius: 3, objectFit: 'cover', flexShrink: 0, background: 'var(--bg3)' }} />
                      ) : (
                        <div style={{ width: 28, height: 28, borderRadius: 3, background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>🧩</div>
                      )}
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.creator_name || '—'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {appVersion && (
              <div style={{ padding: '8px 16px', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', letterSpacing: 1, textAlign: 'center' }}>
                v{appVersion}
              </div>
            )}
            </div>{/* /.sidebar-scroll */}
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
