import { Loader2, Music, Play } from 'lucide-react';
import { useState } from 'react';

import type { OwnerFile } from '../../lib/api';
import { thumbnailView } from '../../lib/files/thumbnail';
import { useRefetchExpiredUrls } from '../../lib/queries';
import { useSignedValue } from '../../lib/signedUrls';
import { FileTypeIcon } from '../../viewer/renderers/FileTypeIcon';

interface FileThumbProps {
  file: OwnerFile;
  /** Hovered or focused: plays the hover clip. */
  active?: boolean;
  size?: 'sm' | 'lg';
  className?: string;
}

/**
 * The thumbnail for a row or tile (lib/files/thumbnail.ts has the rules). The payload's
 * URLs are used as they are (signed for 1 h when protected). A list refetch brings new
 * signatures for the same images, so the ones on screen stay until they near expiry.
 */
export function FileThumb({ file: latest, active = false, size = 'sm', className = '' }: FileThumbProps) {
  const file = useSignedValue(latest, { showChangesAtOnce: true });
  const view = thumbnailView(file);
  const refetchExpired = useRefetchExpiredUrls();
  const [broken, setBroken] = useState<string | null>(null);
  const [hoverBroken, setHoverBroken] = useState(false);
  const small = size === 'sm';
  const iconSize = small ? 'size-5' : 'size-10';
  const frame = `relative flex shrink-0 items-center justify-center overflow-hidden bg-well ${small ? 'size-10 rounded-md' : 'aspect-[4/3] w-full'} ${className}`;

  if (view.type === 'processing') {
    return (
      <span className={`${frame} animate-pulse`} title="Processing">
        <Loader2 aria-hidden className={`${iconSize} animate-spin text-muted/60`} />
        <span className="sr-only">Processing</span>
      </span>
    );
  }

  if (view.type === 'snippet') {
    return (
      <span className={`${frame} items-start justify-start bg-bg`}>
        <pre
          aria-hidden
          className={`w-full overflow-hidden p-1 font-mono whitespace-pre text-muted ${small ? 'text-[4px] leading-[5px]' : 'p-2 text-[9px] leading-3'}`}
        >
          {view.text}
        </pre>
      </span>
    );
  }

  if (view.type === 'image' && broken !== view.src) {
    return (
      <span className={frame}>
        <img
          src={view.src}
          srcSet={view.srcSet}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => {
            setBroken(view.src);
            refetchExpired(view.src);
          }}
          className={`size-full object-cover ${file.kind === 'image' ? 'checkerboard' : ''}`}
        />
        {active && view.hover && !hoverBroken && (
          <video
            src={view.hover}
            muted
            loop
            autoPlay
            playsInline
            aria-hidden
            data-testid="hover-clip"
            onError={() => setHoverBroken(true)}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {view.badge === 'play' && (
          <span
            className={`absolute inline-flex items-center justify-center rounded-full bg-black/60 text-white ${
              small ? 'right-0.5 bottom-0.5 size-4' : 'top-2 left-2 size-7'
            }`}
          >
            <Play aria-hidden className={`${small ? 'size-2' : 'size-3.5'} fill-current`} />
          </span>
        )}
      </span>
    );
  }

  const music = view.type === 'icon' && view.music;
  return (
    <span className={frame}>
      {music ? (
        <Music aria-hidden className={`${iconSize} text-gg`} strokeWidth={1.5} />
      ) : (
        <FileTypeIcon kind={file.kind} mimetype={file.mimetype} className={`${iconSize} text-gg`} strokeWidth={1.5} />
      )}
      {!small && file.kind === 'file' && file.extension && (
        <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
          {file.extension}
        </span>
      )}
    </span>
  );
}
