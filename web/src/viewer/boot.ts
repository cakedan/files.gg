/**
 * Pure boot-state parsing for the viewer shell (Appendix A, PLAN.md "Album page").
 *
 * Inputs are the `#root` element's data attributes and the text of the
 * `<script id="file-data">` / `<script id="album-data">` JSON, as injected by the
 * worker. The payloads have one shape (contract §4: snake_case, epoch seconds).
 * Precedence:
 *   1. data-page="home"           -> home (landing card)
 *   1b. data-page="domain-home"   -> domain-home (a custom domain's landing card, milestone-6 §10.8)
 *   2. data-page="report"         -> report (milestone-4 §10.1), from #report-data
 *                                    `{ type: "any" | "file" | "album", vanity? }`; else missing
 *   3. data-state="unavailable"   -> unavailable (Retry button)
 *   4. data-state="missing"       -> missing (also CSAM-blocked and private files)
 *   4'. data-state="region"       -> region (milestone-7 §11.2): adult content from a blocked
 *                                    country. The payload (`{ vanity }`) is never read
 *   4a. data-state="pending"      -> pending, from `{ vanity, pending: true }`; else missing
 *   4b. data-state="removed"      -> removed, from `{ vanity, removed: <reason> }`; else missing
 *   4c. data-state="locked"       -> locked (contract §4), when the script tag holds
 *                                    `{ vanity, protected: "password" }`; else missing.
 *                                    `view_limited: true` (+ `views_remaining`) marks a
 *                                    view-limited password file (milestone-6 §19.7)
 *   4d. data-state="limited"      -> limited (milestone-6 §19.5), from
 *                                    `{ vanity, view_limited: true, views_remaining }`; with
 *                                    `protected: "password"` it's the lock screen instead
 *                                    (locked, with the view limit); albums are missing
 *   5. data-page="album"          -> album when #album-data is a valid album with at
 *                                    least one visible item, otherwise missing
 *   6. valid file JSON            -> file
 *   7. anything else (null, absent, malformed JSON, missing required fields) -> missing
 */

import {
  ALBUM_LAYOUTS,
  FILE_KINDS,
  FILE_WARNINGS,
  PREVIEW_KINDS,
  REMOVED_REASONS,
  type AlbumData,
  type AlbumItem,
  type AlbumLayout,
  type BootState,
  type DocumentPreview,
  type FileAsset,
  type FileAssets,
  type FileData,
  type FileKind,
  type FileThumbnail,
  type FileWarning,
  type LimitedTarget,
  type LockedTarget,
  type MediaInfo,
  type MediaTags,
  type RemovedReason,
  type ReportPageTarget,
  type StateTarget,
  type ViewLimitInfo,
} from './types';

