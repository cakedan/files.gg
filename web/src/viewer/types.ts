/** Renderer kinds from Appendix A. Unknown kinds fall back to `file`. */
export const FILE_KINDS = ['image', 'video', 'audio', 'text', 'pdf', 'file'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface FileThumbnail {
  url: string;
  /** PLAN.md "Media processing": `cover` gives audio a larger art box. */
  type: 'thumb' | 'poster' | 'cover' | 'waveform' | (string & {});
  width?: number | undefined;
  height?: number | undefined;
}

/** Audio tags from `probe`. */
export interface MediaTags {
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  track?: number | undefined;
}

/** `media` from PLAN.md "Media processing" (probe output). Every field is optional. */
export interface MediaInfo {
  width?: number | undefined;
  height?: number | undefined;
  /** Milliseconds. */
  duration?: number | undefined;
  framecount?: number | undefined;
  playable?: boolean | undefined;
  has_audio?: boolean | undefined;
  codecs?: string[] | undefined;
  tags?: MediaTags | undefined;
  pages?: number | undefined;
  lines?: number | undefined;
}

/**
 * The boot payload inlined by the worker as
 * `<script id="file-data" type="application/json">`. See web/README.md.
 */
export interface FileData {
  kind: FileKind;
  filename: string;
  mimetype: string;
  extension: string;
  /** Bytes. */
  size: number;
  /** Absolute CDN URL used as `src`. Download is `?download=true`. */
  cdnUrl: string;
  /** Canonical viewer URL for "Copy link". Falls back to the current page URL. */
  url?: string | undefined;
  id?: string | undefined;
  vanity?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** Milliseconds. */
  duration?: number | undefined;
  framecount?: number | undefined;
  thumbnail?: FileThumbnail | undefined;
  media?: MediaInfo | undefined;
  /** Short muted clip for tiles (video and animated images). */
  hover_url?: string | undefined;
  /** True until `derive` finishes. */
  processing?: boolean | undefined;
  /** ms epoch. */
  uploadedAt: number;
  /** ms epoch, or null when the file never expires. */
  expiresAt: number | null;
}

export const ALBUM_LAYOUTS = ['auto', 'grid', 'list', 'tracklist'] as const;
export type AlbumLayout = (typeof ALBUM_LAYOUTS)[number];

/** One album item: a file payload plus its place in the album. */
export interface AlbumItem extends FileData {
  /** 0-based order within the album. */
  position: number;
  /** Plain text, ≤ 500 characters. */
  caption: string;
}

/**
 * The album boot payload, inlined as `<script id="album-data" type="application/json">`
 * (PLAN.md Phase 1 "Albums"). See web/README.md for the exact contract.
 */
export interface AlbumData {
  vanity: string;
  /** Canonical album URL, `https://files.gg/a/<vanity>`. */
  url?: string | undefined;
  title: string;
  /** Plain text, ≤ 2,000 characters. */
  description: string;
  layout: AlbumLayout;
  nsfw: boolean;
  /** Resolved cover image (from `cover_file_id`, or automatic). */
  cover?: FileThumbnail | undefined;
  /** ms epoch, or null when the album never expires. */
  expiresAt: number | null;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  /** Visible items in the whole album (can exceed `items.length` when paginated). */
  count: number;
  /** Bytes across all visible items. */
  totalSize: number;
  nextCursor: string | null;
  /** Visible, unexpired items sorted by position. Never empty. */
  items: AlbumItem[];
}

export type BootState =
  | { page: 'home' }
  | { page: 'convert' }
  | { page: 'unavailable' }
  | { page: 'missing' }
  | { page: 'file'; file: FileData }
  | { page: 'album'; album: AlbumData };
