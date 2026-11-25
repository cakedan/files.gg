import { Images, Lock } from 'lucide-react';
import { useState } from 'react';

import type { OwnerAlbumSummary } from '../../lib/api';
import { useRefetchExpiredUrls } from '../../lib/queries';
import { useSignedValue } from '../../lib/signedUrls';

/**
 * The collage, else the cover. Owner payloads carry the URLs ready to use (signed for
 * 1 h for a protected album), and a refetch keeps the image on screen until its URL
 * nears expiry. Protected albums get a lock badge.
 */
export function AlbumCover({ album, className = '' }: { album: Pick<OwnerAlbumSummary, 'collage' | 'cover' | 'visibility'>; className?: string }) {
  const locked = album.visibility !== 'link';
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
          className="size-full object-cover"
        />
      ) : (
        <Images aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
      )}
      {locked && (
        <span className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-full bg-black/70 text-white">
          <Lock aria-hidden className="size-3.5" />
        </span>
      )}
    </span>
  );
}
