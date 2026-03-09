import React, { useState, useEffect, useRef } from 'react';
import TaskLog from './TaskLog';

/**
 * RenderHintPanel
 *
 * mode="creator"  → shows hint field + "Re-extract all models" button
 * mode="model"    → shows hint override field only (inherits creator hint)
 */
export default function RenderHintPanel({ mode = 'creator', creatorId, modelId, currentHint, creatorHint, onSaved, onClose }) {
  const [hint, setHint] = useState(currentHint || '');
  const [availableZips, setAvailableZips] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [log, setLog] = useState([]);
  const [done, setDone] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (mode === 'creator' && creatorId) {
      fetch(`/api/creators/${creatorId}/render-hint`)
        .then(r => r.json())
        .then(d => {
          setHint(d.render_zip_hint || '');
          setAvailableZips(d.available_zips || []);
        })
        .catch(() => {});
    }
  }, [mode, creatorId]);

  const handleSave = async () => {
    setSaving(true);
    const url = mode === 'creator'
      ? `/api/creators/${creatorId}/render-hint`
      : `/api/models/${modelId}/render-hint`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ render_zip_hint: hint || null }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    if (onSaved) onSaved(hint || null);
  };

  const handleReextract = () => {
    setExtracting(true);
    setLog([]);
    setDone(null);

    const es = new EventSource(`/api/creators/${creatorId}/reextract`);
    esRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'done') {
        setDone(data);
        setExtracting(false);
        es.close();
        if (onSaved) onSaved(hint || null);
      } else {
        setLog(l => [...l, data]);
      }
    };
    es.onerror = () => {
      setLog(l => [...l, { level: 'error', msg: 'Connection lost.', ts: new Date().toISOString() }]);
      setExtracting(false);
      es.close();
    };
  };

  useEffect(() => () => esRef.current?.close(), []);

  // Distinct ZIP names for the suggestion dropdown
  const suggestions = [...new Set(availableZips)].slice(0, 20);

  const placeholderExamples = 'e.g. renders.zip  or  *preview*  or  renders.zip, *photo*';

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border-bright)',
      borderRadius: 8, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', background: 'var(--bg3)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>📦</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, letterSpacing: 1, color: 'var(--accent)' }}>
            {mode === 'creator' ? 'RENDER ZIP — ALL MODELS' : 'RENDER ZIP OVERRIDE'}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
        )}
      </div>

      <div style={{ padding: 14 }}>
        {/* Explanation */}
        <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6, marginBottom: 12 }}>
          {mode === 'creator'
            ? 'Set a filename or wildcard pattern to identify which ZIP contains renders for every model in this creator\'s folder. Overrides the default keyword-based auto-detection.'
            : <>
                Set a ZIP filename to use for this model only.
                {creatorHint && <> Creator default: <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{creatorHint}</span></>}
              </>
          }
        </div>

        {/* Hint input */}
        <label style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 5 }}>
          ZIP Filename / Pattern
        </label>
        <input
          value={hint}
          onChange={e => setHint(e.target.value)}
          placeholder={placeholderExamples}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--bg3)', border: '1px solid var(--border)',
            borderRadius: 5, color: 'var(--text)', fontFamily: 'var(--font-mono)',
            fontSize: 12, padding: '7px 10px', outline: 'none',
          }}
          list="zip-suggestions"
        />
        {suggestions.length > 0 && (
          <datalist id="zip-suggestions">
            {suggestions.map(z => <option key={z} value={z} />)}
          </datalist>
        )}
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.5 }}>
          Supports exact names and <code style={{ color: 'var(--accent)' }}>*</code> wildcards. Comma-separate multiple patterns.
          Leave blank to use auto-detection by keyword.
        </div>

        {/* ZIP suggestions */}
        {suggestions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 6 }}>
              ZIP files found in this collection
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {suggestions.map(z => (
                <button key={z} onClick={() => setHint(z)}
                  style={{
                    padding: '3px 8px', background: hint === z ? 'rgba(193,127,58,0.15)' : 'var(--bg3)',
                    border: `1px solid ${hint === z ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 3, cursor: 'pointer', fontSize: 11,
                    color: hint === z ? 'var(--accent)' : 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                  {z}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Save button */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={handleSave} disabled={saving}
            style={{
              flex: 1, padding: '8px', background: 'var(--accent)', border: 'none',
              borderRadius: 5, color: '#0d0d0f', cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-display)', fontSize: 14, letterSpacing: 1,
              opacity: saving ? 0.6 : 1,
            }}>
            {saved ? '✓ SAVED' : saving ? 'SAVING…' : 'SAVE HINT'}
          </button>

          {mode === 'creator' && (
            <button onClick={handleReextract} disabled={extracting}
              style={{
                flex: 2, padding: '8px', background: 'var(--bg3)',
                border: '1px solid var(--border-bright)',
                borderRadius: 5, color: extracting ? 'var(--text-muted)' : 'var(--text)',
                cursor: extracting ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-display)', fontSize: 14, letterSpacing: 1,
                opacity: extracting ? 0.6 : 1,
              }}>
              {extracting ? 'Extracting…' : '↺ RE-EXTRACT ALL MODELS'}
            </button>
          )}
        </div>

        {/* Live log */}
        {(log.length > 0 || extracting) && (
          <div style={{ marginTop: 14 }}>
            <TaskLog lines={log} running={extracting} title="EXTRACT LOG" height={200} />
          </div>
        )}

        {/* Done summary */}
        {done && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 5,
            background: done.success ? 'rgba(76,175,125,0.08)' : 'rgba(207,114,114,0.08)',
            border: `1px solid ${done.success ? 'rgba(76,175,125,0.3)' : 'rgba(207,114,114,0.3)'}`,
            fontSize: 12, fontFamily: 'var(--font-mono)',
            color: done.success ? 'var(--green)' : 'var(--red)',
          }}>
            {done.success
              ? `✓ Done — ${done.updated} model(s) updated · ${done.skipped} skipped`
              : `✗ ${done.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
