import './album.css';

import { useEffect, useState } from 'react';

import type { AlbumData } from '../types';
import { AlbumGrid } from './AlbumGrid';
import { AlbumHeader } from './AlbumHeader';
import { AlbumLightbox } from './AlbumLightbox';
import { AlbumList } from './AlbumList';
import { AlbumTracklist } from './AlbumTracklist';
import { albumShareUrl } from './albumUrl';
import { albumName, chooseLayout } from './layout';
import { NsfwGate } from './NsfwGate';
import { useAlbumLightbox } from './useAlbumLightbox';

/** `files.gg/a/<vanity>` (lazy chunk; single-file pages never load it). */
export default function AlbumPage({ album }: { album: AlbumData }) {
  const [revealed, setRevealed] = useState(!album.nsfw);
  const { index, open, go, close } = useAlbumLightbox(album.vanity, album.items.length);
  const layout = chooseLayout(album);
  const shareUrl = albumShareUrl(album.vanity, album.url);
  const title = album.title || (layout === 'tracklist' ? albumName(album.items) : null) || 'Untitled album';

  useEffect(() => {
    document.title = `${title} · files.gg`;
  }, [title]);

  if (!revealed) return <NsfwGate onContinue={() => setRevealed(true)} />;

  return (
    <main className="mx-auto flex w-full max-w-[72rem] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-8">
      <AlbumHeader album={album} shareUrl={shareUrl} title={title} />
      {layout === 'grid' && <AlbumGrid items={album.items} onOpen={open} />}
      {layout === 'list' && <AlbumList items={album.items} onOpen={open} />}
      {layout === 'tracklist' && <AlbumTracklist album={album} title={title} />}
      {album.nextCursor && (
        <p className="text-center text-sm text-muted">
          Showing the first {album.items.length} of {album.count} files.
        </p>
      )}
      {index !== null && layout !== 'tracklist' && (
        <AlbumLightbox items={album.items} index={index} onGo={go} onClose={close} />
      )}
    </main>
  );
}
