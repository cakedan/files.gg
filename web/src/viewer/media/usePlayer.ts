import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { isEditableTarget } from '../../lib/dom';
import { ownsKeyEvent, playerKeyAction, SEEK_STEP_S } from './keys';
import { loadVolumePrefs, saveVolumePrefs } from './prefs';

/** 0.25× to 2× in 0.25 steps (Appendix A). */
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface PlayerState {
  playing: boolean;
  /** Playback has started at least once (hides the poster overlay). */
  started: boolean;
  ended: boolean;
  /** Seconds. */
  current: number;
  /** Seconds; the payload's duration until metadata loads. */
  duration: number;
  /** End of the buffered range around the playhead, in seconds. */
  buffered: number;
  volume: number;
  muted: boolean;
  rate: number;
  preservesPitch: boolean;
}

type PitchMedia = HTMLMediaElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

const readPitch = (media: PitchMedia) => media.preservesPitch ?? media.webkitPreservesPitch ?? media.mozPreservesPitch ?? true;

function bufferedEnd(media: HTMLMediaElement): number {
  const ranges = media.buffered;
  if (!ranges) return 0;
  const t = media.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t + 0.5 && t <= ranges.end(i)) return ranges.end(i);
  }
  return 0;
}

function snapshot(media: HTMLMediaElement, fallbackDuration: number, started: boolean): PlayerState {
  const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : fallbackDuration;
  return {
    playing: !media.paused && !media.ended,
    started: started || !media.paused || media.currentTime > 0,
    ended: media.ended,
    current: media.currentTime || 0,
    duration,
    buffered: bufferedEnd(media),
    volume: media.volume,
    muted: media.muted,
    rate: media.playbackRate || 1,
    preservesPitch: readPitch(media),
  };
}

const EVENTS = [
  'play',
  'pause',
  'playing',
  'ended',
  'timeupdate',
  'durationchange',
  'loadedmetadata',
  'progress',
  'volumechange',
  'ratechange',
  'seeked',
  'emptied',
] as const;

// Imperative media actions, outside the hook so the element is only touched here.

const knownDuration = (media: HTMLMediaElement, fallback: number) =>
  Number.isFinite(media.duration) && media.duration > 0 ? media.duration : fallback;

function applySavedVolume(media: HTMLMediaElement): void {
  const prefs = loadVolumePrefs();
  media.volume = prefs.volume;
  media.muted = prefs.muted;
}

function togglePlayback(media: HTMLMediaElement): void {
  if (media.paused || media.ended) void media.play()?.catch(() => undefined);
  else media.pause();
}

function seekMedia(media: HTMLMediaElement, seconds: number, fallback: number): void {
  const duration = knownDuration(media, fallback);
  media.currentTime = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds);
}

function setMediaVolume(media: HTMLMediaElement, volume: number): void {
  media.volume = Math.min(1, Math.max(0, volume));
  if (volume > 0 && media.muted) media.muted = false;
}

function toggleMediaMute(media: HTMLMediaElement): void {
  media.muted = !media.muted;
  // Unmuting at zero volume would stay silent.
  if (!media.muted && media.volume === 0) media.volume = 0.5;
}

function setMediaRate(media: HTMLMediaElement, rate: number): void {
  media.playbackRate = rate;
}

function setMediaPitch(media: PitchMedia, keep: boolean): void {
  media.preservesPitch = keep;
  if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = keep;
  if ('mozPreservesPitch' in media) media.mozPreservesPitch = keep;
}

/**
 * Player state and actions for one `<video>`/`<audio>`. Applies the saved volume and
 * mute on mount, and saves them on every `volumechange`.
 */
export function usePlayer(media: HTMLMediaElement | null, durationMs: number | undefined) {
  const fallback = durationMs ? durationMs / 1000 : 0;
  const [state, setState] = useState<PlayerState>(() => ({
    playing: false,
    started: false,
    ended: false,
    current: 0,
    duration: fallback,
    buffered: 0,
    ...loadVolumePrefs(),
    rate: 1,
    preservesPitch: true,
  }));

  useEffect(() => {
    if (!media) return;
    applySavedVolume(media);
    let started = false;
    const update = () => {
      const next = snapshot(media, fallback, started);
      started = next.started;
      setState(next);
    };
    const onVolume = () => {
      saveVolumePrefs({ volume: media.volume, muted: media.muted });
      update();
    };
    for (const name of EVENTS) media.addEventListener(name, name === 'volumechange' ? onVolume : update);
    update();
    return () => {
      for (const name of EVENTS) media.removeEventListener(name, name === 'volumechange' ? onVolume : update);
    };
  }, [media, fallback]);

  const toggle = useCallback(() => media && togglePlayback(media), [media]);
  const seek = useCallback((seconds: number) => media && seekMedia(media, seconds, fallback), [media, fallback]);
  const seekBy = useCallback(
    (delta: number) => media && seekMedia(media, media.currentTime + delta, fallback),
    [media, fallback],
  );
  const setVolume = useCallback((volume: number) => media && setMediaVolume(media, volume), [media]);
  const toggleMute = useCallback(() => media && toggleMediaMute(media), [media]);
  const setRate = useCallback((rate: number) => media && setMediaRate(media, rate), [media]);
  const setPreservesPitch = useCallback(
    (keep: boolean) => {
      if (!media) return;
      setMediaPitch(media, keep);
      setState((s) => ({ ...s, preservesPitch: keep }));
    },
    [media],
  );

  return { state, toggle, seek, seekBy, setVolume, toggleMute, setRate, setPreservesPitch };
}

export type PlayerApi = ReturnType<typeof usePlayer>;

/**
 * Space/k, ←/→, m and f while focus is inside the player, or (on a single-file page,
 * `globalKeys`) while nothing else has focus.
 */
export function usePlayerKeys(
  rootRef: RefObject<HTMLElement | null>,
  player: PlayerApi,
  { globalKeys, onFullscreen }: { globalKeys: boolean; onFullscreen?: (() => void) | undefined },
) {
  const latest = useRef({ player, onFullscreen });
  useEffect(() => {
    latest.current = { player, onFullscreen };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!ownsKeyEvent(rootRef.current, target, globalKeys)) return;
      const element = target instanceof Element ? target : null;
      const range = element?.closest('input[type="range"]') ?? null;
      const action = playerKeyAction(event, {
        onButton: element?.closest('button, a, [role="menuitemradio"]') != null,
        onSlider: range !== null && range.getAttribute('data-seek') === null,
        editable: isEditableTarget(target) && range === null,
        fullscreen: Boolean(latest.current.onFullscreen),
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const { player: p, onFullscreen: fs } = latest.current;
      if (action === 'toggle') p.toggle();
      else if (action === 'back') p.seekBy(-SEEK_STEP_S);
      else if (action === 'forward') p.seekBy(SEEK_STEP_S);
      else if (action === 'mute') p.toggleMute();
      else if (action === 'fullscreen') fs?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rootRef, globalKeys]);
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Fullscreen on the player container, falling back to iOS's video-only fullscreen. */
export function useFullscreen(rootRef: RefObject<HTMLElement | null>, video: HTMLVideoElement | null) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement != null && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [rootRef]);

  const toggle = useCallback(() => {
    const root = rootRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()?.catch(() => undefined);
    } else if (root?.requestFullscreen) {
      void root.requestFullscreen().catch(() => undefined);
    } else {
      (video as FullscreenVideo | null)?.webkitEnterFullscreen?.();
    }
  }, [rootRef, video]);

  return { active, toggle };
}
