import './media.css';

import { Music } from 'lucide-react';
import { useRef, useState } from 'react';

import { coverUrl, waveformUrl } from '../renderers/assets';
import type { RendererProps } from '../renderers/types';
import type { FileData } from '../types';
import { ControlRow, PeaksBar, SeekBar, SpeedMenu, VolumeControl } from './Controls';
import { NotPlayable } from './NotPlayable';
import { tagLine } from './tagLine';
import { usePeaks } from './usePeaks';
import { usePlayer, usePlayerKeys } from './usePlayer';

function Artwork({ file }: { file: FileData }) {
  const [broken, setBroken] = useState(false);
  const cover = coverUrl(file);
  const waveform = cover ? undefined : waveformUrl(file);
  if (cover && !broken) {
    return (
      <img
        src={cover}
        alt=""
        data-testid="audio-cover"
        onError={() => setBroken(true)}
        className="aspect-square w-full max-w-[min(20rem,40dvh)] rounded-xl object-cover shadow-card"
      />
    );
  }
  if (waveform && !broken) {
    return (
      <img
        src={waveform}
        alt=""
        data-testid="audio-waveform"
        onError={() => setBroken(true)}
        className="aspect-[1600/240] w-full object-fill"
      />
    );
  }
  return (
    <div className="flex aspect-square w-32 items-center justify-center rounded-xl bg-surface-2">
      <Music aria-hidden className="size-12 text-gg" />
    </div>
  );
}

/**
 * The audio player (contract §7): cover art or the waveform strip, the tag line, a
 * waveform seek bar from `peaks.json` (a plain bar while it loads or if it fails), and
 * the same controls and saved volume as video, minus fullscreen.
 */
export default function AudioRenderer({ file, context = 'card' }: RendererProps) {
  const [failed, setFailed] = useState(false);
  const line = tagLine(file);
  const unplayable = failed || file.media?.playable === false;

  return (
    <div className="viewer-well w-[min(35rem,var(--media-max-width))] flex-col gap-3 p-4">
      <Artwork file={file} />
      {line && (
        <p className="w-full truncate text-center text-sm font-medium" title={line}>
          {line}
        </p>
      )}
      {unplayable ? (
        <NotPlayable file={file} kind="audio" />
      ) : (
        <AudioPlayer file={file} context={context} onError={() => setFailed(true)} />
      )}
    </div>
  );
}

function AudioPlayer({
  file,
  context,
  onError,
}: {
  file: FileData;
  context: NonNullable<RendererProps['context']>;
  onError: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const player = usePlayer(audio, file.duration);
  usePlayerKeys(rootRef, player, { globalKeys: context === 'card' });
  const peaks = usePeaks(file.assets?.peaks?.url);
  const { state } = player;

  return (
    <div
      ref={rootRef}
      data-own-keys=""
      data-no-swipe=""
      role="region"
      aria-label={`Audio player: ${file.filename}`}
      className="flex w-full flex-col gap-1"
    >
      {/* No `controls`: the bar below drives it. */}
      <audio ref={setAudio} src={file.cdn_url} preload="metadata" onError={onError} />
      {peaks.status === 'ready' ? (
        <PeaksBar peaks={peaks.peaks} state={state} onSeek={player.seek} />
      ) : (
        <SeekBar state={state} onSeek={player.seek} tall />
      )}
      <ControlRow state={state} player={player}>
        <VolumeControl state={state} player={player} />
        <SpeedMenu state={state} player={player} />
      </ControlRow>
    </div>
  );
}
