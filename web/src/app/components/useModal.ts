import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]'));
}

/**
 * Modal behaviour for dialogs and drawers: focus moves in (to `initialFocus`, else
 * the first field), Tab stays inside, Esc closes, the page behind doesn't scroll,
 * and focus returns to where it was on close.
 */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void, initialFocus?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = panel.current;
    if (root) (initialFocus?.current ?? focusables(root)[0] ?? root).focus();

    const onKey = (event: KeyboardEvent) => {
      const current = panel.current;
      if (!current) return;
      // Only the top-most modal handles keys (a dialog opened from a drawer).
      const modals = document.querySelectorAll('[data-modal]');
      if (modals[modals.length - 1] !== current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(current);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
    // Mount-only: re-running would steal focus back on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
