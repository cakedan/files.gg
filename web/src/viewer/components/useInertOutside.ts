import { useEffect, type RefObject } from 'react';

/**
 * While a full-page overlay (a lightbox portalled into `<body>`) is open, make every other child of
 * `<body>` inert, so Tab and screen readers stay inside it (WCAG 2.4.3). `aria-modal` alone doesn't
 * stop keyboard focus reaching the page behind. Elements that were already inert are left alone.
 */
export function useInertOutside(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const overlay = ref.current;
    if (!overlay) return;
    const others = [...document.body.children].filter(
      (element): element is HTMLElement => element instanceof HTMLElement && !element.contains(overlay) && !element.hasAttribute('inert'),
    );
    for (const element of others) element.setAttribute('inert', '');
    return () => {
      for (const element of others) element.removeAttribute('inert');
    };
  }, [ref]);
}
