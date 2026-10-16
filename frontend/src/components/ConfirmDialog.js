import React, { useCallback, useRef, useState } from 'react';
import Modal, { useUniqueId } from './Modal';

// Reusable confirmation dialog (replaces window.confirm). Shows a title, a
// message (with counts), and Cancel / Confirm buttons. `onConfirm` may return a
// promise; the dialog shows a busy state until it settles.
export default function ConfirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const titleId = useUniqueId('confirm-title');
  const msgId = useUniqueId('confirm-msg');
  const cancelRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try { await onConfirm?.(); } finally { setBusy(false); }
  };

  return (
    <Modal onClose={busy ? undefined : onCancel} labelledBy={titleId} describedBy={msgId}
      overlayClassName="modal-overlay confirm-overlay" className="modal confirm-dialog"
      initialFocusRef={cancelRef} closeOnEscape={!busy}>
      <div id={titleId} className="confirm-title">{title}</div>
      <div id={msgId} className="confirm-message">{message}</div>
      <div className="modal-actions">
        <button ref={cancelRef} className="btn-cancel" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button className={`btn-primary ${danger ? 'btn-danger' : ''}`} onClick={confirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Hook form: `const [confirmUi, askConfirm] = useConfirm();` then
 * `if (await askConfirm({ title, message, confirmLabel })) { ... }` and render
 * `{confirmUi}` somewhere in the component.
 */
export function useConfirm() {
  const [opts, setOpts] = useState(null);
  const resolver = useRef(null);

  const ask = useCallback((o) => new Promise(resolve => {
    resolver.current = resolve;
    setOpts(o);
  }), []);

  const finish = (val) => {
    const r = resolver.current;
    resolver.current = null;
    setOpts(null);
    if (r) r(val);
  };

  const ui = opts ? (
    <ConfirmDialog {...opts} onConfirm={() => finish(true)} onCancel={() => finish(false)} />
  ) : null;

  return [ui, ask];
}
