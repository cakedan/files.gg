/** Protocols the "You're leaving files.gg" interstitial will open. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export interface ExternalLinkInfo {
  /** The full, normalised URL shown to the user and opened on Continue. */
  href: string;
  /** Host (or the address for mailto:), shown prominently. */
  host: string;
  /** False for javascript:, data:, file: and anything unparsable: shown, never opened. */
  allowed: boolean;
}

/** Describes a link from untrusted content (a PDF annotation, a caption) for the interstitial. */
export function describeExternalLink(url: string): ExternalLinkInfo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { href: url, host: url, allowed: false };
  }
  const allowed = ALLOWED_PROTOCOLS.has(parsed.protocol);
  // Credentials in a URL are a classic spoofing trick ("https://files.gg@evil.example").
  const spoofy = parsed.username !== '' || parsed.password !== '';
  const host = parsed.protocol === 'mailto:' ? parsed.pathname : parsed.host;
  return { href: parsed.href, host: spoofy ? parsed.host : host, allowed };
}

/** Opens an allowed external link in a new tab without giving it a handle back to files.gg. */
export function openExternal(info: ExternalLinkInfo): boolean {
  if (!info.allowed) return false;
  window.open(info.href, '_blank', 'noopener,noreferrer');
  return true;
}
