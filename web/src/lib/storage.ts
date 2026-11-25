/**
 * Safe localStorage access. Every call is wrapped in try/catch: storage can be
 * disabled (Safari private mode, blocked site data, sandboxed iframes) and any
 * access then throws.
 */

export function getItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
