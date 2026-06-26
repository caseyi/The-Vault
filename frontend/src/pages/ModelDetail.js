import React, { useState, useEffect, useRef } from 'react';
import StlViewer from '../components/StlViewer';
import ZipImagePicker from '../components/ZipImagePicker';
import ClaudeAssistant from '../components/ClaudeAssistant';
import TaskLog from '../components/TaskLog';
import ReleaseFileList from '../components/ReleaseFileList';
import RenderHintPanel from '../components/RenderHintPanel';

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];
const SOURCE_LABELS = {
  printables: 'Printables', thingiverse: 'Thingiverse',
  myminifactory: 'MyMiniFactory', patreon: 'Patreon',
  gumroad: 'Gumroad', cults3d: 'Cults3D'
};

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// Persist API key in localStorage
function getStoredApiKey() {
  try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; }
}
function setStoredApiKey(key) {
  try { localStorage.setItem('claude_api_key', key); } catch {}
}

const STATUS_COLORS = {
  unprinted: '#4a4a5a', sliced: '#5b9bd5', printing: '#c17f3a',
  printed: '#4caf7d', painted: '#a78bd4', failed: '#cf7272',
};

function StatusHistory({ modelId }) {
  const [log, setLog] = useState([]);
  useEffect(() => {
    fetch(`/api/models/${modelId}/status-log`)
      .then(r => r.json())
      .then(d => setLog(d))
      .catch(() => {});
  }, [modelId]);

  if (!log.length) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1, marginBottom: 6 }}>STATUS HISTORY</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {log.map(entry => (
          <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', minWidth: 100 }}>
              {new Date(entry.changed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}
            </span>
            <span style={{ color: STATUS_COLORS[entry.from_status] || '#4a4a5a', fontSize: 10 }}>
              {entry.from_status || '?'}
            </span>
            <span style={{ color: 'var(--text-faint)', fontSize: 9 }}>→</span>
            <span style={{ color: STATUS_COLORS[entry.to_status] || '#e8e8f0', fontSize: 10, fontWeight: 600 }}>
              {entry.to_status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TagSuggestions({ modelId, existingTags, onAddTag }) {
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    fetch(`/api/models/${modelId}/tag-suggestions`)
      .then(r => r.json()).then(setSuggestions).catch(() => {});
  }, [modelId]);
  if (!suggestions.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1, marginBottom: 4 }}>SUGGESTED</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {suggestions.filter(s => !existingTags.includes(s.tag)).slice(0, 8).map(s => (
          <button key={s.tag} onClick={() => onAddTag(s.tag)}
            style={{ background: 'rgba(91,155,213,0.1)', border: '1px solid rgba(91,155,213,0.3)', borderRadius: 3, color: '#5b9bd5', padding: '2px 8px', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-body)' }}>
            + {s.tag}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelCollections({ modelId, collections, onCollectionsChange }) {
  const [modelCols, setModelCols] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch(`/api/models/${modelId}/collections`)
      .then(r => r.json()).then(setModelCols).catch(() => {});
  }, [modelId]);

  const addToCollection = async (colId) => {
    setAdding(true);
    await fetch(`/api/collections/${colId}/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelIds: [modelId] }),
    });
    const updated = await fetch(`/api/models/${modelId}/collections`).then(r => r.json());
    setModelCols(updated); setShowAdd(false); setAdding(false);
    if (onCollectionsChange) onCollectionsChange();
  };

  const removeFromCollection = async (colId) => {
    await fetch(`/api/collections/${colId}/models/${modelId}`, { method: 'DELETE' });
    setModelCols(c => c.filter(x => x.id !== colId));
    if (onCollectionsChange) onCollectionsChange();
  };

  const available = collections.filter(c => !modelCols.find(m => m.id === c.id));

  return (
    <div className="detail-card">
      <div className="detail-card-title">Collections</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {modelCols.map(c => (
          <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 8px', fontSize: 11, color: 'var(--text-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }} />
            {c.name}
            <button onClick={() => removeFromCollection(c.id)}
              style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10, padding: 0, marginLeft: 2 }}>×</button>
          </span>
        ))}
        {available.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowAdd(s => !s)}
              style={{ background: 'none', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-faint)', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>
              + Add
            </button>
            {showAdd && (
              <div style={{ position: 'absolute', top: '110%', left: 0, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 20 }}>
                {available.map(c => (
                  <button key={c.id} onClick={() => addToCollection(c.id)} disabled={adding}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: '7px 12px', color: 'var(--text)', cursor: 'pointer', fontSize: 12, textAlign: 'left' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ModelDetail({ modelId, onBack, onSaved, onQueueChange, collections, onCollectionsChange }) {
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [inQueue, setInQueue] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scrapeLog, setScrapeLog] = useState([]);
  const [scrapeError, setScrapeError] = useState(null);
  const scrapeEsRef = useRef(null);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [showScrapeInput, setShowScrapeInput] = useState(false);
  const [showZipPicker, setShowZipPicker] = useState(false);
  const [showRenderHint, setShowRenderHint] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [viewingStl, setViewingStl] = useState(null);
  const [apiKey, setApiKey] = useState(getStoredApiKey);

  const [status, setStatus] = useState('unprinted');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [activeImg, setActiveImg] = useState(0);
  const [printMode, setPrintMode] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  // Keyboard nav for the fullscreen image lightbox
  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (e) => {
      const imgs = (model?.images) || [];
      if (e.key === 'Escape') setZoomOpen(false);
      else if (e.key === 'ArrowRight') setActiveImg(i => (i + 1) % Math.max(imgs.length, 1));
      else if (e.key === 'ArrowLeft') setActiveImg(i => (i - 1 + imgs.length) % Math.max(imgs.length, 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomOpen, model]);

  const handleApiKeyChange = (key) => {
    setApiKey(key);
    setStoredApiKey(key);
  };

  const PRINTABLE_FILE_TYPES = new Set(['stl', 'slicer', 'zip']);

  const handleTogglePrinted = async (file) => {
    try {
      const res = await fetch(`/api/files/${file.id}/printed`, { method: 'PATCH' });
      const { printed_at } = await res.json();
      // Update file in model state locally
      setModel(m => {
        const updatedFiles = m.files.map(f => f.id === file.id ? { ...f, printed_at } : f);
        // Auto-advance print status based on printable files
        const printable = updatedFiles.filter(f => PRINTABLE_FILE_TYPES.has(f.filetype));
        const doneCnt = printable.filter(f => f.printed_at).length;
        if (printable.length > 0) {
          if (doneCnt === 0) setStatus('unprinted');
          else if (doneCnt < printable.length) setStatus('printing');
          else setStatus('printed');
        }
        return { ...m, files: updatedFiles };
      });
    } catch (e) {
      console.error('Toggle printed failed', e);
    }
  };

  const loadModel = () => {
    setLoading(true);
    fetch(`/api/models/${modelId}`)
      .then(r => r.json())
      .then(m => {
        setModel(m);
        setStatus(m.print_status || 'unprinted');
        setTags(m.tags || []);
        setNotes(m.notes || '');
        setSourceUrl(m.source_url || '');
        setScrapeUrl(m.source_url || '');
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // Check queue status
    fetch('/api/queue').then(r => r.json())
      .then(q => setInQueue(q.some(i => i.model_id === modelId)))
      .catch(() => {});
  };

  const toggleQueue = async () => {
    setQueueLoading(true);
    if (inQueue) {
      await fetch(`/api/queue/${modelId}`, { method: 'DELETE' });
      setInQueue(false);
    } else {
      await fetch('/api/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      setInQueue(true);
    }
    setQueueLoading(false);
    if (onQueueChange) onQueueChange();
  };

  useEffect(() => { loadModel(); }, [modelId]);

  useEffect(() => {
    if (!model || model.source_url) return;
    fetch(`/api/models/${modelId}/detect-url`)
      .then(r => r.json())
      .then(data => { if (data.url) setScrapeUrl(data.url); })
      .catch(() => {});
  }, [model, modelId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ print_status: status, tags, notes, source_url: sourceUrl })
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (onSaved) onSaved();
    } catch {}
    setSaving(false);
  };

  const handleScrape = async () => {
    setScraping(true);
    setScrapeError(null);
    setScrapeLog([{ level: 'info', msg: `Starting fetch for: ${scrapeUrl || '(auto-detect)'}`, ts: new Date().toISOString() }]);

    try {
      await fetch(`/api/models/${modelId}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ url: scrapeUrl || undefined }),
      });
    } catch (e) {
      setScrapeLog(l => [...l, { level: 'error', msg: e.message, ts: new Date().toISOString() }]);
      setScraping(false);
      return;
    }

    // Re-open as SSE stream
    const es = new EventSource(`/api/models/${modelId}/scrape-stream?url=${encodeURIComponent(scrapeUrl || '')}`);
    scrapeEsRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        es.close();
        setScraping(false);
        if (data.success) {
          setShowScrapeInput(false);
          loadModel();
          if (onSaved) onSaved();
        } else {
          setScrapeError(data.error);
        }
      } else {
        setScrapeLog(l => [...l, data]);
      }
    };
    es.onerror = () => {
      setScrapeLog(l => [...l, { level: 'error', msg: 'Connection lost.', ts: new Date().toISOString() }]);
      setScraping(false);
      es.close();
    };
  };

  const addTag = (val) => {
    const t = val.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };
  const removeTag = (t) => setTags(tags.filter(x => x !== t));

  const handleApplyTag = (tag) => {
    if (!tags.includes(tag)) setTags(prev => [...prev, tag]);
  };
  const handleApplyAllTags = (newTags) => {
    setTags(prev => [...new Set([...prev, ...newTags])]);
  };
  const handleApplyStatus = (s) => setStatus(s);
  const handleApplyNotes = (n) => setNotes(n);

  if (loading) return <div className="loading"><div className="spinner" /> Loading...</div>;
  if (!model) return <div className="loading">Model not found</div>;

  const images = model.images || [];

  return (
    <div className="detail-page">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <div className="detail-name">{model.name}</div>
        {model.source_site && (
          <span className={`source-badge source-${model.source_site}`}>
            {SOURCE_LABELS[model.source_site] || model.source_site}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={async () => {
              const newHidden = !(model.hidden === 1 || model.hidden === true);
              await fetch(`/api/models/${model.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hidden: newHidden })
              });
              setModel(m => ({ ...m, hidden: newHidden ? 1 : 0 }));
              if (onSaved) onSaved();
            }}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius)',
              background: (model.hidden === 1 || model.hidden === true) ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
              border: `1px solid ${(model.hidden === 1 || model.hidden === true) ? 'var(--accent)' : 'var(--border)'}`,
              color: (model.hidden === 1 || model.hidden === true) ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)',
            }}>
            {(model.hidden === 1 || model.hidden === true) ? '👁 Unhide' : '🙈 Hide'}
          </button>
          <button onClick={() => setShowAssistant(s => !s)}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius)',
              background: showAssistant ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
              border: `1px solid ${showAssistant ? 'var(--accent)' : 'var(--border)'}`,
              color: showAssistant ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)',
              display: 'flex', alignItems: 'center', gap: 6
            }}>
            ✦ {showAssistant ? 'Hide' : 'Ask Claude'}
          </button>
        </div>
      </div>

      <div className="detail-scroll">
        {/* Main layout — expands to 3 cols when assistant is open */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: showAssistant ? '1fr 300px 300px' : '1fr 300px',
          gap: 20, maxWidth: showAssistant ? 1300 : 1100, alignItems: 'start'
        }}>

          {/* Left: images + files */}
          <div>
            {viewingStl ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>3D VIEW — {viewingStl.filename}</span>
                  <button onClick={() => setViewingStl(null)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>✕ Close viewer</button>
                </div>
                <StlViewer fileId={viewingStl.id} filename={viewingStl.filename} />
              </div>
            ) : (
              <div className="detail-images" style={{ marginBottom: 16 }}>
                {images.length > 0 ? (
                  <>
                    <img className="detail-main-img" src={images[activeImg]} alt={model.name}
                      style={{ cursor: 'zoom-in' }} onClick={() => setZoomOpen(true)}
                      title="Click to view full size" />
                    {zoomOpen && (
                      <div onClick={() => setZoomOpen(false)}
                        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(8,8,10,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img src={images[activeImg]} alt={model.name} onClick={e => e.stopPropagation()}
                          style={{ maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
                        <button onClick={() => setZoomOpen(false)} title="Close (Esc)"
                          style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(0,0,0,0.5)', border: '1px solid #ffffff33', color: '#fff', borderRadius: 6, fontSize: 18, padding: '4px 12px', cursor: 'pointer' }}>✕</button>
                        {images.length > 1 && (
                          <>
                            <button onClick={e => { e.stopPropagation(); setActiveImg(i => (i - 1 + images.length) % images.length); }} title="Previous (←)"
                              style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', border: '1px solid #ffffff33', color: '#fff', borderRadius: '50%', width: 44, height: 44, fontSize: 22, cursor: 'pointer' }}>‹</button>
                            <button onClick={e => { e.stopPropagation(); setActiveImg(i => (i + 1) % images.length); }} title="Next (→)"
                              style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', background: 'rgba(0,0,0,0.5)', border: '1px solid #ffffff33', color: '#fff', borderRadius: '50%', width: 44, height: 44, fontSize: 22, cursor: 'pointer' }}>›</button>
                            <div style={{ position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 12, padding: '3px 12px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{activeImg + 1} / {images.length}</div>
                          </>
                        )}
                      </div>
                    )}
                    {images.length > 1 && (
                      <div className="detail-thumbs">
                        {images.map((img, i) => (
                          <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                            <img className={`detail-thumb ${activeImg === i ? 'active' : ''}`} src={img} alt="" onClick={() => setActiveImg(i)} />
                            <button
                              title={model.thumbnail_path === img ? 'Current thumbnail' : 'Set as gallery thumbnail'}
                              onClick={async (e) => {
                                e.stopPropagation();
                                await fetch(`/api/models/${modelId}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ thumbnail_path: img })
                                });
                                loadModel();
                                if (onSaved) onSaved();
                              }}
                              style={{
                                position: 'absolute', top: 2, right: 2,
                                background: model.thumbnail_path === img ? 'var(--accent)' : 'rgba(13,13,15,0.7)',
                                border: 'none', borderRadius: 3, cursor: 'pointer',
                                padding: '1px 4px', fontSize: 11, lineHeight: 1,
                                color: model.thumbnail_path === img ? '#0d0d0f' : '#8899aa',
                                backdropFilter: 'blur(4px)',
                                opacity: model.thumbnail_path === img ? 1 : 0.7,
                                transition: 'opacity 0.15s',
                              }}
                              onMouseEnter={e => e.target.style.opacity = 1}
                              onMouseLeave={e => { if (model.thumbnail_path !== img) e.target.style.opacity = 0.7; }}
                            >★</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="detail-no-img">🧩</div>
                )}
              </div>
            )}

            {/* Image tools */}
            <div className="detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-card-title">
                Images
                <span style={{ marginLeft: 8, color: 'var(--text-faint)', fontWeight: 'normal' }}>{images.length} found</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setShowZipPicker(s => !s); setShowScrapeInput(false); setShowRenderHint(false); }}
                  style={{ flex: 1, padding: '7px 8px', background: showZipPicker ? 'rgba(193,127,58,0.1)' : 'var(--bg3)', border: `1px dashed ${showZipPicker ? 'var(--accent)' : 'var(--border-bright)'}`, borderRadius: 'var(--radius)', color: showZipPicker ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
                  📦 Extract from ZIP
                </button>
                <button onClick={() => { setShowScrapeInput(s => !s); setShowZipPicker(false); setShowRenderHint(false); }}
                  style={{ flex: 1, padding: '7px 8px', background: showScrapeInput ? 'rgba(193,127,58,0.1)' : 'var(--bg3)', border: `1px dashed ${showScrapeInput ? 'var(--accent)' : 'var(--border-bright)'}`, borderRadius: 'var(--radius)', color: showScrapeInput ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
                  🌐 Fetch from site
                </button>
                <button onClick={() => { setShowRenderHint(s => !s); setShowZipPicker(false); setShowScrapeInput(false); }}
                  title="Set which ZIP to auto-extract renders from on next scan"
                  style={{ padding: '7px 10px', background: showRenderHint ? 'rgba(193,127,58,0.1)' : 'var(--bg3)', border: `1px dashed ${showRenderHint ? 'var(--accent)' : 'var(--border-bright)'}`, borderRadius: 'var(--radius)', color: showRenderHint ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}>
                  ⚙
                </button>
              </div>

              {showRenderHint && (
                <div style={{ marginTop: 12 }}>
                  <RenderHintPanel
                    mode="model"
                    modelId={modelId}
                    currentHint={model.render_zip_hint}
                    creatorHint={null}
                    onClose={() => setShowRenderHint(false)}
                    onSaved={() => { setShowRenderHint(false); loadModel(); }}
                  />
                </div>
              )}

              {showZipPicker && (
                <div style={{ marginTop: 12 }}>
                  <ZipImagePicker
                    modelId={modelId}
                    onImagesExtracted={() => { setShowZipPicker(false); loadModel(); if (onSaved) onSaved(); }}
                    onClose={() => setShowZipPicker(false)}
                  />
                </div>
              )}

              {showScrapeInput && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>Printables, MyMiniFactory, or Thingiverse URL:</div>
                  <input className="url-input" value={scrapeUrl} onChange={e => setScrapeUrl(e.target.value)} placeholder="https://www.printables.com/model/..." style={{ marginBottom: 8 }} />
                  {scrapeError && (
                    <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8, padding: '6px 8px', background: 'rgba(207,114,114,0.1)', borderRadius: 4 }}>✗ {scrapeError}</div>
                  )}
                  {scrapeLog.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <TaskLog lines={scrapeLog} running={scraping} title="FETCH LOG" height={130} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setShowScrapeInput(false); setScrapeError(null); setScrapeLog([]); scrapeEsRef.current?.close(); }} style={{ flex: 1, padding: '7px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                    <button onClick={handleScrape} disabled={scraping || !scrapeUrl}
                      style={{ flex: 2, padding: '7px', background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius)', color: '#0d0d0f', cursor: scraping ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'var(--font-display)', letterSpacing: 1, opacity: (scraping || !scrapeUrl) ? 0.6 : 1 }}>
                      {scraping ? 'Fetching...' : 'Fetch Images'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Files grouped by release */}
            {model.files && model.files.length > 0 && (() => {
              const printableFiles = model.files.filter(f => PRINTABLE_FILE_TYPES.has(f.filetype));
              const printedCount = printableFiles.filter(f => f.printed_at).length;
              const printProgress = printableFiles.length > 0 ? printedCount / printableFiles.length : 0;
              return (
                <div className="detail-card">
                  <div className="detail-card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>
                      Files
                      <span style={{ marginLeft: 8, color: 'var(--text-faint)', fontWeight: 'normal' }}>
                        {model.file_count} total
                      </span>
                    </span>
                    {printableFiles.length > 0 && (
                      <button
                        onClick={() => setPrintMode(p => !p)}
                        style={{
                          padding: '3px 10px', borderRadius: 4, fontSize: 11,
                          background: printMode ? 'rgba(76,175,125,0.15)' : 'var(--bg4)',
                          border: `1px solid ${printMode ? '#4caf7d' : 'var(--border)'}`,
                          color: printMode ? '#4caf7d' : 'var(--text-muted)',
                          cursor: 'pointer', fontFamily: 'var(--font-mono)',
                        }}>
                        🖨 {printMode ? 'Exit Print Mode' : 'Print Pieces'}
                      </button>
                    )}
                  </div>
                  {printMode && printableFiles.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {printedCount} / {printableFiles.length} pieces printed
                        </span>
                        <span style={{ fontSize: 11, color: printProgress === 1 ? '#4caf7d' : 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                          {Math.round(printProgress * 100)}%
                        </span>
                      </div>
                      <div style={{ height: 4, background: 'var(--bg4)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 2, transition: 'width 0.3s ease',
                          width: `${printProgress * 100}%`,
                          background: printProgress === 1 ? '#4caf7d' : 'var(--accent)',
                        }} />
                      </div>
                    </div>
                  )}
                  <ReleaseFileList
                    files={model.files.filter(f => f.filetype !== 'image')}
                    onView3D={f => setViewingStl(viewingStl?.id === f.id ? null : { id: f.id, filename: f.filename })}
                    viewingStlId={viewingStl?.id}
                    printMode={printMode}
                    onTogglePrinted={handleTogglePrinted}
                  />
                </div>
              );
            })()}
          </div>

          {/* Middle: metadata panel */}
          <div className="detail-panel">
            <div className="detail-card">
              <div className="detail-card-title">Info</div>
              <div className="meta-row"><span className="meta-label">Creator</span><span className="meta-val">{model.creator_name || '—'}</span></div>
              {model.franchise && <div className="meta-row"><span className="meta-label">Franchise</span><span className="meta-val">{model.franchise}</span></div>}
              {model.team && <div className="meta-row"><span className="meta-label">Team</span><span className="meta-val">{model.team}</span></div>}
              <div className="meta-row"><span className="meta-label">Files</span><span className="meta-val">{model.file_count}</span></div>
              <div className="meta-row"><span className="meta-label">Has STL</span><span className="meta-val">{model.has_stl ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Chitubox</span><span className="meta-val">{model.has_chitubox ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Lychee</span><span className="meta-val">{model.has_lychee ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Plate/GCode</span><span className="meta-val">{model.has_plate ? '✓' : '✗'}</span></div>
            </div>

            <div className="detail-card">
              <div className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Print Status
                <button onClick={toggleQueue} disabled={queueLoading}
                  style={{ marginLeft: 'auto', background: inQueue ? 'rgba(193,127,58,0.15)' : 'none', border: `1px solid ${inQueue ? '#c17f3a' : 'var(--border)'}`, borderRadius: 4, color: inQueue ? '#c17f3a' : 'var(--text-faint)', padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                  {inQueue ? '🖨 In Queue' : '+ Queue'}
                </button>
              </div>
              <select className="status-select" value={status} onChange={e => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
              <StatusHistory modelId={model.id} key={model.id} />
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Tags</div>
              <div className="tags-input" onClick={e => e.currentTarget.querySelector('input').focus()}>
                {tags.map(t => (
                  <span key={t} className="tag-chip">{t}<button onClick={() => removeTag(t)}>×</button></span>
                ))}
                <input className="tag-text-input" value={tagInput} onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
                    if (e.key === 'Backspace' && !tagInput && tags.length) removeTag(tags[tags.length - 1]);
                  }}
                  placeholder={tags.length ? '' : 'Add tags...'} />
              </div>
              <TagSuggestions modelId={model.id} existingTags={tags} onAddTag={addTag} />
            </div>

            {collections && (
              <ModelCollections
                modelId={model.id}
                collections={collections}
                onCollectionsChange={onCollectionsChange}
              />
            )}

            <div className="detail-card">
              <div className="detail-card-title">Source URL</div>
              <input className="url-input" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://www.printables.com/model/..." />
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Notes</div>
              <textarea className="notes-textarea" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Print settings, modifications, paint schemes..." />
            </div>

            <button className="save-btn" onClick={handleSave} disabled={saving}>
              {saved ? '✓ SAVED' : saving ? 'SAVING...' : 'SAVE CHANGES'}
            </button>
          </div>

          {/* Right: Claude assistant */}
          {showAssistant && (
            <div style={{ height: 600, position: 'sticky', top: 20 }}>
              <ClaudeAssistant
                model={{ id: model.id, name: model.name, print_status: status, tags, notes, has_stl: model.has_stl, has_chitubox: model.has_chitubox, has_lychee: model.has_lychee, creator_name: model.creator_name, source_url: sourceUrl }}
                apiKey={apiKey}
                onApiKeyChange={handleApiKeyChange}
                onApplyTag={handleApplyTag}
                onApplyAllTags={handleApplyAllTags}
                onApplyStatus={handleApplyStatus}
                onApplyNotes={handleApplyNotes}
                onApplyUrl={(url) => setSourceUrl(url)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
