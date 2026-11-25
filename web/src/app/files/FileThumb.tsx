import { Ban, EyeOff, Loader2, Music, Play, Trash2 } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import type { OwnerFile } from '../../lib/api';
import { thumbnailView } from '../../lib/files/thumbnail';
import { useRefetchExpiredUrls } from '../../lib/queries';
import { useSignedValue } from '../../lib/signedUrls';
import { FileTypeIcon } from '../../viewer/renderers/FileTypeIcon';
import { SAFETY_BADGES } from '../safety/labels';
import { useShowSensitive } from '../safety/sensitive';

interface FileThumbProps {
  file: OwnerFile;
  /** Hovered or focused: plays the hover clip. */
  active?: boolean;
  size?: 'sm' | 'lg';
  className?: string;
}

/** §4.6: NSFW tiles are blurred with an eye-off icon until "Always show sensitive media". */
const SENSITIVE_BLUR: CSSProperties = { filter: 'blur(16px)', transform: 'scale(1.15)' };

const STATE_ICONS = { pending: Loader2, hidden: EyeOff, removed: Trash2, blocked: Ban } as const;

/**
 * The thumbnail for a row or tile (lib/files/thumbnail.ts has the rules). The payload's
 * URLs are used as they are (signed for 1 h when protected). A list refetch brings new
 * signatures for the same images, so the ones on screen stay until they near expiry.
 *
 * Milestone 4: a file that isn't `ok` or `flagged` shows its state instead of media (the
 * CDN won't serve it, §2.4), and an NSFW file is blurred with no hover clip (§4.6).
 */
export function FileThumb({ file: latest, active = false, size = 'sm', className = '' }: FileThumbProps) {
  const file = useSignedValue(latest, { showChangesAtOnce: true });
  const view = thumbnailView(file);
  const refetchExpired = useRefetchExpiredUrls();
  const [broken, setBroken] = useState<string | null>(null);
  const [hoverBroken, setHoverBroken] = useState(false);
  const [showSensitive] = useShowSensitive();
  const small = size === 'sm';
  const iconSize = small ? 'size-5' : 'size-10';
  const frame = `relative flex shrink-0 items-center justify-center overflow-hidden bg-well ${small ? 'size-10 rounded-md' : 'aspect-[4/3] w-full'} ${className}`;
  const blurred = Boolean(file.nsfw) && !showSensitive;
  const sensitiveMark = blurred && (
    <span className="absolute inset-0 flex items-center justify-center" data-testid="sensitive-overlay">
      <span className={`inline-flex items-center justify-center rounded-full bg-black/60 text-white ${small ? 'size-6' : 'size-9'}`}>
        <EyeOff aria-hidden className={small ? 'size-3.5' : 'size-5'} />
      </span>
      <span className="sr-only">Sensitive content</span>
    </span>
  );

  const state = file.safety?.state;
  if (state === 'pending' || state === 'hidden' || state === 'removed' || state === 'blocked') {
    const Icon = STATE_ICONS[state];
    return (
      <span className={`${frame} ${state === 'pending' ? 'animate-pulse' : ''}`} title={SAFETY_BADGES[state]}>
        <Icon aria-hidden className={`${iconSize} ${state === 'pending' ? 'animate-spin text-muted/60' : state === 'hidden' ? 'text-warn' : 'text-danger'}`} />
        <span className="sr-only">{SAFETY_BADGES[state]}</span>
      </span>
    );
  }

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
          style={blurred ? SENSITIVE_BLUR : undefined}
          className={`w-full overflow-hidden p-1 font-mono whitespace-pre text-muted ${small ? 'text-[4px] leading-[5px]' : 'p-2 text-[9px] leading-3'}`}
        >
          {view.text}
        </pre>
        {sensitiveMark}
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
          style={blurred ? SENSITIVE_BLUR : undefined}
          data-sensitive={blurred ? 'blurred' : undefined}
          className={`size-full object-cover ${file.kind === 'image' ? 'checkerboard' : ''}`}
        />
        {sensitiveMark}
        {active && !blurred && view.hover && !hoverBroken && (
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
      {sensitiveMark}
      {!small && file.kind === 'file' && file.extension && (
        <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
          {file.extension}
        </span>
      )}
    </span>
  );
}
