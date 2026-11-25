/**
 * Conversion source kinds (milestone-5 §1.1) and the links into the Convert page
 * (§13.2). Shared by the viewer's Convert entry points and the dashboard, so it stays
 * tiny: no API client, no React.
 */

/** §1.1. `images` is "several images (or an album) → PDF" (§1.2's last row). */
export type SourceKind = 'image' | 'animated' | 'video' | 'audio' | 'document' | 'pdf';
export type ConversionKind = SourceKind | 'images';

/** §1.1 `document`: the Office and OpenDocument types, with the label the viewer shows. */
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  'application/msword': 'Word document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.ms-excel': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.ms-powerpoint': 'PowerPoint presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation',
  'application/rtf': 'Rich Text document',
};

/** §1.1 `image` (one frame) and `animated` candidates. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
  'image/x-icon',
  'image/vnd.adobe.photoshop',
  'image/svg+xml',
  'image/gif',
  'image/apng',
]);
const MAYBE_ANIMATED = new Set(['image/gif', 'image/apng', 'image/webp']);

/** What the client knows about a file: the payload's fields (milestone-3 §4). */
export interface KindInput {
  mimetype: string;
  kind?: string | undefined;
  framecount?: number | null | undefined;
  media?: { framecount?: number | undefined; codecs?: string[] | undefined; width?: number | undefined } | null | undefined;
  width?: number | null | undefined;
}

/**
 * The conversion kind of a file (§1.1), or null when it has no targets. Animated images
 * are told apart by the probe's frame count; `image/apng` is animated unless the probe
 * says one frame. A `video/*` whose payload kind isn't `video` (only an audio stream,
 * which the API reports as `audio`) is audio.
 */
export function sourceKindOf(file: KindInput): SourceKind | null {
  const mimetype = file.mimetype.toLowerCase();
  if (mimetype === 'application/pdf') return 'pdf';
  if (DOCUMENT_TYPES[mimetype]) return 'document';
  if (IMAGE_TYPES.has(mimetype)) {
    const frames = file.framecount ?? file.media?.framecount ?? null;
    if (MAYBE_ANIMATED.has(mimetype) && (frames !== null ? frames > 1 : mimetype === 'image/apng')) return 'animated';
    return 'image';
  }
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return file.kind === 'audio' ? 'audio' : 'video';
  return null;
}

/** "Word document" for a document's mimetype, else null. */
export const documentLabel = (mimetype: string): string | null => DOCUMENT_TYPES[mimetype.toLowerCase()] ?? null;

/** Where the Convert page lives on files.gg. The dashboard's own copy is `/app/convert`. */
export const PUBLIC_CONVERT_PATH = '/convert';

export interface ConvertLinkOptions {
  /** A preset id from `GET /conversions/formats` (`play_everywhere`). */
  preset?: string | undefined;
  /** A target to pick (`pdf`). */
  target?: string | undefined;
}

/** `/convert?source=<vanity>[&preset=…][&target=…]` (§13.2). */
export function convertPath(vanity: string, { preset, target }: ConvertLinkOptions = {}, base = PUBLIC_CONVERT_PATH): string {
  const params = new URLSearchParams({ source: vanity });
  if (preset) params.set('preset', preset);
  if (target) params.set('target', target);
  return `${base}?${params.toString()}`;
}
