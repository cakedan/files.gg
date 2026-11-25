// The new viewer shell (web/README.md "Worker contract", docs/redesign/contracts/milestone-2.md §4,
// milestone-4.md §10.1). Pure decisions: which #root state, which boot JSON, which meta tags and
// which HTTP status. worker/shell.js applies them to web/dist/viewer.html with HTMLRewriter.

import { DEFAULT_ORIGINS } from './hosts.js';
import { element } from './html.js';
import { domainAllows, ownerPendingDeletion, servedOnCustom } from './owners.js';
import { shouldRedirectToCdn } from './pages.js';
import { albumSafety, fileSafety, itemShowable, pendingCount, servesInline } from './safety.js';
import { formatBytes } from './tools.js';


// web/README.md §6, plus Turnstile (the lock screen) and the API (unlock, refresh). `origins` is
// utils/hosts.js publicOrigins(): the CDN_HOST and API_HOST origins (cdn/api.files.gg by default).
export function viewerCsp(origins = DEFAULT_ORIGINS) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
    "worker-src 'self'",
    `connect-src 'self' ${origins.cdn} ${origins.api}`,
    `img-src 'self' ${origins.cdn} blob: data:`,
    `media-src 'self' ${origins.cdn} blob: data:`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    'frame-src https://challenges.cloudflare.com',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const VIEWER_CSP = viewerCsp();

// The viewer on a custom domain (milestone-6.md §10.11): its own origin is 'self', it calls the
// API and the CDN cross-origin, and Turnstile runs in the files.gg/challenge frame, so it needs no
// Turnstile script, only frame-src for MAIN_HOST. `origins` is utils/hosts.js publicOrigins().
export function customViewerCsp(origins = DEFAULT_ORIGINS) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src 'self' ${origins.api} ${origins.cdn}`,
    `img-src 'self' ${origins.cdn} blob: data:`,
    `media-src 'self' ${origins.cdn} blob: data:`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `frame-src ${origins.main}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// files.gg/challenge, the Turnstile frame for custom domains (milestone-6.md §10.10), framable only
