/**
 * Rehosting (milestone-6 §10.9). Signed URLs cover the path only, so a URL on the CDN
 * origin or the public origin is moved onto the custom host by swapping the origin and
 * keeping everything after it byte for byte: path, query (`expires`, `sig`) and fragment.
 * Any other URL is returned unchanged. Origins are compared exactly, as strings, so
 * `https://cdn.files.gg.evil.example/…` never matches.
 *
 * Works on the string, never through `URL`, which would re-encode the path.
 */

/** The characters that may follow an origin in an absolute URL. */
const AFTER_ORIGIN = new Set(['/', '?', '#']);

export function rehost(url: string, targetOrigin: string, sourceOrigins: readonly string[]): string {
  for (const origin of sourceOrigins) {
    if (!url.startsWith(origin)) continue;
    const rest = url.slice(origin.length);
    if (rest === '' || AFTER_ORIGIN.has(rest[0]!)) return targetOrigin + rest;
  }
  return url;
}

/** `rehost(url, host)` exactly as §10.9 writes it: onto `https://<host>`. */
export const rehostToHost = (url: string, host: string, sourceOrigins: readonly string[]): string =>
  rehost(url, `https://${host}`, sourceOrigins);

/** A key whose string value is a URL in the payloads: `url`, `cdn_url`, `hover_url`, `download_url`, … */
const isUrlKey = (key: string) => key === 'url' || key.endsWith('_url');

/**
 * Rehosts every URL in an API response (unlock, view, refresh, open, album pages): the
 * string values of `url` and `*_url` keys, at any depth. Returns a copy; other values
 * (filenames, captions, `link_warnings`) are never touched.
 */
export function rehostPayload<T>(value: T, targetOrigin: string, sourceOrigins: readonly string[]): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = typeof child === 'string' && isUrlKey(key) ? rehost(child, targetOrigin, sourceOrigins) : walk(child);
    }
    return out;
  };
  return walk(value) as T;
}
