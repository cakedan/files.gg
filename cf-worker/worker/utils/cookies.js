// The web session cookie (docs/redesign/contracts/milestone-6.md §3, §12 item 1). Pure, so it is
// unit-tested with `node --test`.
//
// - files.gg/api/* (the same-origin passthrough): only the session cookie is forwarded, as
//   `Cookie: <name>=<value>`, and only the API's Set-Cookie for that one cookie comes back.
// - Everywhere else (files.gg pages and assets, api.files.gg, cdn.files.gg and custom domains):
//   no Cookie goes upstream and no Set-Cookie comes back.

import { getStringBinding } from './env.js';

// Unset: the production name. The local stack (plain http, no `Secure`) sets `filesgg_session`.
export const DEFAULT_SESSION_COOKIE_NAME = '__Host-filesgg_session';

// RFC 6265 §4.1.1: cookie-name is an RFC 7230 token; cookie-value is cookie-octets (no quotes,
// whitespace, comma, semicolon or backslash). The API's tokens are `fgs_` + base62.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

let cache = { raw: undefined, name: DEFAULT_SESSION_COOKIE_NAME };

// The SESSION_COOKIE_NAME var, or the default. A malformed name fails loudly at the first request
// (like the host vars), so a typo never forwards the wrong cookie.
export function sessionCookieName(env) {
  const raw = getStringBinding(env, 'SESSION_COOKIE_NAME');
  if (raw !== cache.raw) {
    let name = DEFAULT_SESSION_COOKIE_NAME;
    if (raw !== undefined && raw.trim()) {
      name = raw.trim();
      if (!COOKIE_NAME.test(name)) {
        throw new Error(`SESSION_COOKIE_NAME must be a cookie name (an RFC 7230 token), got ${JSON.stringify(raw)}`);
      }
    }
    cache = { raw, name };
  }
  return cache.name;
}

// The `Cookie` header to send to the API for files.gg/api/*: `<name>=<value>` for the session
// cookie only, or null. Every other cookie is dropped (Cloudflare's, analytics, anything a
// sibling host managed to set). Two different values under the session name can only come from a
// cookie set by another host or path (the `__Host-` prefix forbids that in production): nothing
// is forwarded then, so the request is simply signed out instead of signed in as someone else.
export function sessionCookieHeader(cookieHeader, name) {
  if (typeof(cookieHeader) !== 'string' || !cookieHeader || typeof(name) !== 'string' || !name) {
    return null;
  }
  let found = null;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) {
      continue;
    }
    const value = part.slice(index + 1).trim();
    if (found !== null && found !== value) {
      return null;
    }
    found = value;
  }
  return (found !== null && COOKIE_VALUE.test(found)) ? `${name}=${found}` : null;
}

// The cookie name a Set-Cookie value sets, or null.
export function setCookieName(value) {
  const text = String(value || '');
  const index = text.indexOf('=');
  return (index > 0) ? text.slice(0, index).trim() : null;
}

function setCookieList(headers) {
  if (typeof(headers.getSetCookie) === 'function') {
    return headers.getSetCookie();
  }
  // No way to split them safely: keep none (fail closed).
  return [];
}

// Removes every Set-Cookie from `headers` (a mutable Headers), except those that set or clear the
// cookie named `keep` (exact, case-sensitive name). `keep: null` removes them all. Returns the
// values kept.
export function filterSetCookies(headers, keep = null) {
  const list = headers.has('set-cookie') ? setCookieList(headers) : [];
  headers.delete('set-cookie');
  const kept = (keep) ? list.filter((value) => setCookieName(value) === keep) : [];
  for (const value of kept) {
    headers.append('set-cookie', value);
  }
  return kept;
}