// by that one custom origin.
export function challengeCsp(frameAncestor) {
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    'frame-src https://challenges.cloudflare.com',
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestor}`,
  ].join('; ');
}

export const LOCKED_FILE_TITLE = 'Password-protected file · files.gg';
export const LOCKED_ALBUM_TITLE = 'Password-protected album · files.gg';
export const PENDING_FILE_TITLE = 'Checking this file · files.gg';
export const PENDING_ALBUM_TITLE = 'Checking this album · files.gg';
export const REMOVED_FILE_TITLE = 'This file was removed · files.gg';
export const REMOVED_ALBUM_TITLE = 'This album was removed · files.gg';

// Cache-Control for the scanning shells (milestone-4.md §10.1): `pending` changes within seconds
// and must never be kept; `removed` is revalidated like every other page.
export const PENDING_CACHE_CONTROL = 'private, no-store';


// JSON safe to inline in <script type="application/json">: <, >, &, U+2028 and U+2029 become
// \uXXXX escapes, so user input can never close the tag. The result is still valid JSON.
export function escapeJsonForHtml(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}


// A payload timestamp (epoch seconds, contract §4) as ms epoch, or null. An ISO string is read
// too.
function secondsToMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof(value) === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    return Number.isFinite(number) ? number * 1000 : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function expiresAtMs(payload) {
  return payload ? secondsToMs(payload.expires_at) : null;
}

export function isExpired(payload, nowMs) {
  const expiresAt = expiresAtMs(payload);
  return expiresAt !== null && expiresAt <= nowMs;
}

export function cdnUrlOf(file) {
  return (file && typeof(file.cdn_url) === 'string' && file.cdn_url) || null;
}


function metaHtml(tags) {
  let html = '';
  for (const [name, content] of tags) {
    if (content === null || content === undefined || content === '') {
      continue;
    }
    const key = name.startsWith('og:') ? 'property' : 'name';
    html += element('meta', { [key]: name, content });
  }
  return html;
}

function positive(value) {
  const number = Number(value);
  return (Number.isFinite(number) && number > 0) ? Math.round(number) : null;
}

const defaultImage = (mainOrigin) => [
  ['og:image', `${mainOrigin}/og-image.png`],
  ['og:image:width', 1200],
  ['og:image:height', 630],
];

const SENSITIVE_DESCRIPTION = 'Sensitive content';

function imageTags(image, { type, alt } = {}) {
  return [
    ['og:image', image.url],
    ['og:image:type', type],
    ['og:image:width', positive(image.width)],
    ['og:image:height', positive(image.height)],
    ['og:image:alt', alt],
  ];
}

function asset(file, key) {
  const value = file.assets && file.assets[key];
  return (value && typeof(value) === 'object' && value.url) ? value : null;
}

// The preview an embed shows for a file that isn't itself an image (contract §4, PLAN.md
// "Embeds"): video poster, audio cover or waveform, PDF first page, else the file's thumbnail.
// URLs are used exactly as the API wrote them (`assets.<kind>.url`).
export function embedImage(file) {
  const thumbnail = (file.thumbnail && file.thumbnail.url) ? file.thumbnail : null;
  switch (file.kind) {
    case 'video': return asset(file, 'poster') || thumbnail;
    case 'audio': return asset(file, 'cover') || asset(file, 'waveform') || thumbnail;
    case 'pdf': return asset(file, 'thumb-2x') || asset(file, 'thumb') || thumbnail;
    default: return thumbnail;
  }
}

// Meta tags for a viewable file (web/README.md §5). og:* use property=. `mainOrigin` (MAIN_HOST)
// is where the default og:image lives. `nsfw: true` gets no image, video or audio at all.
export function fileMetaTags(file, { mainOrigin = DEFAULT_ORIGINS.main } = {}) {
  const cdnUrl = cdnUrlOf(file);
  const size = Number(file.size) || 0;
  const sizeText = (size > 0) ? formatBytes(size, 2) : '0 B';
  const description = (file.nsfw === true) ? `${SENSITIVE_DESCRIPTION} · ${sizeText}` : sizeText;
  const width = positive(file.width ?? (file.media && file.media.width));
  const height = positive(file.height ?? (file.media && file.media.height));

  const tags = [
    ['description', description],
    ['og:site_name', 'files.gg'],
    ['og:title', file.filename],
    ['og:description', description],
    ['og:url', file.url],
  ];

  if (file.nsfw === true) {
    tags.push(['og:type', 'article'], ['twitter:card', 'summary']);
    return metaHtml(tags);
  }

  switch (file.kind) {
    case 'image': {
      // A non-browser image (HEIC, TIFF, PSD...) is `image` only with a `display` preview, and
      // embeds that.
      const display = asset(file, 'display');
      const image = display || { url: cdnUrl, width, height };
      tags.push(
        ['og:type', 'article'],
        ...imageTags(image, { type: display ? 'image/webp' : file.mimetype, alt: file.filename }),
        ['twitter:card', 'summary_large_image'],
        ['twitter:image', image.url],
        ['twitter:image:alt', file.filename],
      );
    }; break;
    case 'video': {
      const playable = !(file.media && file.media.playable === false);
      const poster = embedImage(file);
      tags.push(['og:type', 'video.other']);
      if (poster) {
        tags.push(...imageTags(poster));
      }
      if (playable) {
        tags.push(
          ['og:video', cdnUrl],
          ['og:video:type', file.mimetype],
          ['og:video:width', width],
          ['og:video:height', height],
        );
      }
      tags.push(['twitter:card', playable ? 'player' : (poster ? 'summary_large_image' : 'summary')]);
      if (playable) {
        tags.push(['twitter:player', cdnUrl], ['twitter:player:width', width], ['twitter:player:height', height]);
      }
      if (poster) {
        tags.push(['twitter:image', poster.url]);
      }
    }; break;
    case 'audio': {
      const art = embedImage(file);
      tags.push(
        ['og:type', 'music.song'],
        ['og:audio', cdnUrl],
        ['og:audio:type', file.mimetype],
      );
      if (art) {
        tags.push(...imageTags(art));
      }
      tags.push(['twitter:card', 'player'], ['twitter:player', cdnUrl]);
      if (art) {
        tags.push(['twitter:image', art.url]);
      }
    }; break;
    default: {
      const image = embedImage(file);
      tags.push(['og:type', 'article']);
      tags.push(...(image ? imageTags(image) : defaultImage(mainOrigin)));
      tags.push(['twitter:card', 'summary']);
      if (image) {
        tags.push(['twitter:image', image.url]);
      }
    }
  }
  return metaHtml(tags);
}

// Contract §4: generic tags, no name, no image and no video. Also the `pending` and `removed`
// shells (milestone-4.md §10.1), with their own titles.
export function lockedMetaTags(title = LOCKED_FILE_TITLE) {
  return metaHtml([
    ['description', title],
    ['og:site_name', 'files.gg'],
    ['og:title', title],
    ['og:type', 'website'],
    ['twitter:card', 'summary'],
  ]);
}

function isAudioAlbum(items) {
  return items.length > 0 && items.every((item) => item.kind === 'audio');
}

function imageOf(value) {
  return (value && typeof(value) === 'object' && value.url) ? value : null;
}

// web/README.md §5, PLAN.md "Albums" > "Embeds": og:title "<Title> · N files", og:image the
// collage (an audio album uses its cover art; without a collage, the cover). An NSFW album, or one
// with an NSFW item, gets no image. `items` are the shown items.
export function albumMetaTags(album, count, items = []) {
  const audio = isAudioAlbum(items);
  const tagAlbum = audio && items[0].media && items[0].media.tags && items[0].media.tags.album;
  const name = (album.title || '').trim() || (typeof(tagAlbum) === 'string' && tagAlbum.trim()) || 'Untitled album';
  const title = `${name} · ${count} ${count === 1 ? 'file' : 'files'}`;
  const description = (album.description || '').trim().slice(0, 200) || title;
  const nsfw = albumIsNsfw(album, items);
  const collage = imageOf(album.collage);
  const cover = imageOf(album.cover);
  const image = nsfw ? null : (audio ? (cover || collage) : (collage || cover));
  return metaHtml([
    ['description', description],
    ['og:site_name', 'files.gg'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', album.url],
    ['og:type', audio ? 'music.album' : 'website'],
    ...(image ? imageTags(image, { alt: name }) : []),
    ['twitter:card', image ? 'summary_large_image' : 'summary'],
    ['twitter:image', image && image.url],
  ]);
}


const UNAVAILABLE = (page) => ({ page, state: 'unavailable', status: 503, cacheControl: 'private, no-store' });


// The `pending` and `removed` shells (milestone-4.md §10.1): the vanity and the state only, never
// the name or anything else from the payload. `page` is 'file' or 'album'.
export function pendingShell(page, vanity) {
  return {
    page, state: 'pending', dataId: `${page}-data`, data: { vanity, pending: true }, status: 200,
    cacheControl: PENDING_CACHE_CONTROL,
    meta: lockedMetaTags(page === 'album' ? PENDING_ALBUM_TITLE : PENDING_FILE_TITLE),
  };
}

export function removedShell(page, vanity, reason) {
  return {
    page, state: 'removed', dataId: `${page}-data`, data: { vanity, removed: reason }, status: 410,
    cacheControl: 'no-cache',
    meta: lockedMetaTags(page === 'album' ? REMOVED_ALBUM_TITLE : REMOVED_FILE_TITLE),
  };
}

// A file served download-only (`serve_inline: false`, milestone-4.md §2.3) is `kind: "file"`, and
// its previews aren't served, so their URLs are dropped. The API already does this; this is the
// Worker's own guard.
function downloadOnly(file) {
  const { assets, thumbnail, hover_url: hoverUrl, ...rest } = file;
  return { ...rest, kind: 'file' };
}

// milestone-6.md §8.8, §10.6, §10.8: whether a found file or album must look missing because of its
// owner. On a custom domain (`domain` is its lookup) the content must be the domain owner's unless
// the domain's scope is `any`; `served_on` is ignored there (a domain-only owner's content is meant
// to be on their domain). On files.gg, domain-only content is missing. A pending deletion is
// missing everywhere.
export function hiddenByOwner(data, domain = null) {
  if (domain && !domainAllows(domain, data)) {
    return true;
  }
  if (ownerPendingDeletion(data)) {
    return true;
  }
  return !domain && servedOnCustom(data);
}

// `lookup` is the internal lookup: { status: 'found', data } | { status: 'missing' } |
// { status: 'unavailable' }. `vanity` is the one from the path. Returns the shell to render, or
// { redirect } for bots and embeds of `ok`, non-NSFW `link` files (never for password or private
// files). Decision order is milestone-4.md §10.1's, first match wins, with milestone-6.md §10.8's
// owner steps after "blocked". `domain`: the custom domain's lookup on a custom host, else null.
export function decideFileShell({ lookup, vanity, headers, nowMs = Date.now(), mainOrigin = DEFAULT_ORIGINS.main, domain = null }) {
  const missing = { page: 'file', state: 'missing', dataId: 'file-data', data: null, status: 404 };
  if (lookup.status === 'unavailable') {
    return UNAVAILABLE('file');
  }
  if (lookup.status !== 'found' || !lookup.data || !lookup.data.file) {
    return missing;
  }

  const { access = {} } = lookup.data;
  let { file } = lookup.data;
  if (isExpired(file, nowMs)) {
    return missing;
  }

  const safety = fileSafety(lookup.data);
  if (safety.state === 'blocked') {
    // Blocked content looks exactly like a missing file.
    return missing;
  }
  if (hiddenByOwner(lookup.data, domain)) {
    // Another owner's file on an `own` domain, a pending deletion, or domain-only on files.gg:
    // exactly like a missing file, never "removed".
    return missing;
  }
  if (access.visibility !== 'link' && access.visibility !== 'password') {
    // `private`, and anything unknown: fail closed, whatever its state. An owner pass (#t=) is
    // handled by the client.
    return missing;
  }
  const shownVanity = file.vanity || vanity;
  if (safety.state === 'pending') {
    return pendingShell('file', shownVanity);
  }
  if (safety.state === 'hidden' || safety.state === 'removed') {
    return removedShell('file', shownVanity, safety.reason);
  }

  if (!servesInline(lookup.data)) {
    file = downloadOnly(file);
  }
  switch (access.visibility) {
    case 'link': {
      // NSFW files never redirect, for any user agent: the page's text card is all an embed gets
      // (milestone-4.md §4.6).
      const cdnUrl = cdnUrlOf(file);
      if (cdnUrl && file.mimetype && file.nsfw !== true && shouldRedirectToCdn(headers, file)) {
        return { redirect: cdnUrl };
      }
      return { page: 'file', state: 'file', dataId: 'file-data', data: file, status: 200, meta: fileMetaTags(file, { mainOrigin }) };
    }
    case 'password': {
      const data = { vanity: file.vanity || vanity, protected: 'password' };
      if (access.show_name_when_locked && file.filename) {
        data.filename = file.filename;
      }
      const passwordExpiresAt = secondsToMs(access.password_expires_at);
      if (passwordExpiresAt !== null && passwordExpiresAt <= nowMs) {
        data.password_expired = true;
      }
      return { page: 'file', state: 'locked', dataId: 'file-data', data, status: 200, meta: lockedMetaTags(LOCKED_FILE_TITLE) };
    }
  }
  return missing;
}


function itemAccessOf(item, itemsAccess) {
  const id = (item && item.id !== undefined && item.id !== null) ? String(item.id) : null;
  return (id !== null && Object.hasOwn(itemsAccess, id)) ? itemsAccess[id] : null;
}

// An item's own visibility: items_access first (the API's access block), then the payload's.
function itemVisibility(item, itemsAccess) {
  const access = itemAccessOf(item, itemsAccess);
  return (access && access.visibility) || (item && item.visibility) || null;
}

function positionOf(item, index) {
  const position = Number(item.position);
  return Number.isFinite(position) ? position : index;
}

// Contract §4 "Which items an album shows": never expired items; in a `link` album only items
// whose own visibility is `link` (unknown fails closed); in a `password` or `private` album every
// item; and never an item that carries a state other than ok (milestone-4.md §6.4). The API already
// filters; this is the Worker's own guard. Returns items in album order.
export function visibleAlbumItems(data, nowMs = Date.now()) {
  const album = (data && data.album) || {};
  const access = (data && data.access) || {};
  const itemsAccess = (data && data.items_access && typeof(data.items_access) === 'object') ? data.items_access : {};
  const items = Array.isArray(album.items) ? album.items : [];
  const linkAlbum = access.visibility === 'link';
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && typeof(item) === 'object' && !isExpired(item, nowMs)
      && (!linkAlbum || itemVisibility(item, itemsAccess) === 'link')
      && itemShowable(item, itemAccessOf(item, itemsAccess)))
    .sort((a, b) => (positionOf(a.item, a.index) - positionOf(b.item, b.index)) || (a.index - b.index))
    .map(({ item }) => item);
}


// milestone-4.md §4.4: an album is NSFW when it's marked, or any shown item is.
export function albumIsNsfw(album, items = []) {
  return (album && album.nsfw === true) || items.some((item) => item && item.nsfw === true);
}

// Decision order (milestone-4.md §10.1, as for files): unavailable; missing or expired; the owner
// steps of milestone-6.md §10.8 (`domain` as for files); private;
// hidden or removed; nothing shown yet with `pending_count > 0` (or no `safety` at all) is
// `pending`; password is locked; a link album with nothing shown is missing.
export function decideAlbumShell({ lookup, vanity, nowMs = Date.now(), domain = null }) {
  const missing = { page: 'album', state: 'missing', status: 404 };
  if (lookup.status === 'unavailable') {
    return UNAVAILABLE('album');
  }
  if (lookup.status !== 'found' || !lookup.data || !lookup.data.album) {
    return missing;
  }

  const { album, access = {} } = lookup.data;
  if (isExpired(album, nowMs)) {
    return missing;
  }
  if (hiddenByOwner(lookup.data, domain)) {
    return missing;
  }
  if (access.visibility !== 'link' && access.visibility !== 'password') {
    // `private` (an owner pass is handled by the client) and anything unknown: fail closed.
    return missing;
  }

  const shownVanity = album.vanity || vanity;
  const safety = albumSafety(lookup.data);
  if (safety.state === 'hidden' || safety.state === 'removed') {
    return removedShell('album', shownVanity, safety.reason);
  }
  const items = visibleAlbumItems(lookup.data, nowMs);
  if (safety.state === 'pending' || (!items.length && pendingCount(lookup.data) > 0)) {
    return pendingShell('album', shownVanity);
  }

  switch (access.visibility) {
    case 'link': {
      if (!items.length) {
        return missing;
      }
      const removed = (Array.isArray(album.items) ? album.items.length : 0) - items.length;
      const data = { ...album, items };
      if (removed > 0 && typeof(album.count) === 'number') {
        data.count = Math.max(items.length, album.count - removed);
      }
      if (albumIsNsfw(album, items)) {
        // A public NSFW album has no collage (milestone-4.md §4.6), and the flag covers its items.
        data.nsfw = true;
        delete data.collage;
      }
      const count = (typeof(data.count) === 'number') ? data.count : items.length;
      return { page: 'album', state: 'album', dataId: 'album-data', data, status: 200, meta: albumMetaTags(album, count, items) };
    }
    case 'password': {
      const data = { vanity: album.vanity || vanity, protected: 'password' };
      if (access.show_name_when_locked && album.title) {
        data.title = album.title;
      }
      return { page: 'album', state: 'locked', dataId: 'album-data', data, status: 200, meta: lockedMetaTags(LOCKED_ALBUM_TITLE) };
    }
  }
  return missing;
}


// files.gg paths that never go to the vanity lookup (web/README.md §1).
export const ROOT_FILES = Object.freeze([
  '/favicon.ico', '/favicon.svg', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png',
  '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png',
]);

// Served from web/dist on files.gg and cdn.files.gg (milestone-4.md §10.4).
export const SECURITY_TXT_PATH = '/.well-known/security.txt';
// `files.gg/<vanity>/report` (milestone-4.md §7.2): `report` is a reserved vanity segment (the
// API's `blacklisted_ids`, compared case-insensitively), so a path ending in `/report` is always a
// report page, and a vanity containing that segment can't exist.
export const REPORT_SEGMENT = 'report';

// Every reserved vanity segment the Worker knows (milestone-6.md §6.3 adds the auth pages, the
// challenge frame and the custom-domain byte paths `files`, `previews` and `albums`). A vanity
// containing one can't exist, so nothing is looked up for it.
export const RESERVED_SEGMENTS = Object.freeze([
  REPORT_SEGMENT, 'login', 'register', 'signup', 'challenge', 'files', 'previews', 'albums',
]);

export function hasReservedSegment(vanity) {
  return String(vanity).split('/').some((part) => RESERVED_SEGMENTS.includes(part.toLowerCase()));
}

// files.gg only (milestone-6.md §6.2): the old auth paths, now dashboard routes. 308, query kept.
export const AUTH_REDIRECTS = Object.freeze({
  '/login': '/app/login',
  '/login/': '/app/login',
  '/register': '/app/register',
  '/register/': '/app/register',
  '/signup': '/app/register',
  '/signup/': '/app/register',
});

// milestone-4.md §10.1's report routes, or null. A report route carries its `#report-data`.
export function classifyReportPath(pathname) {
  // 1. /report: the public form, which asks for a URL.
  if (pathname === '/report' || pathname === '/report/') {
    return { route: 'report', data: { type: 'any' } };
  }
  // 2. /a/<vanity>/report (and /a/<vanity>/<n>/report, which reports the album too: the Worker
  // never looks anything up for a report page, so it can't name the item's file).
  const albumReport = pathname.match(/^\/a\/([^/]+)(?:\/\d+)?\/report\/?$/);
  if (albumReport) {
    return { route: 'report', data: { type: 'album', vanity: safeDecode(albumReport[1]) } };
  }
  // 3. /<vanity>[.<ext>]/report: the vanity is everything before /report, minus any extension.
  const fileReport = pathname.match(/^\/(.+?)\/report\/?$/);
  if (fileReport) {
    const vanity = fileVanity(fileReport[1]);
    return { route: 'report', data: vanity ? { type: 'file', vanity } : { type: 'any' } };
  }
  return null;
}

