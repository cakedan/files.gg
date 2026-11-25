// Custom domains (docs/redesign/contracts/milestone-6.md §10.8-§10.11): which hostnames the
// custom-host router answers, how it classifies a path, rehosting URLs onto a custom domain, and
// the files.gg/challenge parameters. Pure, so it is unit-tested with `node --test`.

import { DEFAULT_HOSTS, isMainHost } from './hosts.js';
import { parseAlbumPath, parseFilePath, parsePreviewPath } from './media.js';
import { classifyReportPath, classifyVanityPath, ROOT_FILES } from './viewer.js';

// A lower-case DNS name of LDH labels (punycode for IDNs), at most 253 characters. Custom
// hostnames are always subdomains (§10.1), so at least two labels.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isHostname(value) {
  return typeof(value) === 'string' && HOSTNAME.test(value);
}

// True for one of the Worker's own hosts (the four routers of index.js).
export function isOwnHost(hostname, hosts = DEFAULT_HOSTS) {
  const host = String(hostname || '').toLowerCase();
  return isMainHost(host, hosts) || host === hosts.cdn || host === hosts.api || host === hosts.proxy;
}

// A hostname that may be a customer's domain, so worth a domain lookup: a valid name that isn't
// one of ours, nor anything under MAIN_HOST (the API never accepts those, §10.1 step 4).
export function isCustomHostname(hostname, hosts = DEFAULT_HOSTS) {
  const host = String(hostname || '').toLowerCase();
  if (!isHostname(host) || isOwnHost(host, hosts)) {
    return false;
  }
  return !(host === hosts.main || host.endsWith('.' + hosts.main));
}


// §10.8 step 1: Cloudflare's own certificate and hostname validation paths, passed straight to the
// origin so the Worker never answers them.
export const DCV_PREFIXES = Object.freeze([
  '/.well-known/acme-challenge/',
  '/.well-known/pki-validation/',
  '/.well-known/cf-custom-hostname-challenge/',
]);

export function isDcvPath(pathname) {
  const path = String(pathname || '');
  return DCV_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
}

// First path segments that are never served on a custom domain (§10.8 "anything else"): the
// dashboard, the API passthrough, the converter, and everything under /.well-known/ but the DCV
// paths (security.txt included).
const NOT_SERVED = Object.freeze(['app', 'api', 'convert', '.well-known']);

// Classifies a custom-domain path (§10.8 step 3):
//   dcv | home | root-file | asset | cdn (with `parsed` and `kind`: file, preview, album) |
//   report (with `data`) | not-found | album | file | missing (with `vanity`)
export function classifyCustomPath(pathname) {
  const path = String(pathname || '/');
  if (isDcvPath(path)) {
    return { route: 'dcv' };
  }
  if (path === '/') {
    return { route: 'home' };
  }
  if (ROOT_FILES.includes(path)) {
    return { route: 'root-file' };
  }
  if (path.startsWith('/assets/')) {
    return { route: 'asset' };
  }
  const first = path.split('/')[1].toLowerCase();
  if (first === 'files' || first === 'previews' || first === 'albums') {
    // The CDN's byte paths. They are reserved vanity segments (§6.3), so they never mean a vanity.
    let parsed;
    if ((parsed = parseFilePath(path))) {
      return { route: 'cdn', kind: 'file', parsed };
    }
    if ((parsed = parsePreviewPath(path))) {
      return { route: 'cdn', kind: 'preview', parsed };
    }
    if ((parsed = parseAlbumPath(path))) {
      return { route: 'cdn', kind: 'album', parsed };
    }
    return { route: 'cdn', kind: null, parsed: null };
  }
  if (NOT_SERVED.includes(first)) {
    return { route: 'not-found' };
  }
  const report = classifyReportPath(path);
  if (report) {
    return report;
  }
  const route = classifyVanityPath(path);
  // `/<nothing usable>` (for example `/.x`): not the landing card, just nothing.
  return (route.route === 'home') ? { route: 'not-found' } : route;
}


// §10.9: rehosting. A URL on the CDN or public origin moves to the custom origin, keeping its path,
// query and fragment byte for byte (signatures cover the path only, so they stay valid). Origins
// are compared exactly, as a prefix followed by the end, `/`, `?` or `#`; anything else (another
// host, a lookalike such as `https://cdn.files.gg.evil.example`, userinfo, an explicit port) is
// returned unchanged.
export function rehost(url, fromOrigins, toOrigin) {
  if (typeof(url) !== 'string') {
    return url;
  }
  for (const origin of fromOrigins) {
    if (url.startsWith(origin)) {
      const rest = url.slice(origin.length);
      if (rest === '' || rest[0] === '/' || rest[0] === '?' || rest[0] === '#') {
        return toOrigin + rest;
      }
    }
  }
  return url;
}

// Rehosts every string in a JSON value (the inlined boot data and the lookup payload the meta tags
// are made from). Returns a copy; keys are kept as they are.
export function rehostDeep(value, fromOrigins, toOrigin) {
  if (typeof(value) === 'string') {
    return rehost(value, fromOrigins, toOrigin);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rehostDeep(item, fromOrigins, toOrigin));
  }
  if (value && typeof(value) === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = rehostDeep(item, fromOrigins, toOrigin);
    }
    return result;
  }
  return value;
}

// The origins the API writes URLs on: `https://<CDN_HOST>` and `https://<MAIN_HOST>` (CDN_URL and
// PUBLIC_URL), plus the request's own scheme and port for a local stack. `origins` is
// utils/hosts.js publicOrigins() for this request.
export function rehostSources(hosts = DEFAULT_HOSTS, origins = null) {
  const list = [`https://${hosts.cdn}`, `https://${hosts.main}`];
  if (origins) {
    list.push(origins.cdn, origins.main);
  }
  return [...new Set(list)];
}


// §10.10: `files.gg/challenge?host=<custom hostname>&action=unlock|report`. Returns { host, action }
// or null when either is unusable (the domain lookup then decides whether the host is serving).
export const CHALLENGE_ACTIONS = Object.freeze(['unlock', 'report']);

export function parseChallengeQuery(query, hosts = DEFAULT_HOSTS) {
  const host = query.get('host');
  const action = query.get('action');
  if (!CHALLENGE_ACTIONS.includes(action) || typeof(host) !== 'string' || !isCustomHostname(host, hosts)) {
    return null;
  }
  // isCustomHostname lower-cases; the host must already be lower case, as location.hostname is.
  return (host === host.toLowerCase()) ? { host, action } : null;
}


// §10.8 step 2: a domain that isn't connected (unknown, deleted, or not serving).
export const NOT_CONNECTED_MESSAGE = "This domain isn't connected to files.gg right now.";
export const UNAVAILABLE_MESSAGE = 'files.gg is unavailable right now. Try again in a minute.';

export function minimalPage(message) {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>files.gg</title></head>'
    + `<body><p>${message}</p></body></html>\n`;
}

export const MINIMAL_PAGE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// §10.11: HSTS on custom domains, without includeSubDomains or preload (the domain isn't ours).
export const CUSTOM_HSTS = 'max-age=31536000';
