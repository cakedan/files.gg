import { Music } from 'lucide-react';

import type { RendererProps } from './types';

/** Native audio with cover art and the "Artist: Title" tag line (custom player later). */
export default function AudioRenderer({ file }: RendererProps) {
  const thumb = file.thumbnail;
  const tags = file.media?.tags;
  const line = tags?.title ? (tags.artist ? `${tags.artist}: ${tags.title}` : tags.title) : null;
  return (
    <div className="viewer-well w-[min(35rem,var(--media-max-width))] flex-col gap-3 p-4">
      {thumb?.type === 'cover' ? (
        <img src={thumb.url} alt="" className="aspect-square w-full max-w-[min(20rem,60dvh)] rounded-md object-cover" />
      ) : thumb ? (
        <img src={thumb.url} alt="" className="h-20 w-full rounded-md object-cover" />
      ) : (
        <div className="flex aspect-square w-32 items-center justify-center rounded-md bg-surface-2">
          <Music aria-hidden className="size-12 text-gg" />
        </div>
      )}
      {line && <p className="w-full truncate text-center text-sm font-medium">{line}</p>}
      <audio src={file.cdnUrl} controls preload="metadata" className="w-full" />
    </div>
  );
}
