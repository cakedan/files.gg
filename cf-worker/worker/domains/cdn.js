// cdn.files.gg (docs/redesign/contracts/milestone-3.md §3). Every URL it serves:
//
//   /files/<vanity>.<ext>                         the file itself
//   /previews/<kind>/<vanity>.<kind ext>?v=<ver>  a generated preview
//   /albums/collage/<album vanity>.webp?v=<ver>   an album's collage
//   /albums/download/<album vanity>.zip           an album's "Download all"
//
// Anything else is 404. Password and private targets are served only through signed URLs
// (utils/signing.js), checked before any byte (or cached byte) is touched.

import { ApiError, DomainRouter } from 'cf-worker-router';

import { internalLookup } from './internal.js';
import { fetchBlob } from '../storage.js';
import { getStringBinding } from '../utils/env.js';
import { DEFAULT_HOSTS, hostPattern } from '../utils/hosts.js';
import {
  albumZipPlan,
  parseAlbumPath,
  parseFilePath,
  parsePreviewPath,
  previewContentType,
  ZIP_LIMIT,
  zipFilename,
} from '../utils/media.js';
import {
  cdnSecurityHeaders,
  contentDisposition,
  decideCdnResponse,
} from '../utils/security.js';
import { albumGrant, grantForFileRequest, verifySignedUrl } from '../utils/signing.js';
import { isExpired, visibleAlbumItems } from '../utils/viewer.js';
import { createZipStream, zipSize } from '../utils/zip.js';


export const CDN_HOSTNAME = DEFAULT_HOSTS.cdn;

// Public (`link`) files themselves.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=3600';
// Anything served through a signed URL, and every error about a protected target.
export const PROTECTED_CACHE_CONTROL = 'private, no-store';
// Previews and collages of `link` files and albums: the URL carries ?v=, which changes when they
// are regenerated (contract §3).
export const PREVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const METHODS = ['GET', 'HEAD', 'OPTIONS'];

// The CDN_HOST router (cdn.files.gg by default); `hosts` is utils/hosts.js getHosts(env). One
// catch-all route: the paths are parsed here, not by the router, so a malformed escape is a 404
// rather than a router error, and anything unknown is a 404 (POST and friends: 405).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.cdn));
  router.route('/*', METHODS, serveCdn);
  return router;
}


function serveCdn(event) {
  const pathname = event.url.pathname;
  const route = routeFor(pathname);
  if (!route) {
    return cdnError(404);
  }
  if (event.method === 'OPTIONS') {
    // CORS preflight: index.js adds the headers. Nothing is looked up.
    return new Response(null, { status: 204 });
  }
  return route.handler(event, route.parsed);
}

function routeFor(pathname) {
  let parsed;
  if ((parsed = parseFilePath(pathname))) {
    return { handler: serveFile, parsed };
  }
  if ((parsed = parsePreviewPath(pathname))) {
    return { handler: servePreview, parsed };
  }
  if ((parsed = parseAlbumPath(pathname))) {
    return { handler: (parsed.resource === 'download') ? serveAlbumZip : serveAlbumCollage, parsed };
  }
  return null;
}


function cdnError(status, cacheControl) {
  const response = new ApiError({ status });
  if (cacheControl) {
    response.headers.set('Cache-Control', cacheControl);
  }
  return response;
}

// A storage error as a CDN error, keeping Content-Range for a 416.
function storageError(response, isProtected) {
  const error = cdnError(response.status, isProtected ? PROTECTED_CACHE_CONTROL : null);
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    error.headers.set('Content-Range', contentRange);
  }
  return error;
}

function waitUntilFor(event) {
  return (promise) => event.context && event.context.waitUntil(promise);
}

// The refusal for a protected target: `password` says "locked" (401); `private` and anything
// unknown say "doesn't exist" (404). Never cacheable.
function denied(access) {
  return cdnError(access.visibility === 'password' ? 401 : 404, PROTECTED_CACHE_CONTROL);
}

function verify(event, grant) {
  return verifySignedUrl({
    secret: getStringBinding(event.environment, 'CDN_SIGNING_SECRET'),
    path: event.url.pathname,
    query: event.url.searchParams,
    grant,
  });
}


