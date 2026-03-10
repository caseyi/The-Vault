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
  try { return localStorage.getItem('vault_claude_key') || ''; } catch { return ''; }
}
function setStoredApiKey(key) {
  try { localStorage.setItem('vault_claude_key', key); } catch {}
}

export default function ModelDetail({ modelId, onBack, onSaved }) {
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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

  const handleApiKeyChange = (key) => {
    setApiKey(key);
    setStoredApiKey(key);
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
                    <img className="detail-main-img" src={images[activeImg]} alt={model.name} />
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
            {model.files && model.files.length > 0 && (
              <div className="detail-card">
                <div className="detail-card-title">
                  Files
                  <span style={{ marginLeft: 8, color: 'var(--text-faint)', fontWeight: 'normal' }}>
                    {model.file_count} total
                  </span>
                </div>
                <ReleaseFileList
                  files={model.files.filter(f => f.filetype !== 'image')}
                  onView3D={f => setViewingStl(viewingStl?.id === f.id ? null : { id: f.id, filename: f.filename })}
                  viewingStlId={viewingStl?.id}
                />
              </div>
            )}
          </div>

          {/* Middle: metadata panel */}
          <div className="detail-panel">
            <div className="detail-card">
              <div className="detail-card-title">Info</div>
              <div className="meta-row"><span className="meta-label">Creator</span><span className="meta-val">{model.creator_name || '—'}</span></div>
              <div className="meta-row"><span className="meta-label">Files</span><span className="meta-val">{model.file_count}</span></div>
              <div className="meta-row"><span className="meta-label">Has STL</span><span className="meta-val">{model.has_stl ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Chitubox</span><span className="meta-val">{model.has_chitubox ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Lychee</span><span className="meta-val">{model.has_lychee ? '✓' : '✗'}</span></div>
              <div className="meta-row"><span className="meta-label">Plate/GCode</span><span className="meta-val">{model.has_plate ? '✓' : '✗'}</span></div>
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Print Status</div>
              <select className="status-select" value={status} onChange={e => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
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
            </div>

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
                model={{ id: model.id, name: model.name, print_status: status, tags, notes, has_stl: model.has_stl, has_chitubox: model.has_chitubox, has_lychee: model.has_lychee, creator_name: model.creator_name }}
                apiKey={apiKey}
                onApiKeyChange={handleApiKeyChange}
                onApplyTag={handleApplyTag}
                onApplyAllTags={handleApplyAllTags}
                onApplyStatus={handleApplyStatus}
                onApplyNotes={handleApplyNotes}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
