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

/**
 * Reads a value written by the old Mithril app, which stores `token` and
 * `fingerprint` JSON-encoded (`JSON.stringify("abc")` -> `"\"abc\""`).
 * Falls back to the raw string for values written without encoding.
 */
export function getLegacyString(key: string): string | null {
  const raw = getItem(key);
  if (raw === null || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return parsed || null;
    }
    if (typeof parsed === 'number') {
      return String(parsed);
    }
    return null;
  } catch {
    return raw;
  }
}

/** Writes a value the same way the old app does, so either app can read it. */
export function setLegacyString(key: string, value: string): boolean {
  return setItem(key, JSON.stringify(value));
}
