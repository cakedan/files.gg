// cdn.files.gg (docs/redesign/contracts/milestone-3.md §3). Every URL it serves:
//
//   /files/<vanity>.<ext>                         the file itself
//   /previews/<kind>/<vanity>.<kind ext>?v=<ver>  a generated preview
//   /albums/collage/<album vanity>.webp?v=<ver>   an album's collage
//   /albums/download/<album vanity>.zip           an album's "Download all"
//   /.well-known/security.txt                     from web/dist (milestone-4.md §10.4)
//
// Anything else is 404. Password and private targets are served only through signed URLs
// (utils/signing.js), checked before any byte (or cached byte) is touched.
//
// Per request (milestone-4.md §10.2, milestone-6.md §10.8): parse → lookup (404 / 503) → staff
// grant → the owner's pending deletion (404) → access check (signature; a view-limited file always
// needs one, milestone-6.md §19.5) → domain-only (a `link`
// file of an owner whose domain-only mode is in effect needs a signature too, else 404) → safety
// state → serve. Access comes before the state, so a protected file's state never leaks to someone
// without access.
//
// The same paths are served on custom domains (domains/custom.js, milestone-6.md §10.8), with a
// `site` of { kind: 'custom', domain }: there the content must be allowed by the domain's scope
// (else 404), a pending deletion is 404, `staff=` is never accepted (401 for password targets, 404
// otherwise), and domain-only doesn't apply.

import { ApiError, DomainRouter } from 'cf-worker-router';

import { internalLookup } from './internal.js';
import { serveSecurityTxt } from '../shell.js';
import { fetchBlob } from '../storage.js';
import { getStringBinding } from '../utils/env.js';
import { DEFAULT_HOSTS, hostPattern } from '../utils/hosts.js';
import { domainAllows, ownerPendingDeletion, servedOnCustom } from '../utils/owners.js';
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
import { albumSafety, cdnStateStatus, fileSafety, pendingCount, servesInline } from '../utils/safety.js';
import { albumGrant, grantForFileRequest, verifySignedUrl, verifyStaffUrl } from '../utils/signing.js';
import { isExpired, SECURITY_TXT_PATH, visibleAlbumItems } from '../utils/viewer.js';
import { isViewLimited } from '../utils/viewlimits.js';
import { createZipStream, zipSize } from '../utils/zip.js';


export const CDN_HOSTNAME = DEFAULT_HOSTS.cdn;

// Public (`link`) files themselves.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=3600';
// Anything served through a signed URL, and every error about a protected target.
export const PROTECTED_CACHE_CONTROL = 'private, no-store';
// Previews and collages of `link` files and albums: the URL carries ?v=, which changes when they
// are regenerated (contract §3).
export const PREVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// The same, requested without the current ?v= (or with a stale or made-up one): short-lived, so a
// re-derive or a removal isn't pinned for a year in browsers and shared caches.
export const PREVIEW_UNVERSIONED_CACHE_CONTROL = 'public, max-age=300';

function previewCacheControl(isProtected, query, version) {
  if (isProtected) {
    return PROTECTED_CACHE_CONTROL;
  }
  const given = query.get('v');
  return (version !== null && version !== undefined && given !== null && given === String(version))
    ? PREVIEW_CACHE_CONTROL : PREVIEW_UNVERSIONED_CACHE_CONTROL;
}

const METHODS = ['GET', 'HEAD', 'OPTIONS'];

// The CDN_HOST router (cdn.files.gg by default); `hosts` is utils/hosts.js getHosts(env). One
// catch-all route: the paths are parsed here, not by the router, so a malformed escape is a 404
// rather than a router error, and anything unknown is a 404 (POST and friends: 405).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.cdn));
  router.route('/*', METHODS, serveCdn);
  return router;
}


const CDN_SITE = Object.freeze({ kind: 'cdn' });

function serveCdn(event) {
  return serveCdnPath(event, CDN_SITE);
}

// cdn.files.gg (`site.kind: 'cdn'`) or a custom domain's byte paths (`site`: { kind: 'custom',
// domain }, the domain lookup). Methods are GET, HEAD and OPTIONS.
export function serveCdnPath(event, site) {
  const pathname = event.url.pathname;
  const route = routeFor(pathname, site);
  if (!route) {
    return cdnError(404);
  }
  if (event.method === 'OPTIONS') {
    // CORS preflight: index.js (or domains/custom.js) adds the headers. Nothing is looked up.
    return new Response(null, { status: 204 });
  }
  return route.handler(event, route.parsed, site);
}