export interface BootInput {
  page?: string | null | undefined;
  state?: string | null | undefined;
  /** Raw text content of #file-data, or null when the script tag is absent. */
  fileJson?: string | null | undefined;
  /** Raw text content of #album-data, or null when the script tag is absent. */
  albumJson?: string | null | undefined;
  /** Raw text content of #report-data (milestone-4 §10.1), or null when absent. */
  reportJson?: string | null | undefined;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positiveNumber = (value: unknown): number | undefined => {
  const n = finiteNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
};

/** Payload times are epoch seconds (contract §4). */
const epochSeconds = (value: unknown): number | undefined => finiteNumber(value);

/** True when an epoch-seconds expiry has passed at `nowMs`. */
export const hasExpired = (expiresAt: number | null, nowMs: number): boolean => expiresAt !== null && expiresAt * 1000 <= nowMs;

const parseJson = (text: string | null | undefined): unknown => {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function normalizeKind(value: unknown): FileKind {
  return typeof value === 'string' && (FILE_KINDS as readonly string[]).includes(value) ? (value as FileKind) : 'file';
}

function parseThumbnail(value: unknown): FileThumbnail | undefined {
  if (!isObject(value)) return undefined;
  const url = nonEmptyString(value.url);
  if (!url) return undefined;
  return {
    url,
    type: nonEmptyString(value.type) ?? 'thumb',
    width: positiveNumber(value.width),
    height: positiveNumber(value.height),
  };
}

function parseAsset(value: unknown): FileAsset | undefined {
  if (!isObject(value)) return undefined;
  const url = nonEmptyString(value.url);
  if (!url) return undefined;
  return { url, width: positiveNumber(value.width), height: positiveNumber(value.height) };
}

/** Milestone 5 §9.2 `assets.document`: `{ url, size, pages }`, the preview PDF of a document. */
export function parseDocumentPreview(value: unknown): DocumentPreview | undefined {
  if (!isObject(value)) return undefined;
  const url = nonEmptyString(value.url);
  if (!url) return undefined;
  return { url, size: positiveNumber(value.size), pages: positiveNumber(value.pages) };
}

/**
 * `assets` (contract §4): `{ "<kind>": { url, width?, height? } }`, plus `document`
 * (milestone-5 §9.2). Unknown kinds and entries without a URL are dropped.
 */
export function parseAssets(value: unknown): FileAssets | undefined {
  if (!isObject(value)) return undefined;
  const assets: FileAssets = {};
  for (const kind of PREVIEW_KINDS) {
    const asset = parseAsset(value[kind]);
    if (asset) assets[kind] = asset;
  }
  const document = parseDocumentPreview(value.document);
  if (document) assets.document = document;
  return Object.keys(assets).length > 0 ? assets : undefined;
}

const parseVisibility = (value: unknown) =>
  value === 'link' || value === 'password' || value === 'private' ? value : undefined;

function parseTags(value: unknown): MediaTags | undefined {
  if (!isObject(value)) return undefined;
  const tags: MediaTags = {
    title: nonEmptyString(value.title),
    artist: nonEmptyString(value.artist),
    album: nonEmptyString(value.album),
    track: positiveNumber(value.track),
  };
  return Object.values(tags).some((v) => v !== undefined) ? tags : undefined;
}

export function parseMedia(value: unknown): MediaInfo | undefined {
  if (!isObject(value)) return undefined;
  return {
    width: positiveNumber(value.width),
    height: positiveNumber(value.height),
    duration: positiveNumber(value.duration),
    framecount: positiveNumber(value.framecount),
    playable: typeof value.playable === 'boolean' ? value.playable : undefined,
    has_audio: typeof value.has_audio === 'boolean' ? value.has_audio : undefined,
    codecs: Array.isArray(value.codecs) ? value.codecs.filter((c): c is string => typeof c === 'string') : undefined,
    tags: parseTags(value.tags),
    pages: positiveNumber(value.pages),
    lines: positiveNumber(value.lines),
    language: nonEmptyString(value.language)?.toLowerCase(),
    snippet: typeof value.snippet === 'string' ? value.snippet : undefined,
  };
}

/** Milestone 4 §2.8 `warnings`: known codes only, deduplicated, in FILE_WARNINGS order. */
export function parseWarnings(value: unknown): FileWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const found = FILE_WARNINGS.filter((code) => value.includes(code));
  return found.length > 0 ? found : undefined;
}

/** Milestone 4 §5.7 `link_warnings`: http(s) URLs only, at most 20. */
export function parseLinkWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)).slice(0, 20);
  return urls.length > 0 ? urls : undefined;
}

/**
 * Validates and normalises a file payload (contract §4). Returns null when it can't be
 * shown (not an object, or missing `cdn_url` / `filename`). URLs are kept exactly as
 * they arrive: signed ones must not be touched.
 */
export function parseFileData(value: unknown): FileData | null {
  if (!isObject(value)) return null;
  const cdn_url = nonEmptyString(value.cdn_url);
  const filename = nonEmptyString(value.filename);
  if (!cdn_url || !filename) return null;

  const extension =
    nonEmptyString(value.extension) ?? (filename.includes('.') ? (filename.split('.').pop() ?? '') : '');
  const media = parseMedia(value.media);
  // Milestone 4 §2.3: media our decoders couldn't check is download-only. The API
  // already sends `kind: "file"`; if `serve_inline: false` arrives anyway, nothing
  // renders inline and no preview (which the CDN refuses) is requested.
  const inline = value.serve_inline !== false;
  const assets = inline ? parseAssets(value.assets) : undefined;

  return {
    kind: inline ? normalizeKind(value.kind) : 'file',
    filename,
    mimetype: nonEmptyString(value.mimetype) ?? 'application/octet-stream',
    extension,
    size: finiteNumber(value.size) ?? 0,
    cdn_url: cdn_url,
    url: nonEmptyString(value.url),
    id: nonEmptyString(value.id),
    vanity: nonEmptyString(value.vanity),
    width: positiveNumber(value.width) ?? media?.width,
    height: positiveNumber(value.height) ?? media?.height,
    duration: positiveNumber(value.duration) ?? media?.duration,
    framecount: positiveNumber(value.framecount) ?? media?.framecount,
    thumbnail: inline ? parseThumbnail(value.thumbnail) : undefined,
    media,
    assets,
    hover_url: inline ? (nonEmptyString(value.hover_url) ?? assets?.hover?.url) : undefined,
    processing: value.processing === true ? true : undefined,
    visibility: parseVisibility(value.visibility),
    uploaded_at: epochSeconds(value.uploaded_at) ?? 0,
    expires_at: epochSeconds(value.expires_at) ?? null,
    nsfw: value.nsfw === true ? true : undefined,
    warnings: parseWarnings(value.warnings),
    link_warnings: parseLinkWarnings(value.link_warnings),
    view_limit: parsePayloadViewLimit(value.view_limit),
  };
}

const viewCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Milestone 6 §19.6: `view_limit: { remaining }` on a public payload, or undefined. */
export function parsePayloadViewLimit(value: unknown): { remaining: number } | undefined {
  if (!isObject(value)) return undefined;
  const remaining = viewCount(value.remaining);
  return remaining === undefined ? undefined : { remaining };
}

/** Milestone 6 §19.5: `view_limited: true` with `views_remaining` on a shell's payload. */
function parseShellViewLimit(value: JsonObject): ViewLimitInfo | undefined {
  if (value.view_limited !== true) return undefined;
  return { remaining: viewCount(value.views_remaining) ?? null };
}

const normalizeLayout = (value: unknown): AlbumLayout =>
  typeof value === 'string' && (ALBUM_LAYOUTS as readonly string[]).includes(value) ? (value as AlbumLayout) : 'auto';

/**
 * Validates an album payload. Items that aren't valid files, or that have expired,
 * drop out (PLAN.md: expired files drop out of the public view). Returns null when
 * the album itself has expired or has no visible items, which shows the missing state.
 */
export function parseAlbumData(value: unknown, now: number = Date.now()): AlbumData | null {
  if (!isObject(value)) return null;
  const vanity = nonEmptyString(value.vanity);
  if (!vanity) return null;

  const expiresAt = epochSeconds(value.expires_at) ?? null;
  if (hasExpired(expiresAt, now)) return null;

  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items: AlbumItem[] = [];
  rawItems.forEach((raw, index) => {
    const file = parseFileData(raw);
    if (!file || !isObject(raw)) return;
    if (hasExpired(file.expires_at, now)) return;
    items.push({
      ...file,
      position: finiteNumber(raw.position) ?? index,
      caption: typeof raw.caption === 'string' ? raw.caption.slice(0, 500) : '',
    });
  });
  if (items.length === 0) return null;
  items.sort((a, b) => a.position - b.position);

  const summedSize = items.reduce((total, item) => total + item.size, 0);
  return {
    id: nonEmptyString(value.id),
    vanity,
    visibility: parseVisibility(value.visibility),
    url: nonEmptyString(value.url),
    title: typeof value.title === 'string' ? value.title.slice(0, 100) : '',
    description: typeof value.description === 'string' ? value.description.slice(0, 2000) : '',
    layout: normalizeLayout(value.layout),
    nsfw: value.nsfw === true,
    cover: parseThumbnail(value.cover),
    collage: parseAsset(value.collage),
    download_url: nonEmptyString(value.download_url),
    expires_at: expiresAt,
    count: Math.max(finiteNumber(value.count) ?? 0, items.length),
    total_size: finiteNumber(value.total_size) ?? summedSize,
    next_cursor: nonEmptyString(value.next_cursor) ?? null,
    items,
    link_warnings: parseLinkWarnings(value.link_warnings),
  };
}

/** `{ vanity, protected: "password", filename? | title?, password_expired? }` (contract §4). */
export function parseLockedTarget(value: unknown, kind: LockedTarget['kind']): LockedTarget | null {
  if (!isObject(value)) return null;
  const vanity = nonEmptyString(value.vanity);
  if (!vanity || value.protected !== 'password') return null;
  const viewLimit = kind === 'file' ? parseShellViewLimit(value) : undefined;
  return {
    kind,
    vanity,
    name: nonEmptyString(kind === 'album' ? value.title : value.filename),
    passwordExpired: value.password_expired === true,
    ...(viewLimit ? { viewLimit } : {}),
  };
}

