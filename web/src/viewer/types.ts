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

/** Preview kinds (contract §3), the keys of `assets`. */
export const PREVIEW_KINDS = ['thumb', 'thumb-2x', 'display', 'poster', 'cover', 'waveform', 'peaks', 'hover'] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/**
 * One ready preview (contract §4). The URL is ready to use: plain for `link` files,
 * signed (`expires=…&sig=…`) for protected ones. Never built or changed here.
 */
export interface FileAsset {
  url: string;
  width?: number | undefined;
  height?: number | undefined;
}

export type FileAssets = Partial<Record<PreviewKind, FileAsset>>;

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
  /** Text: the language from the extension (contract §2), or undefined when unknown. */
  language?: string | undefined;
  /** Text: the first ~12 lines (owner payloads only). */
  snippet?: string | undefined;
}

/**
 * The file payload (contract §4), inlined by the worker as
 * `<script id="file-data" type="application/json">` and returned by unlock, view
 * and refresh. Field names and times are the payload's own (snake_case, epoch seconds).
 */
export interface FileData {
  kind: FileKind;
  filename: string;
  mimetype: string;
  extension: string;
  /** Bytes. */
  size: number;
  /** Absolute CDN URL used as `src`, signed when protected. Download adds `?download=true`. */
  cdn_url: string;
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
  /** Ready previews (contract §4): `thumb`, `thumb-2x`, `display`, `poster`, … */
  assets?: FileAssets | undefined;
  /** Short muted clip for tiles (video and animated images). */
  hover_url?: string | undefined;
  /** True until `derive` finishes. */
  processing?: boolean | undefined;
  /** Milestone 2 access level. Only `link` files have plain (unsigned) URLs. */
  visibility?: 'link' | 'password' | 'private' | undefined;
  /** Epoch seconds. */
  uploaded_at: number;
  /** Epoch seconds, or null when the file never expires. */
  expires_at: number | null;
  /** Milestone 4 §4.4: sensitive (NSFW). The viewer shows an interstitial first. */
  nsfw?: boolean | undefined;
  /** Milestone 4 §6.1 / §2.8: scanner warnings shown to visitors. Unknown codes drop out. */
  warnings?: FileWarning[] | undefined;
  /** Milestone 4 §5.7: up to 20 URLs Web Risk flagged. They're never opened from files.gg. */
  link_warnings?: string[] | undefined;
  /** Milestone 6 §19.6: views left after this one (from open and unlock). Absent without a limit. */
  view_limit?: { remaining: number } | undefined;
}

/** Milestone 4 §2.8 `warnings`, in the order the banner lists them. */
export const FILE_WARNINGS = ['unwanted_software', 'encrypted_archive', 'encrypted_pdf', 'archive_partially_scanned', 'too_large_to_scan'] as const;
export type FileWarning = (typeof FILE_WARNINGS)[number];

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
 * The album payload (contract §4), inlined as `<script id="album-data" type="application/json">`
 * and returned by album unlock, view and refresh.
 */
export interface AlbumData {
  id?: string | undefined;
  vanity: string;
  visibility?: 'link' | 'password' | 'private' | undefined;
  /** Canonical album URL, `https://files.gg/a/<vanity>`. */
  url?: string | undefined;
  title: string;
  /** Plain text, ≤ 2,000 characters. */
  description: string;
  layout: AlbumLayout;
  nsfw: boolean;
  /** Resolved cover image (from `cover_file_id`, or automatic). */
  cover?: FileThumbnail | undefined;
  /** 1200×630 collage of the first visual items (contract §2 `album_collage`). */
  collage?: FileAsset | undefined;
  /** "Download all": `https://cdn.files.gg/albums/download/<vanity>.zip`, signed when protected. */
  download_url?: string | undefined;
  /** Epoch seconds, or null when the album never expires. */
  expires_at: number | null;
  /** Visible items in the whole album (can exceed `items.length` when paginated). */
  count: number;
  /** Bytes across all visible items. */
  total_size: number;
  next_cursor: string | null;
  /** Visible, unexpired items sorted by position. Never empty. */
  items: AlbumItem[];
  /** Milestone 4 §5.7: Web Risk hits in the title, description and captions. */
  link_warnings?: string[] | undefined;
}

/**
 * A `locked` shell (contract §4): the worker knows only the vanity, plus the name
 * when the owner chose to show it.
 */
export interface LockedTarget {
  kind: 'file' | 'album';
  vanity: string;
  /** `filename` (files) or `title` (albums), only with "show name when locked". */
  name?: string | undefined;
  /** The password stopped working (`password_expired: true`). */
  passwordExpired: boolean;
  /** Milestone 6 §19.7: a view-limited password file; unlocking uses a view. */
  viewLimit?: ViewLimitInfo | undefined;
}

/** Milestone 6 §19.5: what the shell says about a view limit. */
export interface ViewLimitInfo {
  /** `views_remaining`, or null when the shell didn't say. */
  remaining: number | null;
}

/** A `limited` shell (milestone-6 §19.5): `{ vanity, view_limited: true, views_remaining }`, no media. */
export interface LimitedTarget extends ViewLimitInfo {
  vanity: string;
}

/** Milestone 4 §2.4: the public reason on a removed (or hidden) page. */
export const REMOVED_REASONS = ['review', 'terms', 'copyright', 'malware'] as const;
export type RemovedReason = (typeof REMOVED_REASONS)[number];

/** A `pending` or `removed` shell (milestone-4 §10.1): the worker sends only the vanity. */
export interface StateTarget {
  kind: 'file' | 'album';
  vanity: string;
}

/** `#report-data` (milestone-4 §10.1): what the report page is for. */
export type ReportPageTarget =
  | { type: 'any' }
  | { type: 'file'; vanity: string }
  | { type: 'album'; vanity: string }
  /** Milestone 6 §10.12: a custom domain, from its landing card. Never from `#report-data`. */
  | { type: 'domain'; hostname: string };

export type BootState =
  | { page: 'home' }
  /** Milestone 6 §10.8: a custom domain's `/` (`data-page="domain-home"`). */
  | { page: 'domain-home' }
  | { page: 'pending'; target: StateTarget }
  | { page: 'removed'; target: StateTarget; reason: RemovedReason }
  | { page: 'report'; target: ReportPageTarget }
  | { page: 'locked'; target: LockedTarget }
  /** Milestone 6 §19.5: a view-limited file (`data-state="limited"`). */
  | { page: 'limited'; target: LimitedTarget }
  | { page: 'convert' }
  | { page: 'unavailable' }
  | { page: 'missing' }
  | { page: 'file'; file: FileData }
  | { page: 'album'; album: AlbumData };
