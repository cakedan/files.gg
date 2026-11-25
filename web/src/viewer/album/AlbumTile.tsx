import { FileText, Music, Play } from 'lucide-react';
import { useRef, useState } from 'react';

import { tileImage } from '../renderers/assets';
import { FileTypeIcon } from '../renderers/FileTypeIcon';
import type { AlbumItem, FileKind } from '../types';

interface AlbumTileProps {
  item: AlbumItem;
  index: number;
  count: number;
  width: number;
  height: number;
  onOpen: (index: number) => void;
}

/**
 * One grid tile: image, video poster + ▶ + hover clip, audio cover, PDF thumb, or a type
 * tile. Derived `thumb` / `thumb-2x` are used through `srcset` when present; while an
 * item is still processing it has none, so the type icon shows instead.
 */
/**
 * What shows behind a tile's thumbnail while it loads (and through any transparency): a checkerboard for
 * images, white for page thumbnails (PDFs, and `file`s, whose only thumbnails are document previews'
 * first pages), and the dark surface for everything else, so a video's tile doesn't flash white on the dark page.
 */
function tileBackdrop(kind: FileKind) {
  if (kind === 'image') return 'checkerboard';
  if (kind === 'pdf' || kind === 'file') return 'bg-white';
  return 'bg-surface-2';
}

export function AlbumTile({ item, index, count, width, height, onOpen }: AlbumTileProps) {
  const [hovering, setHovering] = useState(false);
  const [broken, setBroken] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const image = tileImage(item, width);
  const hoverClip = item.hover_url && (item.kind === 'video' || item.kind === 'image') ? item.hover_url : undefined;

  let body;
  if (image && !broken) {
    body = (
      <img
        src={image.src}
        srcSet={image.srcSet}
        sizes={image.sizes}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className={`absolute inset-0 size-full ${tileBackdrop(item.kind)} object-cover`}
      />
    );
  } else {
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-2 p-2 text-center">
        {item.kind === 'audio' ? (
          <Music aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
        ) : item.kind === 'pdf' ? (
          <FileText aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
        ) : (
          <FileTypeIcon kind={item.kind} mimetype={item.mimetype} className="size-10 text-gg" strokeWidth={1.5} />
        )}
        <span className="max-w-full truncate text-xs text-muted">{item.filename}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      onMouseEnter={() => {
        setHovering(true);
        void videoRef.current?.play().catch(() => undefined);
      }}
      onMouseLeave={() => setHovering(false)}
      aria-label={`Open ${item.filename} (${index + 1} of ${count})`}
      className="group relative block overflow-hidden rounded-md bg-well"
      style={{ width, height }}
    >
      {body}
      {hoverClip && hovering && (
        <video
          ref={videoRef}
          src={hoverClip}
          muted
          loop
          autoPlay
          playsInline
          aria-hidden
          data-testid="hover-clip"
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {item.kind === 'video' && (
        <span className="absolute top-2 left-2 inline-flex size-7 items-center justify-center rounded-full bg-black/60 text-white">
          <Play aria-hidden className="size-3.5 fill-current" />
        </span>
      )}
      {(item.kind === 'pdf' || item.kind === 'file') && (
        <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
          {item.extension || item.kind}
        </span>
      )}
      <span className="absolute inset-0 rounded-md ring-gg/70 transition group-hover:ring-2 group-focus-visible:ring-2" />
    </button>
  );
}
