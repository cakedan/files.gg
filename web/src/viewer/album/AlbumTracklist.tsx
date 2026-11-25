import { Download, Music, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { formatBytes } from '../../lib/format';
import type { AlbumData, AlbumItem } from '../types';
import { downloadUrl } from '../urls';
import { albumArtist, albumName, trackTitle } from './layout';
import { createQueue, formatDuration, nextRepeat, nextTrack, previousTrack, setShuffle, type QueueState } from './playback';

const trackDuration = (item: AlbumItem) => item.media?.duration ?? item.duration;

function CoverArt({ url, className }: { url: string | undefined; className: string }) {
  return url ? (
    <img src={url} alt="" className={`${className} object-cover`} />
  ) : (
    <div className={`${className} flex items-center justify-center bg-surface-2`}>
      <Music aria-hidden className="size-1/3 text-gg" />
    </div>
  );
}

/**
 * All-audio albums: large cover, artist and album from tags, numbered tracks, and
 * continuous playback through a persistent bar (prev, next, shuffle, repeat) on a
 * plain <audio> element. The custom player comes in a later milestone.
 */
export function AlbumTracklist({ album, title }: { album: AlbumData; title: string }) {
  const tracks = album.items;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<QueueState>(() => createQueue(tracks.length));
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const shouldPlay = useRef(false);

  const firstCover = tracks.find((t) => t.thumbnail?.type === 'cover')?.thumbnail?.url;
  const cover = album.cover?.url ?? firstCover;
  const artist = albumArtist(tracks);
  const name = albumName(tracks);
  const totalMs = tracks.reduce((sum, t) => sum + (trackDuration(t) ?? 0), 0);
  const current = tracks[queue.current]!;

  const play = (index: number) => {
    shouldPlay.current = true;
    setStarted(true);
    if (index === queue.current) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play().catch(() => undefined);
      }
    } else {
      setQueue((q) => ({ ...q, current: index }));
    }
  };

  // Start the new track once its src is set.
  const currentIndex = queue.current;
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && shouldPlay.current) void audio.play().catch(() => undefined);
  }, [currentIndex]);

  const advance = (ended: boolean) => {
    const next = nextTrack(queue, ended);
    if (next === null) {
      shouldPlay.current = false;
      return;
    }
    play(next);
  };

  return (
    <div className="flex flex-col gap-4 pb-40">
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 shadow-card sm:flex-row sm:items-end sm:p-5">
        <CoverArt url={cover} className="aspect-square w-full max-w-[16rem] shrink-0 self-center rounded-md sm:w-48 sm:self-auto" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Album</p>
          <h2 className="text-xl font-semibold break-words sm:text-2xl">{name ?? title}</h2>
          {artist && <p className="text-sm">{artist}</p>}
          <p className="text-sm text-muted">
            {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
            {totalMs > 0 && ` · ${formatDuration(totalMs)}`} · {formatBytes(album.total_size)}
          </p>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => (playing ? audioRef.current?.pause() : play(queue.current))}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-gg px-5 text-sm font-semibold text-gg-ink hover:bg-gg-end"
            >
              {playing ? <Pause aria-hidden className="size-4 fill-current" /> : <Play aria-hidden className="size-4 fill-current" />}
              {playing ? 'Pause' : 'Play'}
            </button>
          </div>
        </div>
      </section>

      <ol className="overflow-hidden rounded-lg border border-line bg-surface" aria-label="Tracks">
        {tracks.map((track, index) => {
          const active = started && index === queue.current;
          const trackArtist = track.media?.tags?.artist;
          return (
            <li key={`${track.vanity ?? track.filename}-${index}`} className="flex items-center gap-1 border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => play(index)}
                aria-current={active ? 'true' : undefined}
                aria-label={`Play ${trackTitle(track)}`}
                className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 ${active ? 'text-gg' : ''}`}
              >
                <span className="w-6 shrink-0 text-right text-sm text-muted tabular-nums">
                  {active && playing ? <Play aria-hidden className="ml-auto size-3.5 fill-current text-gg" /> : index + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{trackTitle(track)}</span>
                  {trackArtist && trackArtist !== artist && <span className="truncate text-xs text-muted">{trackArtist}</span>}
                  {track.caption && <span className="truncate text-xs text-muted">{track.caption}</span>}
                </span>
                <span className="shrink-0 text-sm text-muted tabular-nums">{formatDuration(trackDuration(track))}</span>
              </button>
              <a
                href={downloadUrl(track.cdn_url)}
                download={track.filename}
                aria-label={`Download ${track.filename}`}
                className="mr-2 rounded p-2 text-muted hover:bg-surface-2 hover:text-text"
              >
                <Download aria-hidden className="size-4" />
              </a>
            </li>
          );
        })}
      </ol>

      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-3 py-2 backdrop-blur"
        role="region"
        aria-label="Player"
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 items-center gap-3 basis-48">
            <CoverArt url={current.thumbnail?.type === 'cover' ? current.thumbnail.url : cover} className="size-10 shrink-0 rounded" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{trackTitle(current)}</p>
              <p className="truncate text-xs text-muted">{current.media?.tags?.artist ?? artist ?? `Track ${queue.current + 1}`}</p>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Shuffle"
              aria-pressed={queue.shuffle}
              onClick={() => setQueue((q) => setShuffle(q, !q.shuffle))}
              className="rounded p-2 text-muted hover:text-text aria-pressed:text-gg"
            >
              <Shuffle aria-hidden className="size-4" />
            </button>
            <button type="button" aria-label="Previous track" onClick={() => play(previousTrack(queue))} className="rounded p-2 text-muted hover:text-text">
              <SkipBack aria-hidden className="size-4 fill-current" />
            </button>
            <button
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={() => (playing ? audioRef.current?.pause() : play(queue.current))}
              className="rounded-full bg-text p-2 text-bg hover:bg-white"
            >
              {playing ? <Pause aria-hidden className="size-4 fill-current" /> : <Play aria-hidden className="size-4 fill-current" />}
            </button>
            <button type="button" aria-label="Next track" onClick={() => advance(false)} className="rounded p-2 text-muted hover:text-text">
              <SkipForward aria-hidden className="size-4 fill-current" />
            </button>
            <button
              type="button"
              aria-label={`Repeat: ${queue.repeat}`}
              aria-pressed={queue.repeat !== 'off'}
              onClick={() => setQueue((q) => ({ ...q, repeat: nextRepeat(q.repeat) }))}
              className="rounded p-2 text-muted hover:text-text aria-pressed:text-gg"
            >
              {queue.repeat === 'one' ? <Repeat1 aria-hidden className="size-4" /> : <Repeat aria-hidden className="size-4" />}
            </button>
          </div>
          <audio
            ref={audioRef}
            src={current.cdn_url}
            controls
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              advance(true);
            }}
            className="h-9 w-full min-w-0 basis-full sm:basis-64 sm:flex-1"
          />
        </div>
      </div>
    </div>
  );
}
