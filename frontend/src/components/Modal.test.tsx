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
});