// The file lookup for a vanity, as { data } or { response } (404, or 503 when the API is down).
async function lookupFile(event, vanity) {
  const lookup = await internalLookup(event, 'files', vanity);
  if (lookup.status === 'unavailable') {
    return { response: cdnError(503, PROTECTED_CACHE_CONTROL) };
  }
  const data = (lookup.status === 'found') ? lookup.data : null;
  if (!data || !data.file || isExpired(data.file, Date.now())) {
    return { response: cdnError(404) };
  }
  return { data, access: data.access || {} };
}

// null when the file's URLs (the bytes and its previews) may be served, else the refusal.
// `link` is public; anything else needs a URL signed with the file grant, or with `album=` the
// grant of an album the file is shown in (contract §3).
async function checkFileAccess(event, data, access) {
  if (access.visibility === 'link') {
    return null;
  }
  if (data.file.id === undefined || data.file.id === null || data.file.id === '') {
    // Required by contract §5. Without it nothing is granted, album grants included (fail closed).
    console.error('API contract error: internal file lookup has no file.id; denying access', data.file.vanity);
    return denied(access);
  }
  const grant = grantForFileRequest(data, event.url.searchParams);
  return (await verify(event, grant)) ? null : denied(access);
}


// cdn.files.gg/files/<vanity>[.<anything>], multi-segment vanities included.
async function serveFile(event, { vanity }) {
  const { data, access, response: error } = await lookupFile(event, vanity);
  if (error) {
    return error;
  }

  const isProtected = access.visibility !== 'link';
  const refusal = await checkFileAccess(event, data, access);
  if (refusal) {
    return refusal;
  }

  const response = await fetchBlob({
    env: event.environment,
    request: event.originalRequest,
    storage: data.storage,
    waitUntil: waitUntilFor(event),
  });
  if (!(response.ok || response.status === 304)) {
    return storageError(response, isProtected);
  }
  if (response.ok) {
    const decision = decideCdnResponse({
      filename: data.file.filename,
      mimetype: data.file.mimetype,
      query: event.url.searchParams,
    });
    response.headers.set('content-disposition', decision.contentDisposition);
    response.headers.set('content-type', decision.contentType);
  }
  response.headers.set('cache-control', isProtected ? PROTECTED_CACHE_CONTROL : PUBLIC_CACHE_CONTROL);
  return response;
}


// cdn.files.gg/previews/<kind>/<vanity>.<ext>: a preview, with exactly the file's access rules,
// from the vanity lookup's `previews` map (contract §5).
async function servePreview(event, { kind, vanity }) {
  const { data, access, response: error } = await lookupFile(event, vanity);
  if (error) {
    return error;
  }

  // Access first, so a protected file never says which previews it has.
  const isProtected = access.visibility !== 'link';
  const refusal = await checkFileAccess(event, data, access);
  if (refusal) {
    return refusal;
  }

  const previews = (data.previews && typeof(data.previews) === 'object') ? data.previews : {};
  const row = Object.hasOwn(previews, kind) ? previews[kind] : null;
  if (!row || typeof(row.key) !== 'string' || !row.key) {
    return cdnError(404, isProtected ? PROTECTED_CACHE_CONTROL : null);
  }

  const response = await fetchBlob({
    env: event.environment,
    request: event.originalRequest,
    storage: { key: row.key },
    waitUntil: waitUntilFor(event),
    // A re-derive rewrites the same key; the version tells the cached copies apart.
    cacheVersion: data.previews_version ?? null,
  });
  if (!(response.ok || response.status === 304)) {
    return storageError(response, isProtected);
  }
  if (response.ok) {
    response.headers.set('content-type', previewContentType(kind, row));
    response.headers.set('content-disposition', 'inline');
  }
  response.headers.set('cache-control', isProtected ? PROTECTED_CACHE_CONTROL : PREVIEW_CACHE_CONTROL);
  return response;
}


