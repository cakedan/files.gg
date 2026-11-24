import { FileText, Music, Play } from 'lucide-react';
import { useRef, useState } from 'react';

import { FileTypeIcon } from '../renderers/FileTypeIcon';
import type { AlbumItem } from '../types';

interface AlbumTileProps {
  item: AlbumItem;
  index: number;
  count: number;
  width: number;
  height: number;
  onOpen: (index: number) => void;
}

/** One grid tile: image, video poster + ▶ + hover clip, audio cover, PDF thumb, or a type tile. */
export function AlbumTile({ item, index, count, width, height, onOpen }: AlbumTileProps) {
  const [hovering, setHovering] = useState(false);
  const [broken, setBroken] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const thumb = item.thumbnail?.url;
  const image = item.kind === 'image' ? (thumb ?? item.cdnUrl) : thumb;

  let body;
  if (image && !broken) {
    body = (
      <img
        src={image}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className={`absolute inset-0 size-full ${item.kind === 'image' ? 'checkerboard' : 'bg-white'} object-cover`}
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
      {item.kind === 'video' && item.hover_url && hovering && (
        <video
          ref={videoRef}
          src={item.hover_url}
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
