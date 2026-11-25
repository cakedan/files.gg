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

/** sessionStorage, with the same never-throw rules (the Discord sign-in state, §5.2). */
export function getSessionItem(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setSessionItem(key: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSessionItem(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
