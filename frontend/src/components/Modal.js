import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Shared accessible modal shell: role="dialog" + aria-modal, labelled by the
// caller's title element, Escape closes, Tab is trapped inside, and focus goes
// back to whatever opened it. Only the top-most open modal reacts to keys, so a
// ConfirmDialog stacked over the Organize window doesn't close both at once.

const stack = [];
let seq = 0;

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

const IS_JSDOM = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el =>
    !el.closest('[hidden],[inert]') && (IS_JSDOM || el.getClientRects().length > 0));
}

export default function Modal({
  onClose,
  labelledBy,
  label,
  describedBy,
  overlayClassName = 'modal-overlay',
  className = 'modal',
  style,
  overlayStyle,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  children,
  ...rest
}) {
  const dialogRef = useRef(null);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = ++seq;
  const downOnOverlay = useRef(false);
  // Keep the latest props in refs so the key handler (registered once) sees them
  const onCloseRef = useRef(onClose);
  const escRef = useRef(closeOnEscape);
  onCloseRef.current = onClose;
  escRef.current = closeOnEscape;

  useEffect(() => {
    const id = idRef.current;
    const opener = document.activeElement;
    stack.push(id);

    const dialog = dialogRef.current;
    if (dialog) {
      const wanted = initialFocusRef && initialFocusRef.current;
      if (wanted) wanted.focus();
      else if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    }

    const onKey = (e) => {
      // Top-most = most recently rendered (ids grow in render order, so a
      // child dialog mounted together with its parent still wins).
      if (Math.max(...stack) !== id) return;
      const dlg = dialogRef.current;
      if (!dlg) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (escRef.current && onCloseRef.current) {
          e.stopPropagation();
          e.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(dlg);
      if (items.length === 0) { e.preventDefault(); dlg.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = dlg.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first || active === dlg) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        e.preventDefault(); first.focus();
      }
    };
    // Capture phase so inner handlers can't swallow Tab/Escape before the trap sees them
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const idx = stack.lastIndexOf(id);
      if (idx !== -1) stack.splice(idx, 1);
      // Restore focus to the opener if it still exists and focus was inside us (or lost)
      const active = document.activeElement;
      const lost = !active || active === document.body || (dialog && dialog.contains(active)) || !document.contains(active);
      if (opener && typeof opener.focus === 'function' && document.contains(opener) && lost) {
        try { opener.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line
  }, []);

  const node = (
    <div
      className={overlayClassName}
      style={overlayStyle}
      onMouseDown={e => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (closeOnBackdrop && downOnOverlay.current && e.target === e.currentTarget && onClose) onClose();
        downOnOverlay.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`${className} modal-dialog`}
        style={style}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
  // Portal to <body> so a dialog opened from inside another dialog (or a
  // clipped/transformed container) always covers the viewport.
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}

let uid = 0;
/** Stable unique id for aria-labelledby wiring. */
export function useUniqueId(prefix = 'dlg') {
  const ref = useRef(null);
  if (ref.current === null) ref.current = `${prefix}-${++uid}`;
  return ref.current;
}
