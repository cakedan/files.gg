/**
 * Picking previews (contract §4, §7). The viewer never builds or changes asset URLs:
 * it uses the ones in the payload as they are (already signed for protected files).
 */

import type { FileData } from '../types';

/** Image types every current browser can show (web/README §3). */
const BROWSER_IMAGE_TYPES = new Set([
  'image/png',
  'image/apng',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

export const isBrowserImage = (mimetype: string) => BROWSER_IMAGE_TYPES.has(mimetype.toLowerCase());

/**
 * The image to display: the original, or `assets.display` for types browsers can't
 * show (HEIC, TIFF, PSD, …) when one has been derived.
 */
export function imageSrc(file: Pick<FileData, 'cdn_url' | 'mimetype' | 'assets'>): string {
  const display = file.assets?.display?.url;
  return display && !isBrowserImage(file.mimetype) ? display : file.cdn_url;
}

type Thumbed = Pick<FileData, 'thumbnail' | 'assets'>;

const fromThumbnail = (file: Thumbed, type: string) => (file.thumbnail?.type === type ? file.thumbnail.url : undefined);

/** Video poster: the `poster` thumbnail, else `assets.poster`. */
export const posterUrl = (file: Thumbed) => fromThumbnail(file, 'poster') ?? file.assets?.poster?.url;

/** Audio cover art: the `cover` thumbnail, else `assets.cover`. */
export const coverUrl = (file: Thumbed) => fromThumbnail(file, 'cover') ?? file.assets?.cover?.url;

/** Audio waveform strip (only used when there's no cover). */
export const waveformUrl = (file: Thumbed) => fromThumbnail(file, 'waveform') ?? file.assets?.waveform?.url;

export interface TileImage {
  src: string;
  srcSet?: string | undefined;
  sizes?: string | undefined;
}

/**
 * The picture for a small tile (album grid): `thumb` with `thumb-2x` in `srcset`, else
 * the payload thumbnail (poster, cover, waveform), else the image itself.
 */
export function tileImage(file: Pick<FileData, 'kind' | 'cdn_url' | 'mimetype' | 'thumbnail' | 'assets'>, displayWidth?: number): TileImage | null {
  const thumb = file.assets?.thumb;
  const thumb2x = file.assets?.['thumb-2x'];
  if (thumb) {
    if (!thumb2x) return { src: thumb.url };
    if (!displayWidth) return { src: thumb.url, srcSet: `${thumb.url} 1x, ${thumb2x.url} 2x` };
    // Width descriptors let the browser pick by the tile's real size and the pixel ratio.
    return {
      src: thumb.url,
      srcSet: `${thumb.url} ${thumb.width ?? 320}w, ${thumb2x.url} ${thumb2x.width ?? 640}w`,
      sizes: `${Math.ceil(displayWidth)}px`,
    };
  }
  if (file.thumbnail) return { src: file.thumbnail.url };
  if (file.kind === 'image') return { src: imageSrc(file) };
  return null;
}