// `/a/<vanity>[/<n>]` as { route: 'album', vanity }, then `/<vanity>[.<anything>]` as
// { route: 'file' | 'missing', vanity }, else { route: 'home' }.
export function classifyVanityPath(pathname) {
  const album = pathname.match(/^\/a\/([^/]+)(?:\/(\d+))?\/?$/);
  if (album) {
    return { route: 'album', vanity: safeDecode(album[1]) };
  }
  // `<vanity>` and `<vanity>.<anything>`, multi-segment vanities included (PLAN.md §1.4 item 1).
  const vanity = fileVanity(pathname.slice(1).replace(/\/+$/, ''));
  if (!vanity) {
    return { route: 'home' };
  }
  // No vanity can contain a reserved segment, so nothing is looked up.
  return hasReservedSegment(vanity) ? { route: 'missing', vanity } : { route: 'file', vanity };
}

// Classifies a files.gg path, in web/README.md §1 order, then the auth redirects and the challenge
// frame (milestone-6.md §6.2), then milestone-4.md §10.1's report routes and security.txt before
// the vanity lookup.
export function classifyStablePath(pathname) {
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return { route: 'api', path: pathname.slice(4) || '/' };
  }
  if (ROOT_FILES.includes(pathname)) {
    return { route: 'root-file' };
  }
  if (pathname.startsWith('/assets/')) {
    return { route: 'asset' };
  }
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    return { route: 'app' };
  }
  if (pathname === '/') {
    return { route: 'home' };
  }
  if (pathname === '/convert' || pathname === '/convert/') {
    return { route: 'convert' };
  }
  if (Object.hasOwn(AUTH_REDIRECTS, pathname)) {
    return { route: 'redirect', location: AUTH_REDIRECTS[pathname] };
  }
  if (pathname === '/challenge') {
    return { route: 'challenge' };
  }
  const report = classifyReportPath(pathname);
  if (report) {
    return report;
  }
  // 4. security.txt.
  if (pathname === SECURITY_TXT_PATH) {
    return { route: 'security-txt' };
  }
  return classifyVanityPath(pathname);
}

// A raw path after the leading `/` into the vanity: decoded, up to the first dot.
function fileVanity(raw) {
  return safeDecode(raw).split('.').shift();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
