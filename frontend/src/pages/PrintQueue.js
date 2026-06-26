import React, { useState, useEffect, useCallback, useRef } from 'react';

const STATUS_COLORS = {
  unprinted: '#4a4a5a', sliced: '#5b9bd5', printing: '#c17f3a',
  printed: '#4caf7d', painted: '#a78bd4', failed: '#cf7272',
};

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];

export default function PrintQueue({ onModelClick, onQueueChange }) {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(null); // index being dragged
  const [dragOver, setDragOver] = useState(null); // index being hovered
  const [saving, setSaving] = useState(false);
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/queue');
      setQueue(await r.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  const removeFromQueue = async (modelId) => {
    await fetch(`/api/queue/${modelId}`, { method: 'DELETE' });
    setQueue(q => q.filter(m => m.model_id !== modelId));
    if (onQueueChange) onQueueChange();
  };

  const setStatus = async (modelId, status) => {
    setQueue(q => q.map(m => m.model_id === modelId ? { ...m, print_status: status } : m));
    await fetch(`/api/models/${modelId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ print_status: status }),
    });
    if (onQueueChange) onQueueChange();
  };

  const markPrintedAndRemove = async (modelId) => {
    await fetch(`/api/models/${modelId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ print_status: 'printed' }),
    });
    await fetch(`/api/queue/${modelId}`, { method: 'DELETE' });
    setQueue(q => q.filter(m => m.model_id !== modelId));
    if (onQueueChange) onQueueChange();
  };

  const saveNote = async (modelId, note) => {
    await fetch(`/api/queue/${modelId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
  };

  const onNoteChange = (modelId, note) => {
    setQueue(q => q.map(m => m.model_id === modelId ? { ...m, note } : m));
  };

  // ── Drag-to-reorder (HTML5 Drag API) ──────────────────────────────────────

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    setDragging(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnter = (index) => {
    dragOverItem.current = index;
    setDragOver(index);
  };

  const handleDragEnd = async () => {
    const from = dragItem.current;
    const to = dragOverItem.current;
    setDragging(null);
    setDragOver(null);
    dragItem.current = null;
    dragOverItem.current = null;

    if (from === null || to === null || from === to) return;

    const reordered = [...queue];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    setQueue(reordered);

    setSaving(true);
    await fetch('/api/queue/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: reordered.map(m => m.model_id) }),
    });
    setSaving(false);
    if (onQueueChange) onQueueChange();
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        Loading queue…
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--text)' }}>
          Print Queue
        </h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-faint)' }}>
          {queue.length} model{queue.length !== 1 ? 's' : ''}
        </span>
        {saving && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#c17f3a', marginLeft: 'auto' }}>Saving…</span>}
      </div>

      {queue.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🖨</div>
          Queue is empty. Open a model and click "Add to Queue" to get started.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {queue.map((item, index) => (
            <div
              key={item.model_id}
              style={{
                background: dragging === index ? 'rgba(193,127,58,0.1)' : dragOver === index ? 'rgba(91,155,213,0.12)' : 'var(--bg2)',
                border: `1px solid ${dragOver === index ? '#5b9bd5' : 'var(--border)'}`,
                borderRadius: 6, padding: '8px 12px',
                opacity: dragging === index ? 0.5 : 1,
                transition: 'background 0.1s, border-color 0.1s',
              }}
            >
              <div
                draggable
                onDragStart={e => handleDragStart(e, index)}
                onDragEnter={() => handleDragEnter(index)}
                onDragOver={e => e.preventDefault()}
                onDragEnd={handleDragEnd}
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'grab', userSelect: 'none' }}
              >
                {/* Priority number */}
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#c17f3a', minWidth: 24, textAlign: 'right' }}>
                  #{index + 1}
                </div>

                {/* Drag handle */}
                <div style={{ color: 'var(--text-faint)', fontSize: 14, cursor: 'grab', padding: '0 2px' }}>⠿</div>

                {/* Thumbnail */}
                {item.thumbnail_path ? (
                  <img src={`/images/${item.thumbnail_path.split('/images/').pop()}`} alt=""
                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, flexShrink: 0, background: 'var(--bg3)' }} />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: 4, background: 'var(--bg3)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 18 }}>
                    📦
                  </div>
                )}

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    onClick={() => onModelClick && onModelClick({ id: item.model_id })}
                  >
                    {item.name}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                    {item.creator_name}
                    {item.franchise && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{item.franchise}</span>}
                  </div>
                </div>

                {/* Inline status selector */}
                <select
                  value={item.print_status}
                  onChange={e => setStatus(item.model_id, e.target.value)}
                  title="Set print status"
                  style={{
                    background: 'var(--bg3)', border: `1px solid ${STATUS_COLORS[item.print_status] || 'var(--border)'}`,
                    borderRadius: 4, color: STATUS_COLORS[item.print_status] || 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 4px', cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s} style={{ color: 'var(--text)' }}>{s}</option>)}
                </select>

                {/* Mark printed + remove from queue */}
                <button
                  onClick={() => markPrintedAndRemove(item.model_id)}
                  style={{ background: 'rgba(76,175,125,0.12)', border: '1px solid rgba(76,175,125,0.4)', borderRadius: 4, color: '#4caf7d', cursor: 'pointer', fontSize: 11, padding: '3px 8px', fontFamily: 'var(--font-mono)', flexShrink: 0, whiteSpace: 'nowrap' }}
                  title="Mark printed and remove from queue"
                >
                  ✓ Done
                </button>

                {/* Remove */}
                <button
                  onClick={() => removeFromQueue(item.model_id)}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-faint)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', fontFamily: 'var(--font-mono)', flexShrink: 0 }}
                  title="Remove from queue"
                >
                  ✕
                </button>
              </div>

              {/* Per-item note */}
              <input
                value={item.note || ''}
                onChange={e => onNoteChange(item.model_id, e.target.value)}
                onBlur={e => saveNote(item.model_id, e.target.value)}
                placeholder="Add a note (e.g. 0.12mm, 3 copies, supports on)…"
                style={{
                  width: '100%', marginTop: 8, background: 'var(--bg3)', border: '1px solid var(--border)',
                  borderRadius: 4, color: 'var(--text)', padding: '5px 8px', fontSize: 11,
                  outline: 'none', fontFamily: 'var(--font-body)', boxSizing: 'border-box',
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
