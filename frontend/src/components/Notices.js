import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Lightweight app-wide notice/toast system. <NoticeProvider> renders a single
// stack in the bottom-right corner; any component calls useNotify()(msg, opts).
// Outside a provider (e.g. isolated component tests) notify is a no-op.

const NoticeContext = createContext(() => {});

export function useNotify() {
  return useContext(NoticeContext);
}

let nextId = 1;

export function NoticeProvider({ children }) {
  const [notices, setNotices] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setNotices(ns => ns.filter(n => n.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const notify = useCallback((message, opts = {}) => {
    const type = opts.type || 'error';
    const id = nextId++;
    setNotices(ns => {
      // Collapse identical messages that are already showing
      if (ns.some(n => n.message === message && n.type === type)) return ns;
      return [...ns.slice(-3), { id, message, type, action: opts.action }];
    });
    const ttl = opts.duration ?? (type === 'error' ? 8000 : 4000);
    if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    return id;
  }, [dismiss]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div className="notice-stack" role="region" aria-label="Notifications" aria-live="polite">
        {notices.map(n => (
          <div key={n.id} className={`notice notice-${n.type}`} role={n.type === 'error' ? 'alert' : 'status'}>
            <span className="notice-msg">{n.message}</span>
            {n.action && (
              <button className="notice-action" onClick={() => { n.action.onClick(); dismiss(n.id); }}>
                {n.action.label}
              </button>
            )}
            <button className="notice-close" aria-label="Dismiss notification" onClick={() => dismiss(n.id)}>✕</button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
