/**
 * Which host the viewer is on (milestone-6 §13.4). On a custom domain the Worker sets
 * `data-host="custom"` on `#root` and inlines
 * `#host-data` = `{ "host": "i.example.com", "main_origin": "https://files.gg", "api_origin": "https://api.files.gg" }`.
 * Everything else is `files.gg` and keeps its existing behaviour.
 *
 * In the entry bundle, so it stays tiny: no API client, no React.
 */

/** Used only when a custom-host shell's `#host-data` is missing or malformed. */
export const DEFAULT_MAIN_ORIGIN = 'https://files.gg';
export const DEFAULT_API_ORIGIN = 'https://api.files.gg';

export interface HostContext {
  /** True on a customer's domain. */
  custom: boolean;
  /** The custom hostname as the Worker gave it (`i.example.com`). Empty on files.gg. */
  host: string;
  /** This page's origin: rehosted URLs and Copy link use it. */
  origin: string;
  /** `https://files.gg`: the challenge frame's origin, and where links to files.gg go. */
  mainOrigin: string;
  /** `https://api.files.gg`: called without credentials from a custom host. */
  apiOrigin: string;
  /** `https://cdn.files.gg`: payload URLs on this origin are rehosted. */
  cdnOrigin: string;
}

export interface HostInput {
  /** `#root`'s `data-host`. */
  dataHost?: string | null | undefined;
  /** The text of `#host-data`. */
  hostJson?: string | null | undefined;
  /** This page's origin. */
  origin: string;
  /** This page's host (hostname and port), the fallback when `#host-data` has none. */
  locationHost: string;
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)$/i;

/** An `https:` URL (or `http:` on a local development host), normalised; else null. */
function httpUrl(value: unknown, keepPath: boolean): string | null {
  if (typeof value !== 'string' || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.test(url.hostname))) return null;
  if (!keepPath) return url.origin;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** The CDN origin for a main origin: `https://files.gg` → `https://cdn.files.gg`. */
export const cdnOriginFor = (mainOrigin: string): string => {
  const url = new URL(mainOrigin);
  return `${url.protocol}//cdn.${url.host}`;
};

/** Pure: the host context for a shell. */
export function parseHostContext({ dataHost, hostJson, origin, locationHost }: HostInput): HostContext {
  if (dataHost !== 'custom') {
    return {
      custom: false,
      host: '',
      origin,
      mainOrigin: DEFAULT_MAIN_ORIGIN,
      apiOrigin: DEFAULT_API_ORIGIN,
      cdnOrigin: cdnOriginFor(DEFAULT_MAIN_ORIGIN),
    };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = hostJson ? JSON.parse(hostJson) : null;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Malformed: the defaults below.
  }
  const host = typeof data.host === 'string' && HOST.test(data.host) ? data.host.toLowerCase() : locationHost.toLowerCase();
  const mainOrigin = httpUrl(data.main_origin, false) ?? DEFAULT_MAIN_ORIGIN;
  return {
    custom: true,
    host,
    origin,
    mainOrigin,
    // A path is kept, so a local stack can point at a prefixed mock API.
    apiOrigin: httpUrl(data.api_origin, true) ?? DEFAULT_API_ORIGIN,
    // Not in §13.4's `#host-data`; derived from the main origin unless the Worker sends it.
    cdnOrigin: httpUrl(data.cdn_origin, false) ?? cdnOriginFor(mainOrigin),
  };
}

/** Reads the host input from the live document. */
export function readHostInput(doc: Document = document): HostInput {
  return {
    dataHost: doc.getElementById('root')?.dataset.host ?? null,
    hostJson: doc.getElementById('host-data')?.textContent ?? null,
    origin: doc.location?.origin ?? window.location.origin,
    locationHost: doc.location?.host ?? window.location.host,
  };
}

let cached: HostContext | null = null;

/** The page's host context, read from the DOM once (after any dev fixture is applied). */
export function hostContext(): HostContext {
  cached ??= parseHostContext(readHostInput());
  return cached;
}

/** Tests: read the DOM again on the next call, or use `next` until the next reset. */
export function resetHostContext(next: HostContext | null = null): void {
  cached = next;
}

/** The name pages put in their title: `files.gg`, or the custom hostname. */
export const siteName = (): string => {
  const context = hostContext();
  return context.custom ? context.host : 'files.gg';
};

/**
 * A path on files.gg itself. On files.gg it stays relative; on a custom host it goes to
 * the main origin, because the custom host serves only viewer and byte paths (§10.8).
 */
export const mainUrl = (path: string): string => {
  const context = hostContext();
  return context.custom ? `${context.mainOrigin}${path}` : path;
};
