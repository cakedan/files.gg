import { hostContext, type HostContext } from './host/context';
import { rehost } from './host/rehost';

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

/**
 * The link "Copy link" copies: the canonical URL from the payload, else this page
 * without query/hash. On a custom domain it's built on `location.origin` (milestone-6
 * §13.4): a payload URL still on files.gg is moved onto this domain, path kept.
 */
export function shareUrl(
  url: string | undefined,
  location: Pick<Location, 'origin' | 'pathname'> = window.location,
  context: Pick<HostContext, 'custom' | 'origin' | 'mainOrigin' | 'cdnOrigin'> = hostContext(),
): string {
  if (!url) return `${location.origin}${location.pathname}`;
  // `context.origin` is `location.origin`, read once with the rest of the host context.
  return context.custom ? rehost(url, context.origin, [context.mainOrigin, context.cdnOrigin]) : url;
}
