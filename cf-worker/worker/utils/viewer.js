// The new viewer shell (web/README.md "Worker contract", docs/redesign/contracts/milestone-2.md §4).
// Pure decisions: which #root state, which boot JSON, which meta tags and which HTTP status.
// worker/shell.js applies them to web/dist/viewer.html with HTMLRewriter.

import { DEFAULT_ORIGINS } from './hosts.js';
import { element } from './html.js';
import { shouldRedirectToCdn } from './pages.js';
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

export const LOCKED_FILE_TITLE = 'Password-protected file · files.gg';
export const LOCKED_ALBUM_TITLE = 'Password-protected album · files.gg';


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

// Contract §4: generic tags, no name, no image and no video.
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
  const nsfw = album.nsfw === true || items.some((item) => item && item.nsfw === true);
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


// `lookup` is the internal lookup: { status: 'found', data } | { status: 'missing' } |
// { status: 'unavailable' }. `vanity` is the one from the path. Returns the shell to render, or
// { redirect } for bots and embeds of `link` files (never for password or private files).
export function decideFileShell({ lookup, vanity, headers, nowMs = Date.now(), mainOrigin = DEFAULT_ORIGINS.main }) {
  const missing = { page: 'file', state: 'missing', dataId: 'file-data', data: null, status: 404 };
  if (lookup.status === 'unavailable') {
    return UNAVAILABLE('file');
  }
  if (lookup.status !== 'found' || !lookup.data || !lookup.data.file) {
    return missing;
  }

  const { file, access = {} } = lookup.data;
  if (isExpired(file, nowMs)) {
    return missing;
  }

  switch (access.visibility) {
    case 'link': {
      const cdnUrl = cdnUrlOf(file);
      if (cdnUrl && file.mimetype && shouldRedirectToCdn(headers, file)) {
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
    default:
      // `private`, and anything unknown: fail closed. An owner pass (#t=) is handled by the client.
      return missing;
  }
}


// An item's own visibility: items_access first (the API's access block), then the payload's.
function itemVisibility(item, itemsAccess) {
  const access = (item && item.id !== undefined && item.id !== null) ? itemsAccess[String(item.id)] : null;
  return (access && access.visibility) || (item && item.visibility) || null;
}

function positionOf(item, index) {
  const position = Number(item.position);
  return Number.isFinite(position) ? position : index;
}

// Contract §4 "Which items an album shows": never expired items; in a `link` album only items
// whose own visibility is `link` (unknown fails closed); in a `password` or `private` album every
// item. The API already filters; this is the Worker's own guard. Returns items in album order.
export function visibleAlbumItems(data, nowMs = Date.now()) {
  const album = (data && data.album) || {};
  const access = (data && data.access) || {};
  const itemsAccess = (data && data.items_access && typeof(data.items_access) === 'object') ? data.items_access : {};
  const items = Array.isArray(album.items) ? album.items : [];
  const linkAlbum = access.visibility === 'link';
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && typeof(item) === 'object' && !isExpired(item, nowMs)
      && (!linkAlbum || itemVisibility(item, itemsAccess) === 'link'))
    .sort((a, b) => (positionOf(a.item, a.index) - positionOf(b.item, b.index)) || (a.index - b.index))
    .map(({ item }) => item);
}


export function decideAlbumShell({ lookup, vanity, nowMs = Date.now() }) {
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

  switch (access.visibility) {
    case 'link': {
      const items = visibleAlbumItems(lookup.data, nowMs);
      if (!items.length) {
        return missing;
      }
      const removed = (Array.isArray(album.items) ? album.items.length : 0) - items.length;
      const data = { ...album, items };
      if (removed > 0 && typeof(album.count) === 'number') {
        data.count = Math.max(items.length, album.count - removed);
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
    default:
      // `private` (an owner pass is handled by the client) and anything unknown: fail closed.
      return missing;
  }
}


// files.gg paths that never go to the vanity lookup (web/README.md §1).
export const ROOT_FILES = Object.freeze([
  '/favicon.ico', '/favicon.svg', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png',
  '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png',
]);

// Classifies a files.gg path, in web/README.md §1 order.
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
  const album = pathname.match(/^\/a\/([^/]+)(?:\/(\d+))?\/?$/);
  if (album) {
    return { route: 'album', vanity: safeDecode(album[1]) };
  }
  // `<vanity>` and `<vanity>.<anything>`, multi-segment vanities included (PLAN.md §1.4 item 1).
  const vanity = safeDecode(pathname.slice(1).replace(/\/+$/, '')).split('.').shift();
  return vanity ? { route: 'file', vanity } : { route: 'home' };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
