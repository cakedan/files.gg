import { EyeOff, Images, Lock } from 'lucide-react';
import { useState } from 'react';

import type { OwnerAlbumSummary } from '../../lib/api';
import { useRefetchExpiredUrls } from '../../lib/queries';
import { useSignedValue } from '../../lib/signedUrls';
import { useShowSensitive } from '../safety/sensitive';

/**
 * The collage, else the cover. Owner payloads carry the URLs ready to use (signed for
 * 1 h for a protected album), and a refetch keeps the image on screen until its URL
 * nears expiry. Protected albums get a lock badge.
 */
export function AlbumCover({ album, className = '' }: { album: Pick<OwnerAlbumSummary, 'collage' | 'cover' | 'visibility' | 'nsfw'>; className?: string }) {
  const locked = album.visibility !== 'link';
  // Milestone 4 §4.6: sensitive albums are blurred like file tiles.
  const [showSensitive] = useShowSensitive();
  const blurred = Boolean(album.nsfw) && !showSensitive;
  const latest = album.collage?.url ?? album.cover?.url;
  const src = useSignedValue(latest, { showChangesAtOnce: true });
  const refetchExpired = useRefetchExpiredUrls();
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span className={`relative flex aspect-[1200/630] w-full items-center justify-center overflow-hidden bg-well ${className}`}>
      {src && broken !== src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => {
            setBroken(src);
            refetchExpired(src);
          }}
          style={blurred ? { filter: 'blur(16px)', transform: 'scale(1.15)' } : undefined}
          data-sensitive={blurred ? 'blurred' : undefined}
          className="size-full object-cover"
        />
      ) : (
        <Images aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
      )}
      {blurred && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
            <EyeOff aria-hidden className="size-5" />
          </span>
          <span className="sr-only">Sensitive content</span>
        </span>
      )}
      {locked && (
        <span className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-full bg-black/70 text-white">
          <Lock aria-hidden className="size-3.5" />
        </span>
      )}
    </span>
  );
}
