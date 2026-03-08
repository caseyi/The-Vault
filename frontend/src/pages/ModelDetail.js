import React, { useState, useEffect } from 'react';

const STATUS_OPTIONS = ['unprinted', 'sliced', 'printing', 'printed', 'painted', 'failed'];

const SOURCE_LABELS = {
  printables: 'Printables',
  thingiverse: 'Thingiverse',
  myminifactory: 'MyMiniFactory',
  patreon: 'Patreon',
  gumroad: 'Gumroad',
  cults3d: 'Cults3D'
};

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function ModelDetail({ modelId, onBack, onSaved }) {
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable fields
  const [status, setStatus] = useState('unprinted');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [activeImg, setActiveImg] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/models/${modelId}`)
      .then(r => r.json())
      .then(m => {
        setModel(m);
        setStatus(m.print_status || 'unprinted');
        setTags(m.tags || []);
        setNotes(m.notes || '');
        setSourceUrl(m.source_url || '');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [modelId]);

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

  const addTag = (val) => {
    const t = val.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };

  const removeTag = (t) => setTags(tags.filter(x => x !== t));

  if (loading) return <div className="loading"><div className="spinner" /> Loading...</div>;
  if (!model) return <div className="loading">Model not found</div>;

  const images = model.images || [];
  const stlFiles = (model.files || []).filter(f => f.filetype === 'stl');
  const slicerFiles = (model.files || []).filter(f => f.filetype === 'slicer');
  const zipFiles = (model.files || []).filter(f => f.filetype === 'zip');
  const otherFiles = (model.files || []).filter(f => !['stl','slicer','zip','image'].includes(f.filetype));

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
      </div>

      <div className="detail-scroll">
        <div className="detail-grid">
          {/* Left: images */}
          <div>
            <div className="detail-images">
              {images.length > 0 ? (
                <>
                  <img className="detail-main-img" src={images[activeImg]} alt={model.name} />
                  {images.length > 1 && (
                    <div className="detail-thumbs">
                      {images.map((img, i) => (
                        <img
                          key={i}
                          className={`detail-thumb ${activeImg === i ? 'active' : ''}`}
                          src={img}
                          alt=""
                          onClick={() => setActiveImg(i)}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="detail-no-img">🧩</div>
              )}
            </div>

            {/* Files */}
            {stlFiles.length > 0 && (
              <div className="detail-card" style={{ marginTop: 16 }}>
                <div className="detail-card-title">STL / 3D Files ({stlFiles.length})</div>
                <div className="file-list">
                  {stlFiles.map(f => (
                    <div key={f.id} className="file-item">
                      <span className="ftype stl" style={{ background: 'rgba(76,175,125,0.15)', color: 'var(--green)' }}>STL</span>
                      <span className="fname">{f.filename}</span>
                      <span className="fsize">{formatBytes(f.filesize)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {slicerFiles.length > 0 && (
              <div className="detail-card" style={{ marginTop: 16 }}>
                <div className="detail-card-title">Slicer Files ({slicerFiles.length})</div>
                <div className="file-list">
                  {slicerFiles.map(f => (
                    <div key={f.id} className="file-item">
                      <span className="ftype" style={{ background: 'rgba(91,155,213,0.15)', color: 'var(--blue)' }}>SLC</span>
                      <span className="fname">{f.filename}</span>
                      <span className="fsize">{formatBytes(f.filesize)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {zipFiles.length > 0 && (
              <div className="detail-card" style={{ marginTop: 16 }}>
                <div className="detail-card-title">ZIP Archives ({zipFiles.length})</div>
                <div className="file-list">
                  {zipFiles.map(f => (
                    <div key={f.id} className="file-item">
                      <span className="ftype" style={{ background: 'rgba(212,170,76,0.15)', color: 'var(--yellow)' }}>ZIP</span>
                      <span className="fname">{f.filename}</span>
                      <span className="fsize">{formatBytes(f.filesize)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: panel */}
          <div className="detail-panel">
            <div className="detail-card">
              <div className="detail-card-title">Info</div>
              <div className="meta-row">
                <span className="meta-label">Creator</span>
                <span className="meta-val">{model.creator_name || '—'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Files</span>
                <span className="meta-val">{model.file_count}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Has STL</span>
                <span className="meta-val">{model.has_stl ? '✓' : '✗'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Chitubox</span>
                <span className="meta-val">{model.has_chitubox ? '✓' : '✗'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Lychee</span>
                <span className="meta-val">{model.has_lychee ? '✓' : '✗'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">Plate/GCode</span>
                <span className="meta-val">{model.has_plate ? '✓' : '✗'}</span>
              </div>
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Print Status</div>
              <select
                className="status-select"
                value={status}
                onChange={e => setStatus(e.target.value)}
              >
                {STATUS_OPTIONS.map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Tags</div>
              <div className="tags-input" onClick={e => e.currentTarget.querySelector('input').focus()}>
                {tags.map(t => (
                  <span key={t} className="tag-chip">
                    {t}
                    <button onClick={() => removeTag(t)}>×</button>
                  </span>
                ))}
                <input
                  className="tag-text-input"
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
                    if (e.key === 'Backspace' && !tagInput && tags.length) removeTag(tags[tags.length - 1]);
                  }}
                  placeholder={tags.length ? '' : 'Add tags...'}
                />
              </div>
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Source URL</div>
              <input
                className="url-input"
                value={sourceUrl}
                onChange={e => setSourceUrl(e.target.value)}
                placeholder="https://www.printables.com/model/..."
              />
            </div>

            <div className="detail-card">
              <div className="detail-card-title">Notes</div>
              <textarea
                className="notes-textarea"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Print settings, modifications, paint schemes..."
              />
            </div>

            <button className="save-btn" onClick={handleSave} disabled={saving}>
              {saved ? '✓ SAVED' : saving ? 'SAVING...' : 'SAVE CHANGES'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
