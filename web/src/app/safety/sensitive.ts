import { useCallback, useSyncExternalStore } from 'react';

import { alwaysShowSensitive, setAlwaysShowSensitive, SHOW_SENSITIVE_KEY } from '../../lib/sensitive';

export { SHOW_SENSITIVE_KEY };

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHOW_SENSITIVE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setShowSensitive(value: boolean) {
  setAlwaysShowSensitive(value);
  for (const listener of listeners) listener();
}

/**
 * "Always show sensitive media" (milestone-4 §4.6, the viewer's `lib/sensitive.ts`
 * setting) as React state, kept in step across components and tabs.
 */
export function useShowSensitive(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, alwaysShowSensitive, () => false);
  return [value, useCallback((next: boolean) => setShowSensitive(next), [])];
}
