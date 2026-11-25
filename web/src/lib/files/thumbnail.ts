/**
 * What a file tile or row shows (contract §8, PLAN.md Phase 3 "Files"):
 * - image: `thumb`, with `thumb-2x` in `srcset` (small originals have no thumb, so the file itself);
 * - video: `poster` (or `thumb`) with a ▶ badge and the muted `hover_url` on hover and focus;
 * - audio: `cover`, else a music icon;
 * - PDF: the first page (`thumb`);
 * - text: `media.snippet`;
 * - anything else, or nothing derived yet: a type icon. `processing` shows a placeholder.
 *
 * Owner payloads carry every URL ready to use, signed for 1 h for password and private
 * files (contract §6), so protected files show their media like public ones.
 */

import type { OwnerFile } from '../api';

export type ThumbView =
  | { type: 'processing' }
  | { type: 'image'; src: string; srcSet?: string | undefined; hover?: string | undefined; badge?: 'play' | undefined }
  | { type: 'snippet'; text: string }
  | { type: 'icon'; music?: boolean };

type ThumbFile = Pick<OwnerFile, 'kind' | 'cdn_url' | 'assets' | 'thumbnail' | 'hover_url' | 'media' | 'processing' | 'size'>;

/** Small originals (≤ 320×320) get no thumb; show them as-is up to this size. */
const ORIGINAL_AS_THUMB_MAX = 2 * 1024 * 1024;

export function thumbnailView(file: ThumbFile): ThumbView {
  const url = (value: string | undefined | null) => value || undefined;
  const assets = file.assets ?? {};

  if (file.kind === 'text' && file.media?.snippet) return { type: 'snippet', text: file.media.snippet };

  const thumb = url(assets.thumb?.url);
  const thumb2x = url(assets['thumb-2x']?.url);
  const srcSet = thumb && thumb2x ? `${thumb} 1x, ${thumb2x} 2x` : undefined;

  switch (file.kind) {
    case 'image': {
      if (thumb) return { type: 'image', src: thumb, srcSet, hover: url(file.hover_url) };
      if (!file.processing && file.size <= ORIGINAL_AS_THUMB_MAX) return { type: 'image', src: file.cdn_url };
      break;
    }
    case 'video': {
      const poster = url(assets.poster?.url) ?? thumb;
      if (poster) return { type: 'image', src: poster, srcSet: assets.poster ? undefined : srcSet, hover: url(file.hover_url), badge: 'play' };
      break;
    }
    case 'audio': {
      const cover = url(assets.cover?.url);
      if (cover) return { type: 'image', src: cover };
      return file.processing ? { type: 'processing' } : { type: 'icon', music: true };
    }
    case 'pdf':
      if (thumb) return { type: 'image', src: thumb, srcSet };
      break;
    default: {
      const fallback = url(file.thumbnail?.url);
      if (fallback) return { type: 'image', src: fallback };
    }
  }
  return file.processing ? { type: 'processing' } : { type: 'icon' };
}
