import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import Modal from './Modal';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';

function Harness({ onClose }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <Modal labelledBy="t" onClose={() => { onClose && onClose(); setOpen(false); }}>
          <h2 id="t">Dialog title</h2>
          <button>First</button>
          <button>Last</button>
        </Modal>
      )}
    </div>
  );
}

describe('Modal', () => {
  test('has dialog semantics and is labelled by its title', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open dialog'));
    const dialog = screen.getByRole('dialog', { name: 'Dialog title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('moves focus into the dialog, Escape closes it and focus returns to the opener', () => {
    const onClose = jest.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText('Open dialog');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test('traps Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Open dialog'));
    const last = screen.getByText('Last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByText('First')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('First'), { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  test('backdrop click closes, clicks inside do not', () => {
    const onClose = jest.fn();
    render(<Modal onClose={onClose} label="x"><button>Inside</button></Modal>);
    fireEvent.click(screen.getByText('Inside'));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = document.querySelector('.modal-overlay');
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('only the top-most modal reacts to Escape', () => {
    const outer = jest.fn();
    const inner = jest.fn();
    render(
      <Modal onClose={outer} label="outer">
        <Modal onClose={inner} label="inner"><button>Inner button</button></Modal>
      </Modal>
    );
    fireEvent.keyDown(screen.getByText('Inner button'), { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  test('shows the message and focuses Cancel; Escape cancels', () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    render(<ConfirmDialog title="Hide 3 models?" message="Files stay on disk; you can unhide them later."
      confirmLabel="Hide 3 models" onCancel={onCancel} onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog', { name: 'Hide 3 models?' })).toHaveTextContent('Files stay on disk');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('useConfirm resolves true on confirm, false on cancel, and restores focus', async () => {
    const results = [];
    function Asker() {
      const [ui, ask] = useConfirm();
      return (
        <>
          <button onClick={async () => results.push(await ask({ title: 'Merge creators?', message: 'Move 12 models', confirmLabel: 'Merge 12 models' }))}>
            Merge
          </button>
          {ui}
        </>
      );
    }
    render(<Asker />);
    const opener = screen.getByText('Merge');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Merge 12 models' }));
    await waitFor(() => expect(results).toEqual([true]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual([true, false]));
  });
});
