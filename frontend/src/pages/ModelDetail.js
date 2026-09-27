import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import ZipImagePicker from '../components/ZipImagePicker';
import ClaudeAssistant from '../components/ClaudeAssistant';
import TaskLog from '../components/TaskLog';
import ReleaseFileList from '../components/ReleaseFileList';
import RenderHintPanel from '../components/RenderHintPanel';
import Modal from '../components/Modal';
import { useNotify } from '../components/Notices';
import { apiSend, errorMessage } from '../api';

// three.js is large; load the 3D viewer only when someone opens it.
const StlViewer = React.lazy(() => import('../components/StlViewer'));

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];
const SOURCE_LABELS = {
  printables: 'Printables', thingiverse: 'Thingiverse',
  myminifactory: 'MyMiniFactory', patreon: 'Patreon',
  gumroad: 'Gumroad', cults3d: 'Cults3D'
};
const PRINTABLE_FILE_TYPES = new Set(['stl', 'slicer', 'zip']);
export const AUTOSAVE_DELAY = 800;

// Persist API key in localStorage
function getStoredApiKey() {
  try { return localStorage.getItem('claude_api_key') || ''; } catch { return ''; }
}
function setStoredApiKey(key) {
  try { localStorage.setItem('claude_api_key', key); } catch {}
}

function StatusHistory({ modelId, refreshKey }) {
  const [log, setLog] = useState([]);
  useEffect(() => {
    fetch(`/api/models/${modelId}/status-log`)
      .then(r => r.json())
      .then(d => setLog(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [modelId, refreshKey]);

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
            <span className={`status-text-${entry.from_status || 'unprinted'}`} style={{ fontSize: 10 }}>
              {entry.from_status || '?'}
            </span>
            <span style={{ color: 'var(--text-faint)', fontSize: 9 }}>→</span>
            <span className={`status-text-${entry.to_status}`} style={{ fontSize: 10, fontWeight: 600 }}>
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
      .then(r => r.json()).then(d => setSuggestions(Array.isArray(d) ? d : [])).catch(() => {});
  }, [modelId]);
  if (!suggestions.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: 1, marginBottom: 4 }}>SUGGESTED</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {suggestions.filter(s => !existingTags.includes(s.tag)).slice(0, 8).map(s => (
          <button key={s.tag} onClick={() => onAddTag(s.tag)} className="tag-suggestion"
            aria-label={`Add suggested tag ${s.tag}`}>
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
  const notify = useNotify();

  useEffect(() => {
    fetch(`/api/models/${modelId}/collections`)
      .then(r => r.json()).then(d => setModelCols(Array.isArray(d) ? d : [])).catch(() => {});
  }, [modelId]);

  const addToCollection = async (colId) => {
    setAdding(true);
    try {
      await apiSend(`/api/collections/${colId}/models`, 'POST', { modelIds: [modelId] });
      const updated = await fetch(`/api/models/${modelId}/collections`).then(r => r.json());
      setModelCols(updated); setShowAdd(false);
      if (onCollectionsChange) onCollectionsChange();
    } catch (e) { notify(`Couldn't add to collection: ${errorMessage(e)}`); }
    setAdding(false);
  };

  const removeFromCollection = async (colId) => {
    try {
      await apiSend(`/api/collections/${colId}/models/${modelId}`, 'DELETE');
      setModelCols(c => c.filter(x => x.id !== colId));
      if (onCollectionsChange) onCollectionsChange();
    } catch (e) { notify(`Couldn't remove from collection: ${errorMessage(e)}`); }
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
            <button onClick={() => removeFromCollection(c.id)} aria-label={`Remove from collection ${c.name}`}
              style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 10, padding: 0, marginLeft: 2 }}>×</button>
          </span>
        ))}
        {available.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowAdd(s => !s)} aria-expanded={showAdd}
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

/**
 * Autosave for the detail page. `queue(fields)` merges edits into a pending
 * PATCH; text edits are debounced (AUTOSAVE_DELAY), discrete changes (status,
 * tags) pass `{ immediate: true }`. Saves run one at a time; a failed save
 * keeps its fields pending so "retry" (or the next edit) re-sends them. Any
 * pending edits are flushed on unmount / page hide with a keepalive request.
 */
