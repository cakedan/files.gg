// cdn.files.gg paths (docs/redesign/contracts/milestone-3.md §3): files, previews, album collages
// and album ZIPs, all by vanity; the preview kinds; and the album ZIP plan (which items, in which
// order, under which names). Pure: no Worker globals, so it is unit-tested with `node --test`.

import { isExpired, visibleAlbumItems } from './viewer.js';
import { isForcedText, sanitizeFilename } from './security.js';
import { uniqueNames } from './zip.js';


// The fixed set of preview kinds (contract §3), each with its one extension and the type it is
// served with when the stored row has none. `document` (milestone-5.md §9.2: an Office document
// rendered to PDF for the viewer's pdf.js) is always served as `application/pdf`, whatever the row says.
export const PREVIEW_KINDS = Object.freeze({
  thumb: Object.freeze({ ext: 'webp', type: 'image/webp' }),
  'thumb-2x': Object.freeze({ ext: 'webp', type: 'image/webp' }),
  display: Object.freeze({ ext: 'webp', type: 'image/webp' }),
  poster: Object.freeze({ ext: 'webp', type: 'image/webp' }),
  cover: Object.freeze({ ext: 'webp', type: 'image/webp' }),
  waveform: Object.freeze({ ext: 'webp', type: 'image/webp' }),
  peaks: Object.freeze({ ext: 'json', type: 'application/json' }),
  hover: Object.freeze({ ext: 'mp4', type: 'video/mp4' }),
  document: Object.freeze({ ext: 'pdf', type: 'application/pdf', fixedType: true }),
});
// An album's own resources: `/albums/<resource>/<album vanity>.<ext>`.
export const ALBUM_RESOURCES = Object.freeze({
  collage: Object.freeze({ ext: 'webp' }),
  download: Object.freeze({ ext: 'zip' }),
});

// 2 GiB of item bytes; under it no ZIP64 is needed (contract §3).
export const ZIP_LIMIT = 2147483648;
// Each entry costs a cache read and a storage fetch (subrequests), so an album with more items
// than this is "too large" for one ZIP and gets the same per-item download panel.
export const ZIP_MAX_ENTRIES = 500;

// milestone-4.md §6.3, checked again here (fail closed): an item goes into a ZIP only with an
// `items_access` entry whose `safety` is ok (or flagged) and which hasn't expired. A missing entry
// or a missing `safety` is never treated as ok.
export function zippableItem(itemsAccess, id, nowMs = Date.now()) {
  const entry = itemsAccess && Object.hasOwn(itemsAccess, id) ? itemsAccess[id] : null;
  if (!entry || typeof(entry) !== 'object') {
    return false;
  }
  const safety = entry.safety;
  if (!safety || typeof(safety) !== 'object' || (safety.state !== 'ok' && safety.state !== 'flagged')) {
    return false;
  }
  return !isExpired(entry, nowMs);
}
// The internal lookup refuses anything longer.
const MAX_VANITY_LENGTH = 256;


function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

// A raw (percent-encoded) vanity path into the vanity, or null. Every segment must be non-empty
// and decode cleanly, and no decoded segment may hold a `/` or a `.`: vanities never contain dots
// (`files.gg/<vanity>.<ext>` splits at the first one), so `/previews/thumb/a.webp/b.webp` can't
// pass for vanity `a.webp/b`.
function parseVanity(raw, { multiSegment }) {
  if (!raw) {
    return null;
  }
  const segments = raw.split('/');
  if (!multiSegment && segments.length !== 1) {
    return null;
  }
  const decoded = [];
  for (const segment of segments) {
    const value = segment ? decodeSegment(segment) : null;
    if (!value || value.includes('/') || value.includes('.')) {
      return null;
    }
    decoded.push(value);
  }
  const vanity = decoded.join('/');
  return (vanity.length <= MAX_VANITY_LENGTH) ? vanity : null;
}

