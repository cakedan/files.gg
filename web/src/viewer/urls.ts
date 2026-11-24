/** `?download=true` on the CDN URL, preserving any existing query. */
export function downloadUrl(cdnUrl: string): string {
  try {
    const url = new URL(cdnUrl);
    url.searchParams.set('download', 'true');
    return url.toString();
  } catch {
    return `${cdnUrl}${cdnUrl.includes('?') ? '&' : '?'}download=true`;
  }
}

/** The link "Copy link" copies: the canonical URL from the payload, else this page without query/hash. */
export function shareUrl(url: string | undefined, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return url ?? `${location.origin}${location.pathname}`;
}
