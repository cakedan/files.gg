import { Maximize, Minimize, Pause, Play, RotateCcw, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { downsamplePeaks, peaksPath } from './peaks';
import { formatTime, spokenTime } from './time';
import { SPEEDS, type PlayerApi, type PlayerState } from './usePlayer';

const iconButton =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-text transition-colors hover:bg-white/10 focus-visible:bg-white/10';

export function PlayButton({ state, onToggle }: { state: PlayerState; onToggle: () => void }) {
  const Icon = state.playing ? Pause : state.ended ? RotateCcw : Play;
  const label = state.playing ? 'Pause' : state.ended ? 'Replay' : 'Play';
  return (
    <button type="button" className={iconButton} onClick={onToggle} aria-label={label} title={`${label} (k)`}>
      <Icon aria-hidden className={`size-5 ${state.playing || state.ended ? '' : 'fill-current'}`} />
    </button>
  );
}

export function TimeLabel({ state }: { state: PlayerState }) {
  return (
    <span className="shrink-0 px-1 text-xs whitespace-nowrap text-text tabular-nums">
      {formatTime(state.current, state.duration)}
      {/* No "/ 0:00" before the length is known (a file still processing has none yet). */}
      {state.duration > 0 && <span className="text-muted"> / {formatTime(state.duration)}</span>}
    </span>
  );
}

const pct = (value: number, total: number) => (total > 0 ? `${Math.min(100, Math.max(0, (value / total) * 100))}%` : '0%');

/** The seek slider: a native range input (keyboard, pointer drag, accessibility) over a drawn track. */
function SeekInput({ state, onSeek }: { state: PlayerState; onSeek: (seconds: number) => void }) {
  return (
    <input
      type="range"
      data-seek=""
      min={0}
      max={state.duration || 0}
      step="any"
      value={Math.min(state.current, state.duration || 0)}
      disabled={!(state.duration > 0)}
      onChange={(event) => onSeek(Number(event.currentTarget.value))}
      aria-label="Seek"
      aria-valuetext={`${spokenTime(state.current)} of ${spokenTime(state.duration)}`}
      className="player-range absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
    />
  );
}

/** Plain seek bar with the buffered range (video, and audio while peaks load or when they fail). */
export function SeekBar({ state, onSeek, tall = false }: { state: PlayerState; onSeek: (seconds: number) => void; tall?: boolean }) {
  return (
    <div className={`player-seek group/seek relative flex w-full items-center ${tall ? 'h-10' : 'h-4'}`} data-testid="seek-bar">
      <div className="pointer-events-none relative h-1.5 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-active/seek:h-2">
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: pct(state.buffered, state.duration) }} data-testid="seek-buffered" />
        <div className="absolute inset-y-0 left-0 bg-gg" style={{ width: pct(state.current, state.duration) }} />
      </div>
      <SeekInput state={state} onSeek={onSeek} />
    </div>
  );
}

const PEAK_BARS = 160;

/** Waveform seek bar drawn from `peaks.json`: the played part in brand green. */
export function PeaksBar({ peaks, state, onSeek }: { peaks: number[]; state: PlayerState; onSeek: (seconds: number) => void }) {
  const clipId = useId();
  const bars = useMemo(() => downsamplePeaks(peaks, PEAK_BARS), [peaks]);
  const path = useMemo(() => peaksPath(bars), [bars]);
  const played = state.duration > 0 ? Math.min(1, state.current / state.duration) * bars.length : 0;
  return (
    <div className="player-seek relative h-14 w-full" data-testid="peaks-bar">
      <svg
        aria-hidden
        viewBox={`0 0 ${bars.length} 100`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={played} height="100" />
          </clipPath>
        </defs>
        <path d={path} fill="currentColor" className="text-white/25" />
        <path d={path} fill="var(--gg)" clipPath={`url(#${clipId})`} />
      </svg>
      <SeekInput state={state} onSeek={onSeek} />
    </div>
  );
}

export function VolumeControl({ state, player }: { state: PlayerState; player: PlayerApi }) {
  const silent = state.muted || state.volume === 0;
  const Icon = silent ? VolumeX : state.volume < 0.5 ? Volume1 : Volume2;
  const shown = state.muted ? 0 : state.volume;
  return (
    <div className="group/volume flex items-center">
      <button
        type="button"
        className={iconButton}
        onClick={player.toggleMute}
        aria-label={silent ? 'Unmute' : 'Mute'}
        aria-pressed={state.muted}
        title={`${silent ? 'Unmute' : 'Mute'} (m)`}
      >
        <Icon aria-hidden className="size-5" />
      </button>
      <div className="player-volume relative flex h-9 w-20 items-center max-sm:hidden">
        <div className="pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-white/20">
          <div className="absolute inset-y-0 left-0 bg-text" style={{ width: `${shown * 100}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={shown}
          onChange={(event) => player.setVolume(Number(event.currentTarget.value))}
          aria-label="Volume"
          aria-valuetext={`${Math.round(shown * 100)}%`}
          className="player-range absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}

const speedLabel = (rate: number) => `${rate}×`;

/** Speed (0.25× to 2×) and the keep-pitch toggle in a small popover. */
export function SpeedMenu({ state, player }: { state: PlayerState; player: PlayerApi }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          // Handled here, so an album lightbox around the player stays open.
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`${iconButton} w-auto min-w-9 px-1.5 text-xs font-semibold tabular-nums`}
        onClick={() => setOpen(!open)}
        aria-label={`Playback speed: ${speedLabel(state.rate)}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {speedLabel(state.rate)}
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Playback speed"
          className="absolute right-0 bottom-full z-20 mb-2 flex w-44 flex-col gap-1 rounded-2xl border border-line bg-surface p-2 text-sm text-text shadow-card"
        >
          <div className="grid grid-cols-4 gap-1">
            {SPEEDS.map((rate) => (
              <button
                key={rate}
                type="button"
                aria-pressed={state.rate === rate}
                onClick={() => player.setRate(rate)}
                className={`rounded px-1 py-1 text-xs tabular-nums ${state.rate === rate ? 'bg-gg font-semibold text-gg-ink' : 'hover:bg-surface-2'}`}
              >
                {speedLabel(rate)}
              </button>
            ))}
          </div>
          <label className="mt-1 flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-surface-2">
            <input
              type="checkbox"
              checked={state.preservesPitch}
              onChange={(event) => player.setPreservesPitch(event.currentTarget.checked)}
              className="accent-[var(--gg)]"
            />
            Keep pitch
          </label>
        </div>
      )}
    </div>
  );
}

export function FullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const label = active ? 'Exit full screen' : 'Full screen';
  return (
    <button type="button" className={iconButton} onClick={onToggle} aria-label={label} title={`${label} (f)`}>
      {active ? <Minimize aria-hidden className="size-5" /> : <Maximize aria-hidden className="size-5" />}
    </button>
  );
}

/** The 40px control row. `children` go on the right (volume, speed, fullscreen). */
export function ControlRow({ state, player, children, style }: { state: PlayerState; player: PlayerApi; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="flex h-10 w-full items-center gap-0.5" style={style}>
      <PlayButton state={state} onToggle={player.toggle} />
      <TimeLabel state={state} />
      <div className="flex-1" />
      {children}
    </div>
  );
}
