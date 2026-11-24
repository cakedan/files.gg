/** Tracklist playback queue: prev/next with shuffle and repeat (off / all / one). */

export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueState {
  /** Index into the tracks of the one playing. */
  current: number;
  /** Play order: identity, or a shuffled permutation starting at the current track. */
  order: number[];
  shuffle: boolean;
  repeat: RepeatMode;
}

export const identity = (count: number): number[] => Array.from({ length: count }, (_, i) => i);

/** Fisher–Yates with an injectable random source; `first` is moved to the front. */
export function shuffledOrder(count: number, first: number, random: () => number = Math.random): number[] {
  const rest = identity(count).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return count > 0 ? [first, ...rest] : [];
}

export function createQueue(count: number, current = 0): QueueState {
  return { current, order: identity(count), shuffle: false, repeat: 'off' };
}

export function setShuffle(state: QueueState, shuffle: boolean, random?: () => number): QueueState {
  const count = state.order.length;
  return { ...state, shuffle, order: shuffle ? shuffledOrder(count, state.current, random) : identity(count) };
}

export const nextRepeat = (mode: RepeatMode): RepeatMode => (mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off');

/**
 * The track after the current one, or null when playback should stop.
 * `ended` is true when the track finished on its own (repeat-one replays it);
 * a Next press skips ahead even in repeat-one.
 */
export function nextTrack(state: QueueState, ended: boolean): number | null {
  const { order, current, repeat } = state;
  if (order.length === 0) return null;
  if (ended && repeat === 'one') return current;
  const position = order.indexOf(current);
  const next = position + 1;
  if (next < order.length) return order[next]!;
  return repeat === 'off' && ended ? null : order[0]!;
}

/** Previous in play order; wraps only when repeat is on. */
export function previousTrack(state: QueueState): number {
  const { order, current, repeat } = state;
  const position = order.indexOf(current);
  if (position > 0) return order[position - 1]!;
  return repeat === 'off' ? current : (order[order.length - 1] ?? current);
}

/** "4:05", or "1:02:03" past an hour. */
export function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