// `<prefix><vanity>.<ext>` with exactly that extension (case-sensitive).
function parseNamed(pathname, prefix, ext, options) {
  if (typeof(pathname) !== 'string' || !pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  const suffix = `.${ext}`;
  if (!rest.endsWith(suffix)) {
    return null;
  }
  return parseVanity(rest.slice(0, -suffix.length), options);
}


// `/files/<vanity>[.<anything>]`: the vanity is everything before the first dot, multi-segment
// vanities included. Returns { vanity } or null.
export function parseFilePath(pathname) {
  const prefix = '/files/';
  if (typeof(pathname) !== 'string' || !pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length).split('.')[0];
  const vanity = parseVanity(raw, { multiSegment: true });
  return vanity ? { vanity } : null;
}

// `/previews/<kind>/<vanity>.<kind ext>` (contract §3 "Parsing"): the kind is the first segment
// and must be in the set; everything after it, minus the kind's extension, is the vanity, so
// multi-segment vanities work and a vanity that happens to be `thumb` can't be misread. Returns
// { kind, vanity } or null.
export function parsePreviewPath(pathname) {
  const prefix = '/previews/';
  if (typeof(pathname) !== 'string' || !pathname.startsWith(prefix)) {
    return null;
  }
  const kind = pathname.slice(prefix.length).split('/')[0];
  if (!Object.hasOwn(PREVIEW_KINDS, kind)) {
    return null;
  }
  const vanity = parseNamed(pathname, `${prefix}${kind}/`, PREVIEW_KINDS[kind].ext, { multiSegment: true });
  return vanity ? { kind, vanity } : null;
}

// `/albums/collage/<album vanity>.webp` and `/albums/download/<album vanity>.zip`. Album vanities
// are one segment (`files.gg/a/<vanity>`). Returns { resource, vanity } or null.
export function parseAlbumPath(pathname) {
  const prefix = '/albums/';
  if (typeof(pathname) !== 'string' || !pathname.startsWith(prefix)) {
    return null;
  }
  const resource = pathname.slice(prefix.length).split('/')[0];
  if (!Object.hasOwn(ALBUM_RESOURCES, resource)) {
    return null;
  }
  const vanity = parseNamed(pathname, `${prefix}${resource}/`, ALBUM_RESOURCES[resource].ext, { multiSegment: false });
  return vanity ? { resource, vanity } : null;
}


// The type a preview is served with: the stored row's, unless it is missing or could render as a
// page, or the kind's type is fixed; then the fixed type for the kind.
export function previewContentType(kind, row) {
  if (Object.hasOwn(PREVIEW_KINDS, kind) && PREVIEW_KINDS[kind].fixedType) {
    return PREVIEW_KINDS[kind].type;
  }
  const type = row && typeof(row.content_type) === 'string' ? row.content_type.trim() : '';
  if (!type || isForcedText(type) || /^text\/html/i.test(type)) {
    return (Object.hasOwn(PREVIEW_KINDS, kind) && PREVIEW_KINDS[kind].type) || 'application/octet-stream';
  }
  return type;
}


// A ZIP entry name: the Milestone 1 filename cleaning, and no path separators, so an entry can
// never land outside the folder it is extracted into.
export function zipEntryName(filename) {
  return sanitizeFilename(sanitizeFilename(filename).replace(/[/\\]/g, '_'));
}

// `<album title or vanity>.zip`.
export function zipFilename(album, fallback = 'album') {
  const title = (album && typeof(album.title) === 'string' && album.title.trim()) || (album && album.vanity) || fallback;
  return zipEntryName(title) + '.zip';
}

function sizeOf(value) {
  const number = Number(value);
  return (Number.isSafeInteger(number) && number >= 0) ? number : null;
}

// `uploaded_at` is epoch seconds (contract §4).
function uploadedAt(item) {
  const value = item && item.uploaded_at;
  return (typeof(value) === 'number' && Number.isFinite(value) && value > 0) ? new Date(value * 1000) : null;
}

// What goes into the album's ZIP, in order: { entries: [{ id, name, size, storage, date }], total
// (bytes of item data; null when a size is unknown), tooLarge (total over ZIP_LIMIT) }.
//
// Items come from the shown items (viewer.js), each read through `items_storage[<id>]`
// ({ key, size, filename }, contract §5). A paginated album payload (`next_cursor`) may list fewer
// items than `items_storage`; the rest are appended in `items_storage` order, with the same
// visibility rule from `items_access`. Only `ok` items are ever listed (milestone-4.md §6.3), so
// pending, hidden, removed and blocked items are never in a ZIP; every item also needs an ok,
// unexpired `items_access` entry (zippableItem), so a lookup missing one fails closed.
export function albumZipPlan(data, nowMs = Date.now()) {
  const storageMap = (data && data.items_storage && typeof(data.items_storage) === 'object') ? data.items_storage : {};
  const itemsAccess = (data && data.items_access && typeof(data.items_access) === 'object') ? data.items_access : {};
  const album = (data && data.album) || {};
  const linkAlbum = ((data && data.access) || {}).visibility === 'link';

  const picked = [];
  const seen = new Set();
  for (const item of visibleAlbumItems(data, nowMs)) {
    const id = String(item.id);
    const storage = storageMap[id];
    if (item.id === undefined || item.id === null || !storage || seen.has(id) || !zippableItem(itemsAccess, id, nowMs)) {
      continue;
    }
    seen.add(id);
    picked.push({ id, filename: item.filename ?? storage.filename, size: sizeOf(storage.size ?? item.size), storage, date: uploadedAt(item) });
  }
  if (album.next_cursor) {
    for (const [id, storage] of Object.entries(storageMap)) {
      if (seen.has(id) || !storage) {
        continue;
      }
      const visibility = itemsAccess[id] && itemsAccess[id].visibility;
      if ((linkAlbum && visibility !== 'link') || !zippableItem(itemsAccess, id, nowMs)) {
        continue;
      }
      seen.add(id);
      picked.push({ id, filename: storage.filename, size: sizeOf(storage.size), storage, date: null });
    }
  }

  const names = uniqueNames(picked.map((entry) => zipEntryName(entry.filename)));
  const entries = picked.map((entry, index) => ({ ...entry, name: names[index] }));
  let total = 0;
  for (const entry of entries) {
    total = (total === null || entry.size === null) ? null : total + entry.size;
  }
  // items_storage always carries sizes (contract §5). Without one the cap can't be checked up
  // front; the stream is then sent without Content-Length and the writer still refuses to pass
  // the 32-bit limit.
  const tooLarge = (total !== null && total > ZIP_LIMIT) || entries.length > ZIP_MAX_ENTRIES;
  return { entries, total, tooLarge };
}
