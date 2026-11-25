import { ApiError, DomainRouter } from 'cf-worker-router';

import { internalLookup } from './internal.js';
import { fetchBlob } from '../storage.js';
import { getStringBinding, storageOrigin } from '../utils/env.js';
import { DEFAULT_HOSTS, hostPattern } from '../utils/hosts.js';
import {
  cdnSecurityHeaders,
  decideCdnResponse,
  isForcedText,
} from '../utils/security.js';
import { tokenGrantsAccess, verifyToken } from '../utils/token.js';
import { isExpired } from '../utils/viewer.js';


export const CDN_HOSTNAME = DEFAULT_HOSTS.cdn;

// Same as GCS's default for public objects, which is what the CDN sent before.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=3600';
export const PROTECTED_CACHE_CONTROL = 'private, no-store';

// The CDN_HOST router (cdn.files.gg by default); `hosts` is utils/hosts.js getHosts(env).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.cdn));
  router.route('/*', ['GET', 'HEAD', 'OPTIONS'], legacyStorage);
  router.route('/files/:fileId...', ['GET', 'HEAD', 'OPTIONS'], serveFile);
  return router;
}


// Legacy: raw paths in the old GCS bucket (the old frontend's /assets/stable/*). Never B2, and
// never /files/*, which goes through the access check below.
async function legacyStorage(event) {
  const response = await requestStorage(event, event.url.pathname);
  // Same XSS guard as /files/: never let storage serve markup with a renderable type.
  if (response.ok && isForcedText(response.headers.get('content-type'))) {
    response.headers.set('content-type', 'text/plain');
  }
  return response;
}


function cdnError(status, cacheControl) {
  const response = new ApiError({ status });
  if (cacheControl) {
    response.headers.set('Cache-Control', cacheControl);
  }
  return response;
}

// Contract §1 rules 1-4, with the file lookup (contract §2): its file id, access block and
// albums ([{ id, access_version }]). One lookup, no album lookups.
async function hasAccess(event, data) {
  const { file, access } = data;
  if (file.id === undefined || file.id === null || String(file.id) === '') {
    console.error('API contract error: internal file lookup has no file.id; denying access', file.vanity);
    return false;
  }
  const token = event.url.searchParams.get('t');
  if (!token) {
    return false;
  }
  const claims = await verifyToken(token, getStringBinding(event.environment, 'CDN_TOKEN_SECRET'));
  return tokenGrantsAccess(claims, {
    fileId: file.id,
    accessVersion: access.access_version,
    albums: data.albums,
    visibility: access.visibility,
  });
}


// cdn.files.gg/files/<vanity>[.<anything>], multi-segment vanities included (PLAN.md §1.4).
async function serveFile(event) {
  if (event.method === 'OPTIONS') {
    // CORS preflight: index.js adds the headers. Nothing is looked up.
    return new Response(null, { status: 204 });
  }

  const vanity = event.parameters.fileId.split('.').shift();
  const lookup = await internalLookup(event, 'files', vanity);
  if (lookup.status === 'unavailable') {
    return cdnError(503, PROTECTED_CACHE_CONTROL);
  }
  const data = (lookup.status === 'found') ? lookup.data : null;
  const file = data && data.file;
  const access = (data && data.access) || {};
  if (!file || isExpired(file, Date.now())) {
    return cdnError(404);
  }

  // Access check BEFORE any byte (or cached byte) is touched.
  const isProtected = access.visibility !== 'link';
  if (isProtected && !(await hasAccess(event, { ...data, access }))) {
    // `password` says "locked"; `private` (and anything unknown) says "doesn't exist".
    return cdnError(access.visibility === 'password' ? 401 : 404, PROTECTED_CACHE_CONTROL);
  }

  const response = await fetchBlob({
    env: event.environment,
    request: event.originalRequest,
    storage: data.storage,
    waitUntil: (promise) => event.context && event.context.waitUntil(promise),
  });
  const cacheControl = isProtected ? PROTECTED_CACHE_CONTROL : PUBLIC_CACHE_CONTROL;
  if (!(response.ok || response.status === 304)) {
    const error = cdnError(response.status, isProtected ? PROTECTED_CACHE_CONTROL : null);
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      error.headers.set('Content-Range', contentRange);
    }
    return error;
  }

  if (response.ok) {
    const decision = decideCdnResponse({
      filename: file.filename,
      mimetype: file.mimetype,
      query: event.url.searchParams,
    });
    response.headers.set('content-disposition', decision.contentDisposition);
    response.headers.set('content-type', decision.contentType);
  }
  response.headers.set('cache-control', cacheControl);
  return response;
}


// Applied to every response on cdn.files.gg (including 404s, 405s and 500s) from index.js.
// `mainOrigin`: the MAIN_HOST origin allowed to frame it (https://files.gg by default).
export function applyCdnSecurityHeaders(response, { mainOrigin } = {}) {
  const headers = cdnSecurityHeaders({ mainOrigin });
  for (const name in headers) {
    response.headers.set(name, headers[name]);
  }
  return response;
};


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
export async function requestStorage(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL(storageOrigin(event.environment));
  url.pathname = options.path;

  const request = new Request(url, event.request);
  if (bodyLessMethods.includes(options.method)) {
    options.body = null;
  }

  let response = await fetch(request, options);
  if (response.status < 400) {
    response = new Response(response.body, response);

    for (let header of response.headers.keys()) {
      if (header.startsWith('x-g')) {
        response.headers.delete(header);
      }
    }
  } else {
    let status = response.status;
    if (status === 403) {
      status = 404;
    }
    response = new ApiError({status});
  }
  return response;
};
