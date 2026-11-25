// Pure helpers for hardening cdn.files.gg (docs/redesign/PLAN.md, "Hardening cdn.files.gg").
// No Worker globals in here, so everything can be unit-tested with `node --test`.

import { DEFAULT_HOSTS, DEFAULT_ORIGINS, isMainHost } from './hosts.js';
import { boolean } from './inputtypes.js';


export const FALLBACK_FILENAME = 'file';
export const MAX_FILENAME_BYTES = 255;

// HTML, SVG, XHTML and every XML-family type are always served as text/plain (the XSS guard,
// PLAN.md §1.4 item 4). XML can pull in an XSLT stylesheet and render as an HTML page, so any
// `+xml` suffix type (svg, xhtml, rss, atom, ...) is included, not just the names listed here.
export const FORCED_TEXT_MIMETYPES = Object.freeze([
  'application/xhtml+xml',
  'application/xml',
  'image/svg+xml',
  'text/html',
  'text/xml',
  'text/xsl',
]);

// Lets pdf.js on files.gg read range responses from the CDN (otherwise it downloads whole files).
export const CDN_EXPOSE_HEADERS = 'Accept-Ranges, Content-Disposition, Content-Length, Content-Range';

export function isForcedText(mimetype) {
  const value = normalizeMimetype(mimetype);
  return FORCED_TEXT_MIMETYPES.includes(value) || value.endsWith('+xml');
}

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([DEFAULT_ORIGINS.main]);
// X-Filesgg-Access carries unlock tokens and owner passes for /files/<vanity>/view (contract §5).
export const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Fingerprint, X-Filesgg-Access';
export const CORS_ALLOW_METHODS = 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT';

// `mainOrigin` is the site allowed to frame CDN responses (MAIN_HOST; https://files.gg by default).
export function cdnContentSecurityPolicy(mainOrigin = DEFAULT_ORIGINS.main) {
  return [
    'sandbox',
    "default-src 'none'",
    "img-src 'self' data:",
    "media-src 'self'",
    "style-src 'unsafe-inline'",
    `frame-ancestors ${mainOrigin}`,
  ].join('; ');
}

export const CDN_CONTENT_SECURITY_POLICY = cdnContentSecurityPolicy();


// Written as \u escapes on purpose: literal invisible characters in source are easy for an
// editor or formatter to strip silently, which would quietly disable the protection.
const Regexps = Object.freeze({
  // Bidi controls: U+202A-U+202E, U+2066-U+2069, U+200E, U+200F, U+061C.
  BIDI: /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g,
  // Zero-width characters: U+200B-U+200D, U+2060, U+FEFF.
  ZERO_WIDTH: /[\u200B-\u200D\u2060\uFEFF]/g,
  // Any other invisible format character (soft hyphen, invisible operators, tag characters...).
  FORMAT: /\p{Cf}/gu,
  // C0 controls, DEL and C1 controls.
  CONTROL: /[\u0000-\u001F\u007F-\u009F]/g,
  LONE_SURROGATE: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
  WHITESPACE: /\s+/gu,
  TRIM_EDGES: /^[.\s]+|[.\s]+$/gu,
});


function utf8Length(value) {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes += (code < 0x80) ? 1 : (code < 0x800) ? 2 : (code < 0x10000) ? 3 : 4;
  }
  return bytes;
}

function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    result += char;
  }
  return result;
}

function toWellFormed(value) {
  return value.replace(Regexps.LONE_SURROGATE, '�');
}

function trimEdges(value) {
  return value.replace(Regexps.TRIM_EDGES, '');
}


export function sanitizeFilename(name) {
  if (name === null || name === undefined) {
    return FALLBACK_FILENAME;
  }

  let value = toWellFormed(String(name))
    .replace(Regexps.BIDI, '')
    .replace(Regexps.ZERO_WIDTH, '')
    .replace(Regexps.FORMAT, '')
    // Whitespace (tabs and newlines included) becomes a space before the remaining controls go.
    .replace(Regexps.WHITESPACE, ' ')
    .replace(Regexps.CONTROL, '')
    .replace(Regexps.WHITESPACE, ' ');
  value = trimEdges(value);

  if (utf8Length(value) > MAX_FILENAME_BYTES) {
    // Keep the final extension; shorten the part before it.
    const dot = value.lastIndexOf('.');
    const extension = (dot > 0) ? value.slice(dot) : '';
    if (extension && utf8Length(extension) < MAX_FILENAME_BYTES) {
      const base = trimEdges(truncateUtf8(value.slice(0, dot), MAX_FILENAME_BYTES - utf8Length(extension)));
      value = (base) ? base + extension : trimEdges(extension);
    } else {
      value = trimEdges(truncateUtf8(value, MAX_FILENAME_BYTES));
    }
  }

  return value || FALLBACK_FILENAME;
}


// RFC 5987 attr-char: ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
function encodeRfc5987(value) {
  return encodeURIComponent(toWellFormed(value))
    .replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

function asciiFallback(value) {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code > 0x7E) {
      result += '_';
    } else if (char === '"' || char === '\\') {
      result += '\\' + char;
    } else {
      result += char;
    }
  }
  return result;
}

