import React, { useState, useEffect, useCallback } from 'react';

const STATUS_COLORS = {
  want:     '#5b9bd5',
  scraping: '#d4aa4c',
  got:      '#4caf7d',
  failed:   '#cf7272',
};

const STATUS_ICONS = {
  want: '☆', scraping: '⟳', got: '✓', failed: '✗'
};

const SITE_LABELS = {
  printables: 'Printables', thingiverse: 'Thingiverse',
  myminifactory: 'MyMiniFactory', cults3d: 'Cults3D',
  patreon: 'Patreon', gumroad: 'Gumroad',
};

const STATUS_CYCLE = ['want', 'got', 'failed'];

function WishlistItem({ item, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name || '');
  const [notes, setNotes] = useState(item.notes || '');

  const cycleStatus = () => {
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(item.status) + 1) % STATUS_CYCLE.length];
    onUpdate(item.id, { status: next });
  };

  const saveEdit = async () => {
    await onUpdate(item.id, { name, notes });
    setEditing(false);
  };

  return (
    <div style={{
      background: '#1c1c21', border: '1px solid #2a2a35', borderRadius: 8,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
      opacity: item.status === 'got' ? 0.6 : 1,
    }}>
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Status toggle */}
        <button onClick={cycleStatus} title="Cycle status"
          style={{
            flexShrink: 0, width: 28, height: 28, borderRadius: 6,
            background: `${STATUS_COLORS[item.status]}22`,
            border: `1px solid ${STATUS_COLORS[item.status]}`,
            color: STATUS_COLORS[item.status],
            cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          {STATUS_ICONS[item.status]}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Model name (optional)"
              style={{ width: '100%', background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '4px 8px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-body)', boxSizing: 'border-box' }}
              autoFocus
            />
          ) : (
            <div style={{ fontSize: 13, color: item.name ? '#e8e8f0' : '#5a5a6a', fontWeight: item.name ? 500 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name || '(unnamed)'}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
            {item.source_site && (
              <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: 1, color: '#c17f3a', background: 'rgba(193,127,58,0.1)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(193,127,58,0.2)', textTransform: 'uppercase' }}>
                {SITE_LABELS[item.source_site] || item.source_site}
              </span>
            )}
            <a href={item.url} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: '#5b9bd5', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}
              title={item.url}>
              {item.url}
            </a>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {editing ? (
            <>
              <button onClick={saveEdit}
                style={{ background: '#c17f3a', border: 'none', borderRadius: 4, color: '#0d0d0f', padding: '4px 10px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-display)' }}>
                Save
              </button>
              <button onClick={() => { setEditing(false); setName(item.name || ''); setNotes(item.notes || ''); }}
                style={{ background: 'none', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}>
                ✕
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} title="Edit"
                style={{ background: 'none', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}>
                ✎
              </button>
              <button onClick={() => onDelete(item.id)} title="Remove from wishlist"
                style={{ background: 'none', border: '1px solid #3f3f4d', borderRadius: 4, color: '#7a7a8c', padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}>
                ✕
              </button>
            </>
          )}
        </div>
      </div>

      {/* Notes row (when editing or notes exist) */}
      {editing ? (
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)..."
          rows={2}
          style={{ width: '100%', background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '5px 8px', fontSize: 12, outline: 'none', fontFamily: 'var(--font-body)', resize: 'vertical', boxSizing: 'border-box' }}
        />
      ) : item.notes ? (
        <div style={{ fontSize: 11, color: '#7a7a8c', paddingLeft: 38 }}>{item.notes}</div>
      ) : null}
    </div>
  );
}

export default function Wishlist({ onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('all'); // all | want | got | failed

  const fetchItems = useCallback(() => {
    setLoading(true);
    fetch('/api/wishlist')
      .then(r => r.json())
      .then(d => { setItems(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleAdd = async () => {
    if (!url.trim()) return;
    setAdding(true);
    await fetch('/api/wishlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), name: name.trim() || undefined }),
    });
    setUrl(''); setName('');
    setAdding(false);
    fetchItems();
  };

  const handleDelete = async (id) => {
    await fetch(`/api/wishlist/${id}`, { method: 'DELETE' });
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const handleUpdate = async (id, patch) => {
    await fetch(`/api/wishlist/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  };

  const counts = { all: items.length, want: 0, got: 0, failed: 0 };
  items.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });
  const visible = filter === 'all' ? items : items.filter(i => i.status === filter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="gallery-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="gallery-title">WISHLIST</div>
        <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)' }}>
          {items.length} item{items.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 780 }}>
        {/* Add form */}
        <div style={{ background: '#1c1c21', border: '1px solid #2a2a35', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1 }}>ADD TO WISHLIST</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="Paste URL (Printables, Thingiverse, MMF, Cults3D…)"
              style={{ flex: 2, background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-body)' }}
            />
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="Name (optional)"
              style={{ flex: 1, background: '#242429', border: '1px solid #3f3f4d', borderRadius: 4, color: '#e8e8f0', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-body)' }}
            />
            <button onClick={handleAdd} disabled={adding || !url.trim()}
              style={{
                background: '#c17f3a', border: 'none', borderRadius: 4, color: '#0d0d0f',
                padding: '7px 18px', cursor: adding || !url.trim() ? 'not-allowed' : 'pointer',
                fontSize: 12, fontFamily: 'var(--font-display)', letterSpacing: 1,
                opacity: adding || !url.trim() ? 0.5 : 1,
              }}>
              {adding ? '...' : '+ ADD'}
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        {items.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {['all', 'want', 'got', 'failed'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  background: filter === f ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
                  border: `1px solid ${filter === f ? '#c17f3a' : 'var(--border)'}`,
                  borderRadius: 4, color: filter === f ? '#c17f3a' : 'var(--text-muted)',
                  padding: '4px 12px', cursor: 'pointer', fontSize: 11,
                  fontFamily: 'var(--font-mono)', letterSpacing: 0.5,
                }}>
                {f.charAt(0).toUpperCase() + f.slice(1)} <span style={{ opacity: 0.6 }}>{counts[f]}</span>
              </button>
            ))}
          </div>
        )}

        {/* List */}
        {loading && <div className="loading"><div className="spinner" /> Loading...</div>}
        {!loading && visible.length === 0 && (
          <div className="empty-state" style={{ minHeight: 160 }}>
            <div className="empty-icon">☆</div>
            <div className="empty-title">{filter === 'all' ? 'WISHLIST IS EMPTY' : `NO ${filter.toUpperCase()} ITEMS`}</div>
            <div className="empty-msg">{filter === 'all' ? 'Paste a URL above to start tracking models you want.' : 'Try a different filter.'}</div>
          </div>
        )}
        {!loading && visible.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map(item => (
              <WishlistItem key={item.id} item={item} onDelete={handleDelete} onUpdate={handleUpdate} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
