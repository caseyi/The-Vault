import React, { useState, useEffect } from 'react';
import TaskLog from './TaskLog';

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function ZipImagePicker({ modelId, onImagesExtracted, onClose }) {
  const [zips, setZips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedZip, setSelectedZip] = useState(null);
  const [zipContents, setZipContents] = useState(null);
  const [loadingContents, setLoadingContents] = useState(false);
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/models/${modelId}/zips`)
      .then(r => r.json())
      .then(data => { setZips(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [modelId]);

  const loadZipContents = async (zip) => {
    setSelectedZip(zip);
    setZipContents(null);
    setSelectedImages(new Set());
    setLoadingContents(true);
    setError(null);
    try {
      const r = await fetch(`/api/files/${zip.id}/zip-contents`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setZipContents(data);
      // Auto-select all images
      setSelectedImages(new Set(data.images.map(i => i.name)));
    } catch (e) {
      setError(e.message);
    }
    setLoadingContents(false);
  };

  const toggleImage = (name) => {
    setSelectedImages(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const [extractLog, setExtractLog] = useState([]);

  const addLog = (level, msg) => setExtractLog(l => [...l, { level, msg, ts: new Date().toISOString() }]);

  const handleExtract = async () => {
    if (selectedImages.size === 0) return;
    setExtracting(true);
    setError(null);
    setExtractLog([]);
    addLog('info', `Extracting ${selectedImages.size} image(s) from ${selectedZip.filename}…`);
    try {
      const r = await fetch(`/api/files/${selectedZip.id}/extract-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedFiles: [...selectedImages] })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      addLog('success', `✓ Extracted ${data.extracted} image(s) — total gallery: ${data.total}`);
      setExtractResult(data);
      if (onImagesExtracted) onImagesExtracted(data);
    } catch (e) {
      addLog('error', `✗ ${e.message}`);
      setError(e.message);
    }
    setExtracting(false);
  };

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border-bright)',
      borderRadius: 8, overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg3)' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: 1, color: 'var(--accent)' }}>
          EXTRACT IMAGES FROM ZIP
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedZip ? '1fr 1fr' : '1fr', gap: 0, minHeight: 200 }}>
        {/* ZIP list */}
        <div style={{ padding: 14, borderRight: selectedZip ? '1px solid var(--border)' : 'none' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10 }}>
            ZIP Files ({zips.length})
          </div>

          {loading && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading...</div>}

          {!loading && zips.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
              No ZIP files found for this model.
            </div>
          )}

          {zips.map(z => (
            <button key={z.id} onClick={() => loadZipContents(z)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '8px 10px', marginBottom: 4,
                background: selectedZip?.id === z.id ? 'rgba(193,127,58,0.12)' : 'var(--bg3)',
                border: `1px solid ${selectedZip?.id === z.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 5, cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s'
              }}>
              <span style={{ fontSize: 18 }}>📦</span>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {z.filename}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                  {formatBytes(z.filesize)}
                </div>
              </div>
              <span style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>▶</span>
            </button>
          ))}
        </div>

        {/* Image contents */}
        {selectedZip && (
          <div style={{ padding: 14 }}>
            {loadingContents && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                <div className="spinner" /> Reading ZIP...
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--red)', fontSize: 12, padding: '8px 10px', background: 'rgba(207,114,114,0.1)', borderRadius: 4 }}>
                ✗ {error}
              </div>
            )}

            {extractResult && (
              <div style={{ color: 'var(--green)', fontSize: 12, padding: '10px', background: 'rgba(76,175,125,0.1)', borderRadius: 4, marginBottom: 10 }}>
                ✓ Extracted {extractResult.extracted} images successfully!
              </div>
            )}

            {zipContents && !loadingContents && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase' }}>
                    Images ({zipContents.images.length})
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setSelectedImages(new Set(zipContents.images.map(i => i.name)))}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>
                      All
                    </button>
                    <button onClick={() => setSelectedImages(new Set())}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
                      None
                    </button>
                  </div>
                </div>

                {zipContents.images.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic', marginBottom: 10 }}>
                    No images found in this ZIP. Try a different ZIP file.
                  </div>
                )}

                <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {zipContents.images.map(img => (
                    <label key={img.name}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px', borderRadius: 4, cursor: 'pointer',
                        background: selectedImages.has(img.name) ? 'rgba(193,127,58,0.08)' : 'var(--bg3)',
                        border: `1px solid ${selectedImages.has(img.name) ? 'rgba(193,127,58,0.3)' : 'var(--border)'}`,
                        transition: 'all 0.1s'
                      }}>
                      <input type="checkbox" checked={selectedImages.has(img.name)}
                        onChange={() => toggleImage(img.name)}
                        style={{ accentColor: 'var(--accent)', flexShrink: 0 }} />
                      <span style={{ fontSize: 14 }}>
                        {img.ext === '.png' ? '🖼' : img.ext === '.gif' ? '🎞' : '📷'}
                      </span>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {img.basename}
                        </div>
                        {img.name !== img.basename && (
                          <div style={{ fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {img.name}
                          </div>
                        )}
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
                        {formatBytes(img.size)}
                      </span>
                    </label>
                  ))}
                </div>

                {zipContents.images.length > 0 && (
                  <>
                    <button onClick={handleExtract} disabled={extracting || selectedImages.size === 0}
                      style={{
                        width: '100%', padding: '9px', background: 'var(--accent)',
                        border: 'none', borderRadius: 5, color: '#0d0d0f',
                        fontFamily: 'var(--font-display)', fontSize: 16, letterSpacing: 1,
                        cursor: extracting || selectedImages.size === 0 ? 'not-allowed' : 'pointer',
                        opacity: extracting || selectedImages.size === 0 ? 0.5 : 1,
                        marginBottom: 10,
                      }}>
                      {extracting ? 'Extracting...' : `EXTRACT ${selectedImages.size} IMAGE${selectedImages.size !== 1 ? 'S' : ''}`}
                    </button>
                    {extractLog.length > 0 && (
                      <TaskLog lines={extractLog} running={extracting} title="EXTRACT LOG" height={100} />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