function routeFor(pathname, site) {
  if (pathname === SECURITY_TXT_PATH && site.kind === 'cdn') {
    return { handler: serveCdnSecurityTxt, parsed: null };
  }
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
// grant of an album the file is shown in (contract §3). A view-limited file (milestone-6.md §19.5)
// is served like a protected one whatever its visibility: only through a signed URL (its albums list
// is empty, since a view-limited file is never an album item), else 404 (401 for a password file).
async function checkFileAccess(event, data, access) {
  if (access.visibility === 'link' && !isViewLimited(data)) {
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


// A staff URL (milestone-4.md §10.3) for this path and the lookup's file. Only checked when the
// request has `staff=`; an invalid one then falls through to the access check like any other bad
// signature (401 for password files, 404 for private ones, ignored for link files).
async function isStaffRequest(event, data) {
  if (!event.url.searchParams.has('staff')) {
    return false;
  }
  return await verifyStaffUrl({
    secret: getStringBinding(event.environment, 'CDN_SIGNING_SECRET'),
    path: event.url.pathname,
    query: event.url.searchParams,
    fileId: data.file.id,
  });
}

// Everything between the lookup and the bytes, for a file and its previews: a valid staff URL
// skips the access and safety checks (cdn.files.gg only); otherwise the owner checks, the access
// check, domain-only, then the safety state. Returns { response } (the refusal) or
// { staff, isProtected } (`isProtected`: private, no-store).
async function checkFile(event, data, access, site) {
  if (site.kind === 'custom') {
    // milestone-6.md §10.8 steps 4-5: another owner's file on an `own` domain, or a pending
    // deletion, is missing; §10.9: staff URLs work only on cdn.files.gg, so `staff=` here is a bad
    // signature, whatever the rest of the URL says.
    if (!domainAllows(site.domain, data) || ownerPendingDeletion(data)) {
      return { response: cdnError(404, PROTECTED_CACHE_CONTROL) };
    }
    if (event.url.searchParams.has('staff')) {
      return { response: denied(access) };
    }
  } else {
    if (await isStaffRequest(event, data)) {
      return { staff: true, isProtected: true };
    }
    if (ownerPendingDeletion(data)) {
      // Missing, never "removed", even with a file or album signature (milestone-6.md §8.8).
      return { response: cdnError(404, PROTECTED_CACHE_CONTROL) };
    }
  }
  const refusal = await checkFileAccess(event, data, access);
  if (refusal) {
    return { response: refusal };
  }
  let signedOnly = false;
  if (site.kind === 'cdn' && access.visibility === 'link' && servedOnCustom(data)) {
    // Domain-only (milestone-6.md §10.6): a `link` file is served on cdn.files.gg only through a URL
    // signed with its file grant or an album grant (owner payloads), else it's missing. Password
    // and private files were refused above without a signature (401 / 404, §16.10).
    if (!(await verify(event, grantForFileRequest(data, event.url.searchParams)))) {
      return { response: cdnError(404, PROTECTED_CACHE_CONTROL) };
    }
    signedOnly = true;
  }
  const status = cdnStateStatus(fileSafety(data).state);
  if (status) {
    return { response: cdnError(status, PROTECTED_CACHE_CONTROL) };
  }
  return { staff: false, isProtected: access.visibility !== 'link' || signedOnly || isViewLimited(data) };
}


// cdn.files.gg/files/<vanity>[.<anything>], multi-segment vanities included.
async function serveFile(event, { vanity }, site) {
  const { data, access, response: error } = await lookupFile(event, vanity);
  if (error) {
    return error;
  }

  const { staff, isProtected, response: refusal } = await checkFile(event, data, access, site);
  if (refusal) {
    return refusal;
  }

  const response = await fetchBlob({
    env: event.environment,
    request: event.originalRequest,
    storage: data.storage,
    waitUntil: waitUntilFor(event),
    // Staff views are never edge-cached (milestone-4.md §10.3).
    cacheWrite: !staff,
  });
  if (!(response.ok || response.status === 304)) {
    return storageError(response, isProtected);
  }
  if (response.ok) {
    const decision = decideCdnResponse({
      filename: data.file.filename,
      mimetype: data.file.mimetype,
      query: event.url.searchParams,
      // `serve_inline: false` (milestone-4.md §2.3): attachment only, staff URLs included.
      inline: servesInline(data),
    });
    response.headers.set('content-disposition', decision.contentDisposition);
    response.headers.set('content-type', decision.contentType);
  }
  response.headers.set('cache-control', isProtected ? PROTECTED_CACHE_CONTROL : PUBLIC_CACHE_CONTROL);
  return response;
}


// cdn.files.gg/previews/<kind>/<vanity>.<ext>: a preview, with exactly the file's access rules,
// from the vanity lookup's `previews` map (contract §5).
async function servePreview(event, { kind, vanity }, site) {
  const { data, access, response: error } = await lookupFile(event, vanity);
  if (error) {
    return error;
  }

  // Access and state first, so a protected file never says which previews it has.
  const { staff, isProtected, response: refusal } = await checkFile(event, data, access, site);
  if (refusal) {
    return refusal;
  }

  // A download-only file's previews aren't served, whatever the type (milestone-4.md §10.2).
  const previews = (servesInline(data) && data.previews && typeof(data.previews) === 'object') ? data.previews : {};
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
    cacheWrite: !staff,
  });
  if (!(response.ok || response.status === 304)) {
    return storageError(response, isProtected);
  }
  if (response.ok) {
    response.headers.set('content-type', previewContentType(kind, row));
    response.headers.set('content-disposition', 'inline');
  }
  response.headers.set('cache-control', previewCacheControl(isProtected, event.url.searchParams, data.previews_version ?? null));
  return response;
}


// The album lookup for an album resource, after the owner checks (as for files; albums have no
// staff grant), its access check (a URL signed with the album grant, without `album=`),
// domain-only on cdn.files.gg, and its state (milestone-4.md §10.2: hidden or removed is 410), as
// { data, isProtected } or { response }. An album with nothing to show is missing (contract §4).
async function lookupAlbum(event, vanity, site) {
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
  if ((site.kind === 'custom' && !domainAllows(site.domain, data)) || ownerPendingDeletion(data)) {
    return { response: cdnError(404, PROTECTED_CACHE_CONTROL) };
  }
  if (site.kind === 'custom' && event.url.searchParams.has('staff')) {
    return { response: denied(access) };
  }

  const isProtected = access.visibility !== 'link';
  const grant = albumGrant(album.id, access.access_version);
  if (isProtected && !(await verify(event, grant))) {
    return { response: denied(access) };
  }
  let signedOnly = false;
  if (site.kind === 'cdn' && !isProtected && servedOnCustom(data)) {
    // Domain-only (milestone-6.md §10.6): only through a URL signed with the album grant.
    if (!(await verify(event, grant))) {
      return { response: cdnError(404, PROTECTED_CACHE_CONTROL) };
    }
    signedOnly = true;
  }
  const safety = albumSafety(data);
  if (safety.state !== 'ok') {
    // Hidden or removed: 410. A lookup without a known state fails closed like a pending file.
    return { response: cdnError(cdnStateStatus(safety.state), PROTECTED_CACHE_CONTROL) };
  }
  if (!visibleAlbumItems(data).length) {
    // Nothing shown (yet, when items are still being checked).
    const pending = pendingCount(data) > 0;
    return { response: cdnError(404, (isProtected || pending) ? PROTECTED_CACHE_CONTROL : null) };
  }
  return { data, isProtected: isProtected || signedOnly };
}


// cdn.files.gg/albums/collage/<album vanity>.webp
async function serveAlbumCollage(event, { vanity }, site) {
  const { data, isProtected, response: error } = await lookupAlbum(event, vanity, site);
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
  response.headers.set('cache-control', previewCacheControl(isProtected, event.url.searchParams, collage.version ?? null));
  return response;
}


// cdn.files.gg/albums/download/<album vanity>.zip: "Download all", a store-mode ZIP streamed item
// by item (utils/zip.js).
async function serveAlbumZip(event, { vanity }, site) {
  const { data, response: error } = await lookupAlbum(event, vanity, site);
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


// cdn.files.gg/.well-known/security.txt, the one path the CDN serves that isn't a file
// (milestone-4.md §10.4). index.js adds the CDN security headers.
async function serveCdnSecurityTxt(event) {
  return (await serveSecurityTxt(event)) || cdnError(404);
}


// Applied to every response on cdn.files.gg (including 404s, 405s and 500s) from index.js, and to
// every byte-path response on a custom domain from domains/custom.js.
// `mainOrigin`: the MAIN_HOST origin allowed to frame it (https://files.gg by default).
export function applyCdnSecurityHeaders(response, { mainOrigin } = {}) {
  const headers = cdnSecurityHeaders({ mainOrigin });
  for (const name in headers) {
    response.headers.set(name, headers[name]);
  }
  return response;
}