function useAutosave(modelId, onSaved) {
  const notify = useNotify();
  const [state, setState] = useState('idle'); // idle | pending | saving | saved | error
  const pendingRef = useRef({});
  const timerRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const idRef = useRef(modelId);
  idRef.current = modelId;

  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const fields = pendingRef.current;
    if (!Object.keys(fields).length) return chainRef.current;
    pendingRef.current = {};
    const id = idRef.current;
    if (mountedRef.current) setState('saving');
    chainRef.current = chainRef.current.then(async () => {
      try {
        await apiSend(`/api/models/${id}`, 'PATCH', fields);
        if (onSavedRef.current) onSavedRef.current(fields);
        if (!mountedRef.current) return;
        if (Object.keys(pendingRef.current).length || timerRef.current) return; // more edits queued
        setState('saved');
      } catch (e) {
        if (id === idRef.current) pendingRef.current = { ...fields, ...pendingRef.current }; // newer edits win
        if (mountedRef.current) {
          setState('error');
          notify(`Couldn't save changes: ${errorMessage(e)}`);
        }
      }
    });
    return chainRef.current;
  }, [notify]);

  const queue = useCallback((fields, { immediate = false } = {}) => {
    pendingRef.current = { ...pendingRef.current, ...fields };
    if (immediate) return flush();
    setState('pending');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, AUTOSAVE_DELAY);
    return undefined;
  }, [flush]);

  // Flush anything pending when leaving this model (unmount or modelId change)
  // or when the tab is closed/hidden.
  useEffect(() => {
    mountedRef.current = true;
    const sendNow = () => {
      const fields = pendingRef.current;
      if (!Object.keys(fields).length) return;
      pendingRef.current = {};
      clearTimeout(timerRef.current);
      timerRef.current = null;
      apiSend(`/api/models/${modelId}`, 'PATCH', fields, { keepalive: true })
        .then(() => { if (onSavedRef.current) onSavedRef.current(fields); })
        .catch(() => {});
    };
    window.addEventListener('pagehide', sendNow);
    return () => {
      window.removeEventListener('pagehide', sendNow);
      mountedRef.current = false;
      sendNow();
    };
  }, [modelId]);

  return { state, queue, flush };
}

function SaveIndicator({ state, onRetry }) {
  if (state === 'idle') return <span className="save-indicator" aria-live="polite" />;
  if (state === 'error') {
    return (
      <span className="save-indicator save-error" aria-live="assertive">
        Save failed – <button className="link-btn" onClick={onRetry}>retry</button>
      </span>
    );
  }
  const text = state === 'saved' ? '✓ Saved' : 'Saving…';
  return <span className={`save-indicator save-${state}`} aria-live="polite">{text}</span>;
}

