import React, { useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage, isAbortError } from '../api';
import { formatBytes } from '../thumbs';

/**
 * "Render preview from model": lists the card's mesh files (STL/OBJ/3MF, loose
 * or inside zips) and asks the backend to draw a preview picture from one.
 * "Automatic" lets the server pick (parts of one model together, or the
 * largest mesh that is not a support or test file).
 */
export default function MeshRenderPicker({ modelId, onRendered, onClose }) {
  const [files, setFiles] = useState(null); // null while loading
  const [loadError, setLoadError] = useState('');
  const [file, setFile] = useState('');
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    apiGet(`/api/models/${modelId}/meshes`, { signal: ctl?.signal })
      .then(d => setFiles((d && Array.isArray(d.files)) ? d.files : []))
      .catch(e => { if (!isAbortError(e)) { setFiles([]); setLoadError(errorMessage(e)); } });
    return () => { if (ctl) ctl.abort(); };
  }, [modelId]);

  const render = async () => {
    setRendering(true);
    setError('');
    try {
      const r = await apiSend(`/api/models/${modelId}/thumbnail/render`, 'POST', file ? { file } : {});
      if (r && r.ok === false) throw new Error(r.error || 'Render failed');
      if (onRendered) onRendered(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRendering(false);
    }
  };

  const selectId = `mesh-pick-${modelId}`;
  const noMeshes = files && files.length === 0;

  return (
    <div className="mesh-render-picker" aria-busy={rendering}>
      {files === null ? (
        <div className="modal-hint" role="status">Looking for model files…</div>
      ) : (
        <>
          <label htmlFor={selectId} className="mesh-render-label">Model file</label>
          <select id={selectId} className="gallery-select mesh-render-select" value={file}
            onChange={e => setFile(e.target.value)} disabled={rendering || noMeshes}>
            <option value="">Automatic (best match)</option>
            {files.map(f => (
              <option key={f.path} value={f.path}>
                {f.label || f.path}{f.size ? ` (${formatBytes(f.size)})` : ''}
              </option>
            ))}
          </select>
          {noMeshes && !loadError && <div className="modal-hint">No STL, OBJ or 3MF files found for this card.</div>}
          {loadError && <div className="mesh-render-error" role="alert">Couldn't list model files: {loadError}</div>}
          <div className="modal-hint">Draws a 3/4 view picture of the mesh on the server. Large models can take a while.</div>
        </>
      )}
      {error && <div className="mesh-render-error" role="alert">Render failed: {error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn-cancel" onClick={onClose} disabled={rendering} style={{ flex: 1, padding: 7, fontSize: 12 }}>Cancel</button>
        <button className="btn-primary" onClick={render} disabled={rendering || files === null || noMeshes}
          style={{ flex: 1, padding: 7, fontSize: 12 }}>
          {rendering ? 'Rendering…' : 'Render preview'}
        </button>
      </div>
    </div>
  );
}
