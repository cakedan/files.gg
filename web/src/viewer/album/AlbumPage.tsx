import './album.css';

import { useEffect, useState } from 'react';

import { alwaysShowSensitive } from '../../lib/sensitive';
import { NsfwGate } from '../components/NsfwGate';
import { LinkWarningsContext } from '../links/webRisk';
import { siteName } from '../host/context';
import type { AlbumData } from '../types';
import { AlbumGrid } from './AlbumGrid';
import { AlbumHeader } from './AlbumHeader';
import { AlbumLightbox } from './AlbumLightbox';
import { AlbumList } from './AlbumList';
import { AlbumTracklist } from './AlbumTracklist';
import { albumShareUrl } from './albumUrl';
import { albumName, chooseLayout } from './layout';
import { useAlbumLightbox } from './useAlbumLightbox';
import { ViewerFooterNav } from '../components/ViewerFooterNav';

const NONE: string[] = [];

/** `files.gg/a/<vanity>` (lazy chunk; single-file pages never load it). */
export default function AlbumPage({ album }: { album: AlbumData }) {
  // Milestone 4 §4.4/§4.6: the album's own mark, or any shown item being NSFW.
  const [revealed, setRevealed] = useState(() => !(album.nsfw || album.items.some((item) => item.nsfw)) || alwaysShowSensitive());
  const { index, open, go, close } = useAlbumLightbox(album.vanity, album.items.length);
  const layout = chooseLayout(album);
  const shareUrl = albumShareUrl(album.vanity, album.url);
  const title = album.title || (layout === 'tracklist' ? albumName(album.items) : null) || 'Untitled album';

  useEffect(() => {
    document.title = `${title} · ${siteName()}`;
  }, [title]);

  if (!revealed) return <NsfwGate kind="album" onShow={() => setRevealed(true)} />;

  return (
    <LinkWarningsContext value={album.link_warnings ?? NONE}>
      <main className="mx-auto flex w-full max-w-[72rem] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-8">
        <AlbumHeader album={album} shareUrl={shareUrl} title={title} />
        {layout === 'grid' && <AlbumGrid items={album.items} onOpen={open} />}
        {layout === 'list' && <AlbumList items={album.items} onOpen={open} />}
        {layout === 'tracklist' && <AlbumTracklist album={album} title={title} />}
        {album.next_cursor && (
          <p className="text-center text-sm text-muted">
            Showing the first {album.items.length} of {album.count} files.
          </p>
        )}
        {/* Report is in the header; this adds Terms, Privacy and the mark, as under a file. */}
        <ViewerFooterNav className="pt-4 pb-2" />
        {index !== null && layout !== 'tracklist' && (
          <AlbumLightbox items={album.items} index={index} onGo={go} onClose={close} />
        )}
      </main>
    </LinkWarningsContext>
  );
}
