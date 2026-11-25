import { useSyncExternalStore } from 'react';

/** `matchMedia` as state. Without matchMedia (tests, old browsers) it reports `fallback`. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Tailwind's `sm` breakpoint: below it, tables become card lists. */
export const useIsNarrow = () => !useMediaQuery('(min-width: 640px)', true);
