/**
 * Pure boot-state parsing for the viewer shell (Appendix A, PLAN.md "Album page").
 *
 * Inputs are the `#root` element's data attributes and the text of the
 * `<script id="file-data">` / `<script id="album-data">` JSON, as injected by the
 * worker. Precedence:
 *   1. data-page="home"           -> home (landing card)
 *   2. data-page="convert"        -> convert (placeholder)
 *   3. data-state="unavailable"   -> unavailable (Retry button)
 *   4. data-state="missing"       -> missing
 *   5. data-page="album"          -> album when #album-data is a valid album with at
 *                                    least one visible item, otherwise missing
 *   6. valid file JSON            -> file
 *   7. anything else (null, absent, malformed JSON, missing required fields) -> missing
 */

import {
  ALBUM_LAYOUTS,
  FILE_KINDS,
  type AlbumData,
  type AlbumItem,
  type AlbumLayout,
  type BootState,
  type FileData,
  type FileKind,
  type FileThumbnail,
  type MediaInfo,
  type MediaTags,
} from './types';

export interface BootInput {
  page?: string | null | undefined;
  state?: string | null | undefined;
  /** Raw text content of #file-data, or null when the script tag is absent. */
  fileJson?: string | null | undefined;
  /** Raw text content of #album-data, or null when the script tag is absent. */
  albumJson?: string | null | undefined;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const positiveNumber = (value: unknown): number | undefined => {
  const n = finiteNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
};

/** ms epoch from a number, a numeric string, or an ISO-8601 string. */
export function parseTimestamp(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n !== undefined) return n;
  if (typeof value === 'string' && value.length >= 10) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** First defined value among camelCase / snake_case spellings of a field. */
const pick = (obj: JsonObject, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

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
  };
}

/**
 * Validates and normalises a parsed payload. Returns null when it can't be shown
 * (not an object, or missing `cdnUrl` / `filename`).
 */
export function parseFileData(value: unknown): FileData | null {
  if (!isObject(value)) return null;
  const cdnUrl = nonEmptyString(pick(value, 'cdnUrl', 'cdn_url'));
  const filename = nonEmptyString(value.filename);
  if (!cdnUrl || !filename) return null;

  const extension =
    nonEmptyString(value.extension) ?? (filename.includes('.') ? (filename.split('.').pop() ?? '') : '');
  const media = parseMedia(value.media);

  return {
    kind: normalizeKind(value.kind),
    filename,
    mimetype: nonEmptyString(value.mimetype) ?? 'application/octet-stream',
    extension,
    size: finiteNumber(value.size) ?? 0,
    cdnUrl,
    url: nonEmptyString(value.url),
    id: nonEmptyString(value.id),
    vanity: nonEmptyString(value.vanity),
    width: positiveNumber(value.width) ?? media?.width,
    height: positiveNumber(value.height) ?? media?.height,
    duration: positiveNumber(value.duration) ?? media?.duration,
    framecount: positiveNumber(value.framecount) ?? media?.framecount,
    thumbnail: parseThumbnail(value.thumbnail),
    media,
    hover_url: nonEmptyString(pick(value, 'hover_url', 'hoverUrl')),
    processing: value.processing === true ? true : undefined,
    uploadedAt: parseTimestamp(pick(value, 'uploadedAt', 'uploaded_at', 'created_at')) ?? 0,
    expiresAt: parseTimestamp(pick(value, 'expiresAt', 'expires_at')) ?? null,
  };
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

  const expiresAt = parseTimestamp(pick(value, 'expiresAt', 'expires_at')) ?? null;
  if (expiresAt !== null && expiresAt <= now) return null;

  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items: AlbumItem[] = [];
  rawItems.forEach((raw, index) => {
    const file = parseFileData(raw);
    if (!file || !isObject(raw)) return;
    if (file.expiresAt !== null && file.expiresAt <= now) return;
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
    vanity,
    url: nonEmptyString(value.url),
    title: typeof value.title === 'string' ? value.title.slice(0, 100) : '',
    description: typeof value.description === 'string' ? value.description.slice(0, 2000) : '',
    layout: normalizeLayout(value.layout),
    nsfw: value.nsfw === true,
    cover: parseThumbnail(value.cover),
    expiresAt,
    createdAt: parseTimestamp(pick(value, 'createdAt', 'created_at')),
    updatedAt: parseTimestamp(pick(value, 'updatedAt', 'updated_at')),
    count: Math.max(finiteNumber(value.count) ?? 0, items.length),
    totalSize: finiteNumber(pick(value, 'totalSize', 'total_size')) ?? summedSize,
    nextCursor: nonEmptyString(pick(value, 'nextCursor', 'next_cursor')) ?? null,
    items,
  };
}

export function parseBoot({ page, state, fileJson, albumJson }: BootInput, now: number = Date.now()): BootState {
  if (page === 'home') return { page: 'home' };
  if (page === 'convert') return { page: 'convert' };
  if (state === 'unavailable') return { page: 'unavailable' };
  if (state === 'missing') return { page: 'missing' };

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
  };
}