// RFC 6266: `<type>; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>`.
export function contentDisposition(type, filename) {
  const disposition = (type === 'inline') ? 'inline' : 'attachment';
  const name = (filename === null || filename === undefined || filename === '') ? FALLBACK_FILENAME : String(filename);
  return `${disposition}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}


export function normalizeMimetype(mimetype) {
  return String(mimetype || '').split(';').shift().trim().toLowerCase();
}

// Only passive types may render inline on cdn.files.gg; everything else downloads.
export function isInlineAllowed(mimetype) {
  const value = normalizeMimetype(mimetype);
  const [type, subtype] = value.split('/');
  if (!type || !subtype) {
    return false;
  }
  switch (type) {
    case 'image': return !subtype.includes('svg');
    case 'audio':
    case 'video': return true;
    case 'text': return subtype === 'plain';
  }
  return false;
}


export function cdnSecurityHeaders({ mainOrigin } = {}) {
  return {
    'Content-Security-Policy': (mainOrigin) ? cdnContentSecurityPolicy(mainOrigin) : CDN_CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}


// `fallback`: the origins used when the value is empty (the main site's origin).
export function parseAllowedOrigins(value, fallback = DEFAULT_ALLOWED_ORIGINS) {
  if (Array.isArray(value)) {
    value = value.join(',');
  }
  if (typeof(value) !== 'string' || !value.trim()) {
    return fallback.slice();
  }
  const origins = value.split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter((origin) => origin && origin !== '*' && origin !== 'null');
  return (origins.length) ? origins : fallback.slice();
}

// API passthrough: everything on API_HOST (api.files.gg), plus MAIN_HOST/api/* (the stable
// router's proxy). `hosts` comes from utils/hosts.js getHosts(env).
export function isCredentialedRoute(hostname, pathname, hosts = DEFAULT_HOSTS) {
  const host = String(hostname || '').toLowerCase();
  if (host === hosts.api) {
    return true;
  }
  return isMainHost(host, hosts) && /^\/+api(?:\/|$)/.test(String(pathname || ''));
}

// Credentialed routes reflect an allowlisted origin; everything else is `*` without credentials.
export function corsHeaders({ origin, allowedOrigins = DEFAULT_ALLOWED_ORIGINS, credentialed = false } = {}) {
  const headers = {
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
  };

  const normalized = (typeof(origin) === 'string') ? origin.trim().toLowerCase() : '';
  if (credentialed && normalized && allowedOrigins.includes(normalized)) {
    headers['Access-Control-Allow-Origin'] = origin.trim();
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  if (credentialed) {
    // The answer depends on Origin, so caches must key on it.
    headers['Vary'] = 'Origin';
  }
  return headers;
}


function getQueryValue(query, key) {
  if (!query) {
    return null;
  }
  if (typeof(query.get) === 'function') {
    return query.get(key);
  }
  return (key in query) ? query[key] : null;
}

// Decides content-type and content-disposition for a file served from cdn.files.gg/files/...
export function decideCdnResponse({ mimetype, query, filename } = {}) {
  let contentType = String(mimetype || 'application/octet-stream');
  if (isForcedText(contentType)) {
    contentType = 'text/plain';
  } else if (boolean(getQueryValue(query, 'force-text'))) {
    contentType = 'text/plain';
  }

  let disposition = 'attachment';
  if (isInlineAllowed(contentType) && !boolean(getQueryValue(query, 'download'))) {
    disposition = 'inline';
  }

  const safeFilename = sanitizeFilename(filename);
  return {
    contentType,
    disposition,
    filename: safeFilename,
    contentDisposition: contentDisposition(disposition, safeFilename),
  };
}


// Constant-time comparison for the proxy's shared secret. Fails closed when no secret is configured.
export function isValidProxyToken(token, secret) {
  if (typeof(secret) !== 'string' || !secret || typeof(token) !== 'string') {
    return false;
  }
  let difference = token.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) {
    difference |= secret.charCodeAt(i) ^ token.charCodeAt(i % (token.length || 1));
  }
  return difference === 0;
}


// --- Requests forwarded to the API origin ---------------------------------------------------
// The origin trusts a client IP only from a request carrying the shared secret (see
// api/utils/client_ip.py). Anyone can reach the origin directly and send CF-Connecting-IP, so the
// worker vouches for the address in its own headers, and never forwards client-supplied copies.

export const CLIENT_IP_HEADER = 'X-Filesgg-Client-Ip';
export const ORIGIN_SECRET_HEADER = 'X-Filesgg-Origin-Secret';

// Returns `{ headers, trusted }`: a copy of `headers` (a Headers object or a plain object) for the
// API request. Incoming copies of both headers are always removed. With a secret, the secret and
// the client IP (default: the incoming CF-Connecting-IP) are set; without one, neither is (fail
// closed) and `trusted` is false.
export function originRequestHeaders(headers, secret, clientIp) {
  const result = new Headers(headers || {});
  const incomingClientIp = result.get('cf-connecting-ip');
  result.delete(CLIENT_IP_HEADER);
  result.delete(ORIGIN_SECRET_HEADER);

  if (typeof(secret) !== 'string' || !secret) {
    return { headers: result, trusted: false };
  }

  result.set(ORIGIN_SECRET_HEADER, secret);
  const ip = (clientIp === undefined) ? incomingClientIp : clientIp;
  if (typeof(ip) === 'string' && ip.trim()) {
    result.set(CLIENT_IP_HEADER, ip.trim());
  }
  return { headers: result, trusted: true };
}
