/**
 * Web Risk link warnings (milestone-4 §5.7, §11.1). A URL in a payload's
 * `link_warnings` is never opened from files.gg: it can only be copied.
 *
 * Google's user-warning rules (https://docs.cloud.google.com/web-risk/docs/user-warnings)
 * apply to every warning built from this data: hedged wording ("suspected", "may be"),
 * the line "Advisory provided by Google" linked to Google's advisory page, and a
 * learn-more link for the threat type. The payload carries URLs only, not the threat
 * type, so all three learn-more links are offered.
 */

import { createContext, useContext } from 'react';

export const WEB_RISK_WARNING = "This link may be dangerous: it's suspected of hosting malware, phishing or unwanted software.";

export const WEB_RISK_ADVISORY_URL = 'https://docs.cloud.google.com/web-risk/docs/advisory';

/** Google's learn-more pages, one per threat type (SOCIAL_ENGINEERING, MALWARE, UNWANTED_SOFTWARE). */
export const WEB_RISK_LEARN_MORE = [
  { threat: 'SOCIAL_ENGINEERING', label: 'Phishing', href: 'https://www.antiphishing.org/' },
  { threat: 'MALWARE', label: 'Malware', href: 'https://developers.google.com/search/docs/advanced/security/malware' },
  { threat: 'UNWANTED_SOFTWARE', label: 'Unwanted software', href: 'https://www.google.com/about/company/unwanted-software-policy.html' },
] as const;

/**
 * A comparable form of a URL: parsed and re-serialised (lower-case scheme and host,
 * default port dropped), without the fragment or a trailing slash. Unparsable input
 * is compared as it is.
 */
export function normalizeLink(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

/**
 * The API's URL extraction (`api/safety/webrisk.py` `URL_PATTERN` and `TRAILING`), applied
 * to one link: from `http(s)://` up to the first whitespace, quote, `<`, `>`, `\`, `^`,
 * backtick, `{`, `|`, `}` or control character, then without trailing `.,;:!?)]}'"`.
 * Keep the two in step: a link the client renders must reduce to the same string the server
 * checked.
 */
// eslint-disable-next-line no-control-regex -- mirrors the server's pattern, which stops at control characters
const SERVER_URL_PATTERN = /https?:\/\/[^\s<>"'\\^`{|}\u0000-\u001f\u007f]+/i;
const SERVER_TRAILING = /[.,;:!?)\]}'"]+$/;

export function serverForm(url: string): string {
  const match = SERVER_URL_PATTERN.exec(url);
  return match ? match[0].replace(SERVER_TRAILING, '') : url.trim();
}

/**
 * True when `url` must not be opened because the server flagged it (milestone-4 §5.7, §11.1).
 *
 * The client may see a longer URL than the server did, because the client's linkifier keeps
 * characters the server cuts at, and a trailing `)` or `.`. So the link is reduced the server's
 * way and compared as a prefix: anything that starts with a flagged URL is flagged too. That
 * errs towards a warning, never towards a live link.
 */
export function isFlaggedLink(url: string, flagged: readonly string[] | undefined): boolean {
  if (!flagged || flagged.length === 0) return false;
  const candidates = [normalizeLink(url), normalizeLink(serverForm(url))];
  return flagged.some((entry) => {
    const bad = normalizeLink(entry);
    return candidates.some((candidate) => candidate === bad || extends_(candidate, bad));
  });
}

/**
 * `candidate` continues `bad`. A host-only `bad` (`https://evil.example`) must end at a URL
 * boundary, so it never matches another host (`https://evil.example.org`). A `bad` with a
 * path matches any continuation (`…/a_(b` flags `…/a_(b)`).
 */
function extends_(candidate: string, bad: string): boolean {
  if (!candidate.startsWith(bad)) return false;
  const next = candidate.charAt(bad.length);
  const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+[/?#]/i.test(bad);
  return hasPath || next === '' || next === '/' || next === '?' || next === '#';
}

/** The flagged URLs of the album being shown (title, description and captions). */
export const LinkWarningsContext = createContext<readonly string[]>([]);

export const useLinkWarnings = () => useContext(LinkWarningsContext);
