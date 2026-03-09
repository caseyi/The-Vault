import React, { useEffect, useRef } from 'react';

const LEVEL_STYLES = {
  info:    { color: '#8899aa', prefix: '·' },
  scan:    { color: '#a0b4c8', prefix: '  ↳' },
  creator: { color: '#c17f3a', prefix: '▸' },
  add:     { color: '#4caf7d', prefix: '+' },
  update:  { color: '#5b9bd5', prefix: '↻' },
  skip:    { color: '#3a4a3a', prefix: '⟳' },
  zip:     { color: '#d4aa4c', prefix: '📦' },
  img:     { color: '#9b72cf', prefix: '🖼' },
  success: { color: '#4caf7d', prefix: '✓' },
  warn:    { color: '#d4aa4c', prefix: '⚠' },
  error:   { color: '#cf7272', prefix: '✗' },
};

function timestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

export default function TaskLog({ lines = [], running = false, height = 260, title = 'LOG' }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div style={{
      background: '#0a0a0c',
      border: '1px solid #2a2a35',
      borderRadius: 6,
      overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
    }}>
      {/* Terminal chrome */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 12px',
        background: '#111118',
        borderBottom: '1px solid #2a2a35',
      }}>
        <div style={{ display: 'flex', gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#cf7272', opacity: 0.7 }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#d4aa4c', opacity: 0.7 }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#4caf7d', opacity: 0.7 }} />
        </div>
        <span style={{ fontSize: 10, color: '#556', letterSpacing: 2, marginLeft: 6, textTransform: 'uppercase' }}>
          {title}
        </span>
        {running && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#c17f3a' }}>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#c17f3a', animation: 'blink 1s ease-in-out infinite' }} />
            RUNNING
          </span>
        )}
        {!running && lines.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#556' }}>{lines.length} lines</span>
        )}
      </div>

      {/* Log lines */}
      <div style={{
        height,
        overflowY: 'auto',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}>
        {lines.length === 0 && (
          <span style={{ color: '#334', fontSize: 11 }}>Waiting to start...</span>
        )}
        {lines.map((line, i) => {
          const style = LEVEL_STYLES[line.level] || LEVEL_STYLES.info;
          return (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.5, alignItems: 'baseline' }}>
              <span style={{ color: '#334', flexShrink: 0, fontSize: 10 }}>{timestamp(line.ts)}</span>
              <span style={{ color: style.color, flexShrink: 0, width: 14, textAlign: 'right' }}>{style.prefix}</span>
              <span style={{ color: style.color, wordBreak: 'break-all' }}>{line.msg}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <style>{`@keyframes blink { 0%,100%{opacity:0.3} 50%{opacity:1} }`}</style>
    </div>
  );
}
