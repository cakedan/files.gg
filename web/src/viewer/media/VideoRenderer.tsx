import './media.css';

import { Play } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { posterUrl } from '../renderers/assets';
import { FileTypeIcon } from '../renderers/FileTypeIcon';
import type { RendererProps } from '../renderers/types';
import { ControlRow, FullscreenButton, SeekBar, SpeedMenu, VolumeControl } from './Controls';
import { NotPlayable } from './NotPlayable';
import { useFullscreen, usePlayer, usePlayerKeys } from './usePlayer';

/** Controls and cursor hide after this long without movement while playing (Appendix A). */
export const IDLE_HIDE_MS = 2500;

/**
 * The video player (contract §7): poster, custom controls (play, seek with the buffered
 * range, time, volume, speed and keep pitch, fullscreen), keyboard shortcuts and saved
 * volume. `playable: false`, or a load error, shows Download instead.
 */
export default function VideoRenderer({ file, context = 'card' }: RendererProps) {
  const [failed, setFailed] = useState(false);
  const sized = Boolean(file.width && file.height);
  const style = (sized ? { '--media-w': file.width, '--media-h': file.height } : {}) as CSSProperties;
  const poster = posterUrl(file);

  if (failed || file.media?.playable === false) {
    return (
      <div
        className={`viewer-well relative ${sized ? 'viewer-media-sized' : 'aspect-video w-[min(36rem,var(--media-max-width))]'}`}
        style={style}
      >
        {poster && <img src={poster} alt="" className="absolute inset-0 size-full object-cover opacity-40" />}
        <NotPlayable file={file} kind="video" />
      </div>
    );
  }

  return <VideoPlayer file={file} context={context} poster={poster} style={style} sized={sized} onError={() => setFailed(true)} />;
}

function VideoPlayer({
  file,
  context,
  poster,
  style,
  sized,
  onError,
}: Required<Pick<RendererProps, 'file' | 'context'>> & {
  poster: string | undefined;
  style: CSSProperties;
  sized: boolean;
  onError: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const player = usePlayer(video, file.duration);
  const fullscreen = useFullscreen(rootRef, video);
  usePlayerKeys(rootRef, player, { globalKeys: context === 'card', onFullscreen: fullscreen.toggle });
  const { state } = player;
  // While processing there's no poster: the type icon shows until the first frame does.
  const [hasFrame, setHasFrame] = useState(false);

  // Auto-hide: controls and cursor fade after IDLE_HIDE_MS of no movement while playing.
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const wake = () => {
    setIdle(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setIdle(true), IDLE_HIDE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hidden = idle && state.playing;

  return (
    <div
      ref={rootRef}
      data-own-keys=""
      data-idle={hidden ? '' : undefined}
      className={`player-video viewer-well relative overflow-hidden bg-black ${hidden ? 'cursor-none' : ''}`}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocusCapture={wake}
      role="region"
      aria-label={`Video player: ${file.filename}`}
    >
      <video
        ref={setVideo}
        src={file.cdn_url}
        poster={poster}
        playsInline
        preload="metadata"
        onError={onError}
        onLoadedData={() => setHasFrame(true)}
        onClick={player.toggle}
        onDoubleClick={fullscreen.toggle}
        style={style}
        className={`block bg-black ${sized ? 'viewer-media-sized' : 'viewer-media-free min-w-[var(--media-min-width)]'}`}
      />

      {!state.started && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {/* While processing there's no poster yet: the type icon holds the space (contract §7). */}
          {!poster && file.processing && !hasFrame && (
            <FileTypeIcon kind="video" mimetype={file.mimetype} strokeWidth={1.25} className="absolute size-20 text-muted/40" />
          )}
          {/* Visual only: a click lands on the video, which toggles playback. */}
          <span className="relative inline-flex size-16 items-center justify-center rounded-full bg-black/60 text-white">
            <Play aria-hidden className="ml-1 size-7 fill-current" />
          </span>
        </div>
      )}

      <div
        data-no-swipe=""
        className={`player-overlay absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-black/80 via-black/45 to-transparent px-2 pt-6 transition-opacity duration-200 ${
          hidden ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        <SeekBar state={state} onSeek={player.seek} />
        <ControlRow state={state} player={player}>
          <VolumeControl state={state} player={player} />
          <SpeedMenu state={state} player={player} />
          <FullscreenButton active={fullscreen.active} onToggle={fullscreen.toggle} />
        </ControlRow>
      </div>
    </div>
  );
}