/** `{ vanity, view_limited: true, views_remaining }` (milestone-6 §19.5). Files only. */
export function parseLimitedTarget(value: unknown): LimitedTarget | null {
  if (!isObject(value)) return null;
  const vanity = nonEmptyString(value.vanity);
  const limit = parseShellViewLimit(value);
  return vanity && limit ? { vanity, ...limit } : null;
}

/** `#file-data` / `#album-data` = `{ vanity, pending: true }` (milestone-4 §10.1). */
export function parsePendingTarget(value: unknown, kind: StateTarget['kind']): StateTarget | null {
  if (!isObject(value)) return null;
  const vanity = nonEmptyString(value.vanity);
  return vanity && value.pending === true ? { kind, vanity } : null;
}

/** `{ vanity, removed: "review" | "terms" | "copyright" | "malware" }` (milestone-4 §10.1). */
export function parseRemovedTarget(
  value: unknown,
  kind: StateTarget['kind'],
): { target: StateTarget; reason: RemovedReason } | null {
  if (!isObject(value)) return null;
  const vanity = nonEmptyString(value.vanity);
  const reason = value.removed;
  if (!vanity || typeof reason !== 'string' || !(REMOVED_REASONS as readonly string[]).includes(reason)) return null;
  return { target: { kind, vanity }, reason: reason as RemovedReason };
}

/** `#report-data`: `{ type: "any" }`, or `{ type: "file" | "album", vanity }` (milestone-4 §10.1). */
export function parseReportTarget(value: unknown): ReportPageTarget | null {
  if (!isObject(value)) return null;
  if (value.type === 'any') return { type: 'any' };
  const vanity = nonEmptyString(value.vanity);
  if (!vanity) return null;
  if (value.type === 'file' || value.type === 'album') return { type: value.type, vanity };
  return null;
}

export function parseBoot({ page, state, fileJson, albumJson, reportJson }: BootInput, now: number = Date.now()): BootState {
  if (page === 'domain-home') return { page: 'domain-home' };
  if (page === 'report') {
    const target = parseReportTarget(parseJson(reportJson));
    return target ? { page: 'report', target } : { page: 'missing' };
  }
  if (state === 'unavailable') return { page: 'unavailable' };
  if (state === 'missing') return { page: 'missing' };
  if (state === 'region') return { page: 'region', kind: page === 'album' ? 'album' : 'file' };
  if (state === 'pending' || state === 'removed') {
    const kind = page === 'album' ? 'album' : 'file';
    const data = parseJson(kind === 'album' ? albumJson : fileJson);
    if (state === 'pending') {
      const target = parsePendingTarget(data, kind);
      return target ? { page: 'pending', target } : { page: 'missing' };
    }
    const removed = parseRemovedTarget(data, kind);
    return removed ? { page: 'removed', ...removed } : { page: 'missing' };
  }
  if (state === 'locked') {
    const kind = page === 'album' ? 'album' : 'file';
    const target = parseLockedTarget(parseJson(kind === 'album' ? albumJson : fileJson), kind);
    return target ? { page: 'locked', target } : { page: 'missing' };
  }

  if (state === 'limited') {
    // View limits are for files only (§19.6): albums can't count each item.
    if (page === 'album') return { page: 'missing' };
    const data = parseJson(fileJson);
    // A view-limited password file: the lock screen, where unlocking uses the view (§19.4).
    if (isObject(data) && data.protected === 'password') {
      const target = parseLockedTarget({ view_limited: true, ...data }, 'file');
      return target ? { page: 'locked', target } : { page: 'missing' };
    }
    const target = parseLimitedTarget(data);
    return target ? { page: 'limited', target } : { page: 'missing' };
  }

  if (page === 'album') {
    const album = parseAlbumData(parseJson(albumJson), now);
    return album ? { page: 'album', album } : { page: 'missing' };
  }

  const file = parseFileData(parseJson(fileJson));
  return file ? { page: 'file', file } : { page: 'missing' };
}

/** Reads the boot input from the live document. The only DOM-touching part. */
export function readBootInput(doc: Document = document): BootInput {
  const root = doc.getElementById('root');
  return {
    page: root?.dataset.page ?? null,
    state: root?.dataset.state ?? null,
    fileJson: doc.getElementById('file-data')?.textContent ?? null,
    albumJson: doc.getElementById('album-data')?.textContent ?? null,
    reportJson: doc.getElementById('report-data')?.textContent ?? null,
  };
}
