import { DomainRouter } from 'cf-worker-router';

import { sessionCookieHeader, sessionCookieName } from '../utils/cookies.js';
import { apiOrigin, getStringBinding } from '../utils/env.js';
import { DEFAULT_HOSTS, hostPattern } from '../utils/hosts.js';
import { clientCountry } from '../utils/region.js';
import { isInternalApiPath, originRequestHeaders } from '../utils/security.js';

export const API_HOSTNAME = DEFAULT_HOSTS.api;


// The API's own 404 body. /internal/* is for the Worker's lookups only (domains/internal.js):
// requests from clients never reach it, whichever host or spelling they use.
function notFound() {
  return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found', status: 404 }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// api.files.gg: the passthrough for tools (upload keys) and cross-origin callers (custom-domain
// viewers). Never a session: no cookie goes upstream and none comes back (milestone-6.md §12).
// Handled (not `{pass: true}`) so the response goes through `beforeResponse` in index.js, which
// sets CORS and drops Set-Cookie. A worker's subrequest to its own route goes to the origin.
async function passthrough(event) {
  if (isInternalApiPath(event.url.pathname)) {
    return notFound();
  }
  const url = new URL(apiOrigin(event.environment));
  url.pathname = event.url.pathname;
  url.search = event.url.search;
  return await fetch(forOrigin(new Request(url, event.originalRequest), event));
}

// The API_HOST router (api.files.gg by default); `hosts` is utils/hosts.js getHosts(env).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.api));
  router.route('/*', '*', passthrough);
  return router;
}


let warnedMissingSecret = false;

// Every request to the API goes through here: client-supplied X-Filesgg-* headers and the client's
// Cookie are dropped, and the client IP and country (`request.cf.country`, milestone-7.md §11.1) are
// vouched for with the ORIGIN_SHARED_SECRET binding (see cf-worker/README.md). `main: true` (files.gg/api/* only) forwards the session cookie alone and
// marks the request `X-Filesgg-Via: main` (milestone-6.md §3.4, §12).
export function forOrigin(request, event, { main = false } = {}) {
  const sessionCookie = (main)
    ? sessionCookieHeader(event.originalRequest.headers.get('cookie'), sessionCookieName(event.environment))
    : null;
  const { headers, trusted } = originRequestHeaders(
    request.headers,
    getStringBinding(event.environment, 'ORIGIN_SHARED_SECRET'),
    event.originalRequest.headers.get('cf-connecting-ip'),
    { main, sessionCookie, country: clientCountry(event.originalRequest) },
  );
  if (!trusted && !warnedMissingSecret) {
    warnedMissingSecret = true;
    console.warn('ORIGIN_SHARED_SECRET is not set: API requests are sent without a trusted client IP');
  }
  return new Request(request, { headers });
}


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
// files.gg/api/*: the same-origin passthrough the website uses, the only one that carries the
// session cookie (`main: true` below).
export async function requestApi(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  // Same path and query as the incoming request unless a path is given.
  const pathname = options.path || event.url.pathname;
  if (isInternalApiPath(pathname)) {
    return notFound();
  }
  const url = new URL(apiOrigin(event.environment));
  url.pathname = pathname;
  url.search = event.url.search;

  const request = forOrigin(new Request(url, event.request), event, { main: true });
  if (bodyLessMethods.includes(options.method)) {
    options.body = null;
  }
  return await fetch(request, options);
};
