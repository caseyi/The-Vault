import React, { useEffect, useRef } from 'react';

// Terminal-style log viewer for SSE task output. Colors come from CSS
// variables (see .tasklog in App.css) so it follows the light/dark theme.

const LEVEL_PREFIX = {
  info: '·', scan: '  ↳', creator: '▸', add: '+', update: '↻', skip: '⟳',
  zip: '📦', img: '🖼', success: '✓', warn: '⚠', error: '✗',
};

export const MAX_LOG_LINES = 500;

function timestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default function TaskLog({ lines = [], running = false, height = 260, title = 'LOG', maxLines = MAX_LOG_LINES }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true); // follow the tail unless the user scrolled up

  const hiddenCount = Math.max(0, lines.length - maxLines);
  const visible = hiddenCount ? lines.slice(hiddenCount) : lines;

  // Scroll only the log container (never scrollIntoView, which also scrolls the
  // surrounding modal and hides its title / folder picker).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="tasklog">
      <div className="tasklog-chrome">
        <div className="tasklog-dots" aria-hidden="true">
          <span className="tasklog-dot red" /><span className="tasklog-dot yellow" /><span className="tasklog-dot green" />
        </div>
        <span className="tasklog-title">{title}</span>
        {running && (
          <span className="tasklog-running">
            <span className="tasklog-blink" aria-hidden="true" />
            RUNNING
          </span>
        )}
        {!running && lines.length > 0 && (
          <span className="tasklog-count">{lines.length} lines</span>
        )}
      </div>

      <div ref={scrollRef} className="tasklog-body" style={{ height }} onScroll={onScroll}
        role="log" aria-live="polite" aria-label={title} data-testid="tasklog-body">
        {lines.length === 0 && (
          <span className="tasklog-empty">Waiting to start...</span>
        )}
        {hiddenCount > 0 && (
          <div className="tasklog-hidden-note">{hiddenCount.toLocaleString()} earlier line{hiddenCount === 1 ? '' : 's'} hidden</div>
        )}
        {visible.map((line, i) => {
          const level = LEVEL_PREFIX[line.level] ? line.level : 'info';
          return (
            <div key={hiddenCount + i} className={`tasklog-line lvl-${level}`}>
              <span className="tasklog-ts">{timestamp(line.ts)}</span>
              <span className="tasklog-prefix">{LEVEL_PREFIX[level]}</span>
              <span className="tasklog-msg">{line.msg}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