// The album lookup for an album resource, after its access check (a URL signed with the album
// grant, without `album=`), as { data, isProtected } or { response }. An album with nothing to
// show is missing (contract §4).
async function lookupAlbum(event, vanity) {
  const lookup = await internalLookup(event, 'albums', vanity);
  if (lookup.status === 'unavailable') {
    return { response: cdnError(503, PROTECTED_CACHE_CONTROL) };
  }
  const data = (lookup.status === 'found') ? lookup.data : null;
  const album = data && data.album;
  const access = (data && data.access) || {};
  if (!album || isExpired(album, Date.now())) {
    return { response: cdnError(404) };
  }

  const isProtected = access.visibility !== 'link';
  if (isProtected && !(await verify(event, albumGrant(album.id, access.access_version)))) {
    return { response: denied(access) };
  }
  if (!visibleAlbumItems(data).length) {
    return { response: cdnError(404, isProtected ? PROTECTED_CACHE_CONTROL : null) };
  }
  return { data, isProtected };
}


// cdn.files.gg/albums/collage/<album vanity>.webp
async function serveAlbumCollage(event, { vanity }) {
  const { data, isProtected, response: error } = await lookupAlbum(event, vanity);
  if (error) {
    return error;
  }
  const collage = data.collage;
  if (!collage || typeof(collage.key) !== 'string' || !collage.key) {
    return cdnError(404, isProtected ? PROTECTED_CACHE_CONTROL : null);
  }
  const response = await fetchBlob({
    env: event.environment,
    request: event.originalRequest,
    storage: { key: collage.key },
    waitUntil: waitUntilFor(event),
    cacheVersion: collage.version ?? null,
  });
  if (!(response.ok || response.status === 304)) {
    return storageError(response, isProtected);
  }
  if (response.ok) {
    response.headers.set('content-type', 'image/webp');
    response.headers.set('content-disposition', 'inline');
  }
  response.headers.set('cache-control', isProtected ? PROTECTED_CACHE_CONTROL : PREVIEW_CACHE_CONTROL);
  return response;
}


// cdn.files.gg/albums/download/<album vanity>.zip: "Download all", a store-mode ZIP streamed item
// by item (utils/zip.js).
async function serveAlbumZip(event, { vanity }) {
  const { data, response: error } = await lookupAlbum(event, vanity);
  if (error) {
    return error;
  }
  const plan = albumZipPlan(data);
  if (!plan.entries.length) {
    return cdnError(404, PROTECTED_CACHE_CONTROL);
  }
  if (plan.tooLarge) {
    return new Response(JSON.stringify({
      code: 'ZIP_TOO_LARGE',
      message: 'This album is too large to download as one ZIP',
      status: 413,
      limit: ZIP_LIMIT,
    }), { status: 413, headers: { 'Content-Type': 'application/json', 'Cache-Control': PROTECTED_CACHE_CONTROL } });
  }

  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', zipFilename(data.album)),
    'Cache-Control': PROTECTED_CACHE_CONTROL,
  });
  const length = (plan.total === null) ? null : zipSize(plan.entries);
  if (event.method === 'HEAD') {
    if (length !== null) {
      headers.set('Content-Length', String(length));
    }
    return new Response(null, { status: 200, headers });
  }

  // Items are read with a plain GET (no Range, no validators), one at a time as the client reads.
  const plainGet = { method: 'GET', headers: new Headers() };
  const entries = plan.entries.map((entry) => ({
    name: entry.name,
    size: entry.size ?? undefined,
    date: entry.date,
    open: async () => {
      const response = await fetchBlob({
        env: event.environment,
        request: plainGet,
        storage: entry.storage,
        waitUntil: waitUntilFor(event),
        cacheWrite: false,
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {});
        console.error('album ZIP: item unreadable, aborting the stream', entry.id, response.status);
        throw new Error(`album ZIP item ${entry.id}: storage ${response.status}`);
      }
      return response.body;
    },
  }));

  let body = createZipStream(entries);
  if (length !== null && typeof(FixedLengthStream) === 'function') {
    // A known length, so browsers show real progress.
    body = body.pipeThrough(new FixedLengthStream(length));
  }
  return new Response(body, { status: 200, headers });
}


// Applied to every response on cdn.files.gg (including 404s, 405s and 500s) from index.js.
// `mainOrigin`: the MAIN_HOST origin allowed to frame it (https://files.gg by default).
export function applyCdnSecurityHeaders(response, { mainOrigin } = {}) {
  const headers = cdnSecurityHeaders({ mainOrigin });
  for (const name in headers) {
    response.headers.set(name, headers[name]);
  }
  return response;
}