export default function ModelDetail({ modelId, onBack, onSaved, onQueueChange, collections, onCollectionsChange }) {
  const notify = useNotify();
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
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

  const [name, setName] = useState('');
  const [status, setStatus] = useState('unprinted');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [activeImg, setActiveImg] = useState(0);
  const [printMode, setPrintMode] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

  const autosave = useAutosave(modelId, (fields) => {
    if (fields.print_status !== undefined) setHistoryKey(k => k + 1);
    if (onSaved) onSaved();
  });
  const { queue, flush } = autosave;

  // Arrow-key navigation for the fullscreen image lightbox (Escape is handled by Modal)
  useEffect(() => {
    if (!zoomOpen) return undefined;
    const onKey = (e) => {
      const imgs = (model?.images) || [];
      if (e.key === 'ArrowRight') setActiveImg(i => (i + 1) % Math.max(imgs.length, 1));
      else if (e.key === 'ArrowLeft') setActiveImg(i => (i - 1 + imgs.length) % Math.max(imgs.length, 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomOpen, model]);

  const handleApiKeyChange = (key) => {
    setApiKey(key);
    setStoredApiKey(key);
  };

  const changeStatus = (s) => {
    setStatus(s);
    queue({ print_status: s }, { immediate: true });
  };

  const handleTogglePrinted = async (file) => {
    try {
      const res = await fetch(`/api/files/${file.id}/printed`, { method: 'PATCH' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { printed_at } = await res.json();
      const updatedFiles = model.files.map(f => f.id === file.id ? { ...f, printed_at } : f);
      setModel(m => ({ ...m, files: updatedFiles }));
      // Auto-advance print status based on printable files
      const printable = updatedFiles.filter(f => PRINTABLE_FILE_TYPES.has(f.filetype));
      const doneCnt = printable.filter(f => f.printed_at).length;
      if (printable.length > 0) {
        const next = doneCnt === 0 ? 'unprinted' : doneCnt < printable.length ? 'printing' : 'printed';
        if (next !== status) changeStatus(next);
      }
    } catch (e) {
      notify(`Couldn't update the file: ${errorMessage(e)}`);
    }
  };

  const loadModel = () => {
    setLoading(true);
    fetch(`/api/models/${modelId}`)
      .then(r => r.json())
      .then(m => {
        setModel(m);
        if (m) {
          setName(m.name || '');
          setStatus(m.print_status || 'unprinted');
          setTags(m.tags || []);
          setNotes(m.notes || '');
          setSourceUrl(m.source_url || '');
          setScrapeUrl(m.source_url || '');
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
    // Check queue status
    fetch('/api/queue').then(r => r.json())
      .then(q => setInQueue(Array.isArray(q) && q.some(i => i.model_id === modelId)))
      .catch(() => {});
  };

  const toggleQueue = async () => {
    setQueueLoading(true);
    try {
      if (inQueue) {
        await apiSend(`/api/queue/${modelId}`, 'DELETE');
        setInQueue(false);
      } else {
        await apiSend('/api/queue', 'POST', { modelId });
        setInQueue(true);
      }
      if (onQueueChange) onQueueChange();
    } catch (e) { notify(`Print queue: ${errorMessage(e)}`); }
    setQueueLoading(false);
  };

  useEffect(() => { loadModel(); }, [modelId]); // eslint-disable-line

  useEffect(() => {
    if (!model || model.source_url) return;
    fetch(`/api/models/${modelId}/detect-url`)
      .then(r => r.json())
      .then(data => { if (data && data.url) setScrapeUrl(data.url); })
      .catch(() => {});
  }, [model, modelId]);

  useEffect(() => () => scrapeEsRef.current?.close(), []);

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

  const setAndSaveTags = (next) => {
    setTags(next);
    queue({ tags: next }, { immediate: true });
  };
  const addTag = (val) => {
    const t = String(val || '').trim().toLowerCase();
    const cur = tagsRef.current;
    if (t && !cur.includes(t)) setAndSaveTags([...cur, t]);
    setTagInput('');
  };
  const removeTag = (t) => setAndSaveTags(tagsRef.current.filter(x => x !== t));

  const handleApplyAllTags = (newTags) => {
    const merged = [...new Set([...tagsRef.current, ...newTags])];
    if (merged.length !== tagsRef.current.length) setAndSaveTags(merged);
  };
  const changeNotes = (n, opts) => { setNotes(n); queue({ notes: n }, opts); };
  const changeSourceUrl = (u, opts) => { setSourceUrl(u); queue({ source_url: u }, opts); };
  const changeName = (n) => {
    setName(n);
    if (n.trim()) queue({ name: n.trim() });
  };

  const goBack = () => { flush(); onBack(); };

  if (loading) return <div className="loading"><div className="spinner" /> Loading...</div>;
  if (!model) return <div className="loading">Model not found</div>;

  const images = model.images || [];
  const isHidden = model.hidden === 1 || model.hidden === true;

  return (
    <div className="detail-page">
      <div className="detail-header">
        <button className="back-btn" onClick={goBack}>← Back</button>
        <div className="detail-title-wrap">
          <input className="detail-name detail-name-input" value={name} aria-label="Model name"
            onChange={e => changeName(e.target.value)}
            onBlur={() => { if (!name.trim()) setName(model.name); flush(); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            title="Click to rename" spellCheck={false} />
          <SaveIndicator state={autosave.state} onRetry={flush} />
        </div>
        {model.source_site && (
          <span className={`source-badge source-${model.source_site}`}>
            {SOURCE_LABELS[model.source_site] || model.source_site}
          </span>
        )}
        <div className="detail-header-actions">
          <button onClick={async () => {
              const newHidden = !isHidden;
              try {
                await apiSend(`/api/models/${model.id}`, 'PATCH', { hidden: newHidden });
                setModel(m => ({ ...m, hidden: newHidden ? 1 : 0 }));
                if (onSaved) onSaved();
              } catch (e) { notify(`Couldn't ${newHidden ? 'hide' : 'unhide'} model: ${errorMessage(e)}`); }
            }}
            className={`chip-btn ${isHidden ? 'active' : ''}`}>
            {isHidden ? '👁 Unhide' : '🙈 Hide'}
          </button>
          <button onClick={() => setShowAssistant(s => !s)} aria-expanded={showAssistant}
            className={`chip-btn ${showAssistant ? 'active' : ''}`}>
            ✦ {showAssistant ? 'Hide' : 'Ask Claude'}
          </button>
        </div>
      </div>

      <div className="detail-scroll">
        {/* Main layout — expands to 3 cols when assistant is open, 1 col on phones */}
        <div className={`detail-layout ${showAssistant ? 'with-assistant' : ''}`}>

          {/* Left: images + files */}
          <div className="detail-main-col">
            {viewingStl ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>3D VIEW — {viewingStl.filename}</span>
                  <button onClick={() => setViewingStl(null)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', padding: '3px 8px', cursor: 'pointer', fontSize: 11, flexShrink: 0 }}>✕ Close viewer</button>
                </div>
                <Suspense fallback={<div className="stl-viewer"><div className="stl-viewer-overlay"><div className="spinner" /> Loading 3D viewer…</div></div>}>
                  <StlViewer fileId={viewingStl.id} filename={viewingStl.filename} />
                </Suspense>
              </div>
            ) : (
              <div className="detail-images" style={{ marginBottom: 16 }}>
                {images.length > 0 ? (
                  <>
                    <button className="detail-main-img-btn" onClick={() => setZoomOpen(true)} aria-label="View image full size">
                      <img className="detail-main-img" src={images[activeImg]} alt={name || model.name}
                        style={{ cursor: 'zoom-in' }} title="Click to view full size" />
                    </button>
                    {zoomOpen && (
                      <Modal onClose={() => setZoomOpen(false)} label={`Image ${activeImg + 1} of ${images.length}: ${name || model.name}`}
                        overlayClassName="lightbox-overlay" className="lightbox-dialog">
                        <img src={images[activeImg]} alt={name || model.name}
                          style={{ maxWidth: '95vw', maxHeight: '92vh', objectFit: 'contain', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
                        <button onClick={() => setZoomOpen(false)} title="Close (Esc)" aria-label="Close image viewer"
                          className="lightbox-btn lightbox-close">✕</button>
                        {images.length > 1 && (
                          <>
                            <button onClick={() => setActiveImg(i => (i - 1 + images.length) % images.length)} title="Previous (←)" aria-label="Previous image"
                              className="lightbox-btn lightbox-nav prev">‹</button>
                            <button onClick={() => setActiveImg(i => (i + 1) % images.length)} title="Next (→)" aria-label="Next image"
                              className="lightbox-btn lightbox-nav next">›</button>
                            <div className="lightbox-counter">{activeImg + 1} / {images.length}</div>
                          </>
                        )}
                      </Modal>
                    )}
                    {images.length > 1 && (
                      <div className="detail-thumbs">
                        {images.map((img, i) => {
                          const isThumb = model.thumbnail_path === img;
                          return (
                            <div key={i} style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
                              <button className="thumb-btn" onClick={() => setActiveImg(i)} aria-label={`Show image ${i + 1}`} aria-pressed={activeImg === i}>
                                <img className={`detail-thumb ${activeImg === i ? 'active' : ''}`} src={img} alt="" />
                              </button>
                              <button
                                title={isThumb ? 'Current thumbnail' : 'Set as gallery thumbnail'}
                                aria-label={isThumb ? `Image ${i + 1} is the gallery thumbnail` : `Set image ${i + 1} as gallery thumbnail`}
                                aria-pressed={isThumb}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    await apiSend(`/api/models/${modelId}`, 'PATCH', { thumbnail_path: img });
                                    loadModel();
                                    if (onSaved) onSaved();
                                  } catch (err) { notify(`Couldn't set thumbnail: ${errorMessage(err)}`); }
                                }}
                                className={`thumb-star ${isThumb ? 'active' : ''}`}
                              >★</button>
                            </div>
                          );
                        })}
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => { setShowZipPicker(s => !s); setShowScrapeInput(false); setShowRenderHint(false); }}
                  aria-expanded={showZipPicker}
                  className={`tool-btn ${showZipPicker ? 'active' : ''}`} style={{ flex: 1 }}>
                  📦 Extract from ZIP
                </button>
                <button onClick={() => { setShowScrapeInput(s => !s); setShowZipPicker(false); setShowRenderHint(false); }}
                  aria-expanded={showScrapeInput}
                  className={`tool-btn ${showScrapeInput ? 'active' : ''}`} style={{ flex: 1 }}>
                  🌐 Fetch from site
                </button>
                <button onClick={() => { setShowRenderHint(s => !s); setShowZipPicker(false); setShowScrapeInput(false); }}
                  title="Set which ZIP to auto-extract renders from on next scan"
                  aria-label="Render ZIP settings" aria-expanded={showRenderHint}
                  className={`tool-btn ${showRenderHint ? 'active' : ''}`} style={{ fontSize: 14, padding: '7px 10px' }}>
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
                  <label htmlFor={`scrape-url-${modelId}`} style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>Printables, MyMiniFactory, or Thingiverse URL:</label>
                  <input id={`scrape-url-${modelId}`} className="url-input" value={scrapeUrl} onChange={e => setScrapeUrl(e.target.value)} placeholder="https://www.printables.com/model/..." style={{ marginBottom: 8 }} />
                  {scrapeError && (
                    <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8, padding: '6px 8px', background: 'rgba(207,114,114,0.1)', borderRadius: 4 }}>✗ {scrapeError}</div>
                  )}
                  {scrapeLog.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <TaskLog lines={scrapeLog} running={scraping} title="FETCH LOG" height={130} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setShowScrapeInput(false); setScrapeError(null); setScrapeLog([]); scrapeEsRef.current?.close(); }} className="btn-cancel" style={{ flex: 1, padding: 7, fontSize: 12 }}>Cancel</button>
                    <button onClick={handleScrape} disabled={scraping || !scrapeUrl} className="btn-primary"
                      style={{ flex: 2, padding: 7, fontSize: 13 }}>
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
                      <button onClick={() => setPrintMode(p => !p)} aria-pressed={printMode}
                        className={`chip-btn chip-btn-sm chip-green ${printMode ? 'active' : ''}`}>
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
                        <span style={{ fontSize: 11, color: printProgress === 1 ? 'var(--green-text)' : 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                          {Math.round(printProgress * 100)}%
                        </span>
                      </div>
                      <div style={{ height: 4, background: 'var(--bg4)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 2, transition: 'width 0.3s ease',
                          width: `${printProgress * 100}%`,
                          background: printProgress === 1 ? 'var(--green)' : 'var(--accent)',
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
                <label htmlFor={`status-${modelId}`}>Print Status</label>
                <button onClick={toggleQueue} disabled={queueLoading} aria-pressed={inQueue}
                  className={`chip-btn chip-btn-sm ${inQueue ? 'active' : ''}`} style={{ marginLeft: 'auto' }}>
                  {inQueue ? '🖨 In Queue' : '+ Queue'}
                </button>
              </div>
              <select id={`status-${modelId}`} className="status-select" value={status} onChange={e => changeStatus(e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
              <StatusHistory modelId={model.id} refreshKey={historyKey} />
            </div>

            <div className="detail-card">
              <div className="detail-card-title"><label htmlFor={`tag-input-${modelId}`}>Tags</label></div>
              <div className="tags-input" onClick={e => { const i = e.currentTarget.querySelector('input'); if (i && e.target === e.currentTarget) i.focus(); }}>
                {tags.map(t => (
                  <span key={t} className="tag-chip">{t}<button onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`}>×</button></span>
                ))}
                <input id={`tag-input-${modelId}`} className="tag-text-input" value={tagInput} onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
                    if (e.key === 'Backspace' && !tagInput && tags.length) removeTag(tags[tags.length - 1]);
                  }}
                  onBlur={() => { if (tagInput.trim()) addTag(tagInput); }}
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
              <div className="detail-card-title"><label htmlFor={`source-url-${modelId}`}>Source URL</label></div>
              <input id={`source-url-${modelId}`} className="url-input" value={sourceUrl}
                onChange={e => changeSourceUrl(e.target.value)} onBlur={flush}
                placeholder="https://www.printables.com/model/..." />
            </div>

            <div className="detail-card">
              <div className="detail-card-title"><label htmlFor={`notes-${modelId}`}>Notes</label></div>
              <textarea id={`notes-${modelId}`} className="notes-textarea" value={notes}
                onChange={e => changeNotes(e.target.value)} onBlur={flush}
                placeholder="Print settings, modifications, paint schemes..." />
            </div>

            <div className="autosave-hint">Changes save automatically.</div>
          </div>

          {/* Right: Claude assistant */}
          {showAssistant && (
            <div className="detail-assistant">
              <ClaudeAssistant
                model={{ id: model.id, name: name || model.name, print_status: status, tags, notes, has_stl: model.has_stl, has_chitubox: model.has_chitubox, has_lychee: model.has_lychee, creator_name: model.creator_name, source_url: sourceUrl }}
                apiKey={apiKey}
                onApiKeyChange={handleApiKeyChange}
                onApplyTag={addTag}
                onApplyAllTags={handleApplyAllTags}
                onApplyStatus={changeStatus}
                onApplyNotes={(n) => changeNotes(n, { immediate: true })}
                onApplyUrl={(url) => changeSourceUrl(url, { immediate: true })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
