import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

afterEach(cleanup);

describe('Modal accessibility', () => {
  it('moves focus into the dialog on open', () => {
    render(
      <Modal open onClose={() => {}} title="Peek">
        body
      </Modal>,
    );
    // The Close button is the first focusable control in the panel.
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
  });

  it('wraps Tab from the last focusable back to the first', () => {
    render(
      <Modal open onClose={() => {}} title="Peek" footer={<button>Save</button>}>
        body
      </Modal>,
    );
    const close = screen.getByLabelText('Close');
    const save = screen.getByText('Save');
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(
      <Modal open onClose={() => {}} title="Peek" footer={<button>Save</button>}>
        body
      </Modal>,
    );
    const close = screen.getByLabelText('Close');
    const save = screen.getByText('Save');
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <Modal open onClose={() => {}} title="Peek">
        body
      </Modal>,
    );
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <Modal open={false} onClose={() => {}} title="Peek">
        body
      </Modal>,
    );
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  it('focuses the panel itself when there are no focusable controls', () => {
    render(
      <Modal open onClose={() => {}} title="Peek">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    // The Close button is always present, so suppress it to exercise the
    // empty-panel fallback the way a read-only modal with no actions would.
    const close = screen.getByLabelText('Close');
    close.setAttribute('disabled', '');
    dialog.querySelector<HTMLElement>('[tabindex="-1"]')?.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog.querySelector('[tabindex="-1"]'));
  });

  it('labels the dialog via aria-labelledby pointing at the title', () => {
    render(
      <Modal open onClose={() => {}} title="Session Peek">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Session Peek');
  });

  it('still closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Peek">
        body
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets only the topmost of nested modals trap Escape', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(
      <>
        <Modal open onClose={onCloseOuter} title="Bead detail">
          outer
        </Modal>
        <Modal open onClose={onCloseInner} title="Live run">
          inner
        </Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    // The inner (last-opened) modal is topmost: it closes, the outer stays put.
    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it('traps Tab within the topmost of nested modals only', () => {
    render(
      <>
        <Modal open onClose={() => {}} title="Bead detail" footer={<button>OuterSave</button>}>
          outer
        </Modal>
        <Modal open onClose={() => {}} title="Live run" footer={<button>InnerSave</button>}>
          inner
        </Modal>
      </>,
    );
    const innerSave = screen.getByText('InnerSave');
    innerSave.focus();
    // Tab from the inner modal's last control wraps to the inner modal's first
    // control (its Close button), never escaping into the background modal.
    fireEvent.keyDown(document, { key: 'Tab' });
    const innerClose = screen.getAllByLabelText('Close')[1];
    expect(document.activeElement).toBe(innerClose);
  });

  it('marks the fallback focus target with a visible focus ring', () => {
    render(
      <Modal open onClose={() => {}} title="Peek">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const panel = dialog.querySelector<HTMLElement>('[tabindex="-1"]');
    expect(panel).not.toBeNull();
    // Focusable fallback target AND visibly indicated: the codebase focus-mark
    // idiom (DESIGN.md 2px maroon ring), not a bare focus:outline-none.
    expect(panel?.className).toContain('focus-mark');
    expect(panel?.className).not.toContain('outline-none');
  });

  it('preserves a descendant autoFocus instead of moving focus to the first focusable', () => {
    render(
      <Modal open onClose={() => {}} title="New message">
        <input aria-label="To" autoFocus />
      </Modal>,
    );
    // The Close button is the first focusable in DOM order, but a descendant
    // claimed focus deliberately (as ComposeModal does for "To"), so it wins.
    expect(document.activeElement).toBe(screen.getByLabelText('To'));
  });
});
