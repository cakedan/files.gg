/**
 * `download=true` appended to a CDN URL. The only change a client ever makes to one
 * (contract §4): the rest of the URL, a signed URL's `expires` and `sig` included, stays
 * byte for byte as the payload sent it.
 */
export function downloadUrl(url: string): string {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  return `${base}${base.includes('?') ? '&' : '?'}download=true${hash < 0 ? '' : url.slice(hash)}`;
}

/** The link "Copy link" copies: the canonical URL from the payload, else this page without query/hash. */
export function shareUrl(url: string | undefined, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return url ?? `${location.origin}${location.pathname}`;
}
