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


// A timestamp from a payload as ms epoch, or null. `seconds` says how a bare number is read:
// `expiresAt` is ms (web/README.md §3), `expires_at` is epoch seconds (contract §6).
function toMs(value, seconds) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof(value) === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    return Number.isFinite(number) ? (seconds ? number * 1000 : number) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function expiresAtMs(payload) {
  if (!payload) {
    return null;
  }
  if (payload.expiresAt !== undefined) {
    return toMs(payload.expiresAt, false);
  }
  return toMs(payload.expires_at, true);
}

export function isExpired(payload, nowMs) {
  const expiresAt = expiresAtMs(payload);
  return expiresAt !== null && expiresAt <= nowMs;
}

export function cdnUrlOf(file) {
  return (file && (file.cdnUrl || file.cdn_url || (file.urls && file.urls.cdn))) || null;
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

// Meta tags for a viewable file (web/README.md §5). og:* use property=. `mainOrigin` (MAIN_HOST)
// is where the default og:image lives.
export function fileMetaTags(file, { mainOrigin = DEFAULT_ORIGINS.main } = {}) {
  const cdnUrl = cdnUrlOf(file);
  const size = Number(file.size) || 0;
  const description = (size > 0) ? formatBytes(size, 2) : '0 B';
  const width = positive(file.width ?? (file.media && file.media.width));
  const height = positive(file.height ?? (file.media && file.media.height));
  const thumbnail = (file.thumbnail && file.thumbnail.url) ? file.thumbnail : null;

  const tags = [
    ['description', description],
    ['og:site_name', 'files.gg'],
    ['og:title', file.filename],
    ['og:description', description],
    ['og:url', file.url],
  ];

  switch (file.kind) {
    case 'image': {
      tags.push(
        ['og:type', 'article'],
        ['og:image', cdnUrl],
        ['og:image:type', file.mimetype],
        ['og:image:width', width],
        ['og:image:height', height],
        ['og:image:alt', file.filename],
        ['twitter:card', 'summary_large_image'],
        ['twitter:image', cdnUrl],
        ['twitter:image:alt', file.filename],
      );
    }; break;
    case 'video': {
      const playable = !(file.media && file.media.playable === false);
      tags.push(['og:type', 'video.other']);
      if (playable) {
        tags.push(
          ['og:video', cdnUrl],
          ['og:video:type', file.mimetype],
          ['og:video:width', width],
          ['og:video:height', height],
        );
      }
      if (thumbnail) {
        tags.push(['og:image', thumbnail.url], ['og:image:width', positive(thumbnail.width)], ['og:image:height', positive(thumbnail.height)]);
      }
      tags.push(['twitter:card', playable ? 'player' : 'summary']);
      if (playable) {
        tags.push(['twitter:player', cdnUrl], ['twitter:player:width', width], ['twitter:player:height', height]);
      }
    }; break;
    case 'audio': {
      tags.push(
        ['og:type', 'music.song'],
        ['og:audio', cdnUrl],
        ['og:audio:type', file.mimetype],
      );
      if (thumbnail) {
        tags.push(['og:image', thumbnail.url], ['og:image:width', positive(thumbnail.width)], ['og:image:height', positive(thumbnail.height)]);
      }
      tags.push(['twitter:card', 'player'], ['twitter:player', cdnUrl]);
    }; break;
    default: {
      tags.push(['og:type', 'article']);
      if (thumbnail) {
        tags.push(['og:image', thumbnail.url], ['og:image:width', positive(thumbnail.width)], ['og:image:height', positive(thumbnail.height)]);
      } else {
        tags.push(...defaultImage(mainOrigin));
      }
      tags.push(['twitter:card', 'summary']);
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

export function albumMetaTags(album, count) {
  const title = `${(album.title || '').trim() || 'Untitled album'} · ${count} ${count === 1 ? 'file' : 'files'}`;
  const description = (album.description || '').trim().slice(0, 200) || title;
  const cover = (!album.nsfw && album.cover && album.cover.url) ? album.cover : null;
  return metaHtml([
    ['description', description],
    ['og:site_name', 'files.gg'],
    ['og:title', title],
    ['og:description', description],
    ['og:url', album.url],
    ['og:type', 'website'],
    ['og:image', cover && cover.url],
    ['og:image:width', cover && positive(cover.width)],
    ['og:image:height', cover && positive(cover.height)],
    ['twitter:card', cover ? 'summary_large_image' : 'summary'],
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
      const passwordExpiresAt = toMs(access.password_expires_at, true);
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


export function decideAlbumShell({ lookup, vanity, nowMs = Date.now() }) {
  const missing = { page: 'album', state: 'missing', status: 404 };
  if (lookup.status === 'unavailable') {
    return UNAVAILABLE('album');
  }
  if (lookup.status !== 'found' || !lookup.data || !lookup.data.album) {
    return missing;
  }

  const { album, access = {}, items_access: itemsAccess = {} } = lookup.data;
  if (isExpired(album, nowMs)) {
    return missing;
  }

  switch (access.visibility) {
    case 'link': {
      // Private items never appear to non-owners; expired items are gone.
      const items = (Array.isArray(album.items) ? album.items : []).filter((item) => {
        const itemAccess = item && item.id !== undefined ? itemsAccess[String(item.id)] : null;
        return item && !(itemAccess && itemAccess.visibility === 'private') && !isExpired(item, nowMs);
      });
      if (!items.length) {
        return missing;
      }
      const removed = (Array.isArray(album.items) ? album.items.length : 0) - items.length;
      const data = { ...album, items };
      if (removed > 0 && typeof(album.count) === 'number') {
        data.count = Math.max(items.length, album.count - removed);
      }
      const count = (typeof(data.count) === 'number') ? data.count : items.length;
      return { page: 'album', state: 'album', dataId: 'album-data', data, status: 200, meta: albumMetaTags(album, count) };
    }
    case 'password': {
      const data = { vanity: album.vanity || vanity, protected: 'password' };
      if (access.show_name_when_locked && album.title) {
        data.title = album.title;
      }
      return { page: 'album', state: 'locked', dataId: 'album-data', data, status: 200, meta: lockedMetaTags(LOCKED_ALBUM_TITLE) };
    }
    default:
      return missing;
  }
}


// files.gg paths that never go to the vanity lookup (web/README.md §1).
export const ROOT_FILES = Object.freeze([
  '/favicon.ico', '/favicon.svg', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png',
  '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png',
]);

// Old frontend (Mithril SPA) pages, still served by the legacy shell: login, register, email
// verification and password-reset links, legal pages and the old dashboard. All are reserved.
export const LEGACY_APP_PREFIXES = Object.freeze(['auth', 'dashboard', 'details', 'legal', 'options']);

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
  const first = pathname.split('/')[1];
  if (LEGACY_APP_PREFIXES.includes(first)) {
    return { route: 'legacy', section: first };
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
