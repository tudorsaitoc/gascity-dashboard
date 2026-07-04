import { useEffect, useId, useRef, type ReactNode } from 'react';

// Controls that can hold keyboard focus inside the dialog. Used for the
// initial focus move and for the Tab/Shift+Tab wrap-around trap.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Stack of open Modal instances, most-recently-opened last. Every Modal binds a
// document-level Tab/Escape handler, so nested modals (bead detail -> live-run,
// bead detail -> close confirm) would otherwise all fire on one keypress. The
// handler consults this stack and no-ops unless it belongs to the topmost modal.
const modalStack: number[] = [];
let nextModalId = 0;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional caption next to the title. */
  caption?: ReactNode;
  children: ReactNode;
  /** Optional footer slot (e.g. action buttons). */
  footer?: ReactNode;
  /** When set, render the modal at the given max-width class instead of the default. */
  widthClass?: string;
}

// Modals are last-resort per DESIGN.md. When they appear (Session Peek
// is the only legitimate use here), they sit on a hairline-bounded
// panel, opaque against a tinted scrim. No glassmorphism.
export function Modal({
  open,
  onClose,
  title,
  caption,
  children,
  footer,
  widthClass = 'max-w-3xl',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Held in a ref so the focus effect keys only on `open` — a changing
  // onClose identity must not tear down and re-run the trap mid-dialog
  // (that would restore focus to the opener and snap it back in).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = ++nextModalId;
    modalStack.push(id);
    const isTopmost = () => modalStack[modalStack.length - 1] === id;

    // A descendant may claim focus deliberately (e.g. ComposeModal autoFocuses
    // its "To" field). When it already holds focus, honor it: don't yank focus
    // to the first focusable, and don't treat that descendant as the opener to
    // restore to on close.
    const preFocused = document.activeElement;
    const descendantHasFocus =
      preFocused instanceof HTMLElement && !!panelRef.current?.contains(preFocused);
    const opener =
      !descendantHasFocus && preFocused instanceof HTMLElement ? preFocused : null;

    // Read the panel fresh each time so a re-mounted node (e.g. a keyed
    // parent swap) never leaves the trap querying a detached element.
    const focusables = () => {
      const panel = panelRef.current;
      return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    };

    // Move focus into the dialog so keyboard/AT users leave background controls,
    // unless a descendant already claimed it.
    if (!descendantHasFocus) {
      const initial = focusables();
      (initial[0] ?? panelRef.current)?.focus();
    }

    const handleKey = (e: KeyboardEvent) => {
      // Only the topmost modal traps Tab/Escape; background modals stay inert.
      if (!isTopmost()) return;
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !panel) return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      const idx = modalStack.indexOf(id);
      if (idx !== -1) modalStack.splice(idx, 1);
      // Restore focus to whatever opened the dialog, if it's still mounted.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-fg/30 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`w-full ${widthClass} bg-surface border border-rule rounded-md flex flex-col max-h-[90vh] focus-mark`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule">
          <div className="min-w-0">
            <h2 id={titleId} className="text-title font-semibold text-fg truncate">
              {title}
            </h2>
            {caption && (
              <p className="text-label uppercase tracking-wider text-fg-muted mt-1 truncate">
                {caption}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors duration-150 ease-out-quart focus-mark text-lg leading-none px-1"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5 text-body text-fg">{children}</div>
        {footer && (
          <div className="border-t border-rule px-5 py-3 flex items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
