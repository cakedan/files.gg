import { describe, expect, it } from 'vitest';

import { createQueue, formatDuration, nextRepeat, nextTrack, previousTrack, setShuffle, shuffledOrder } from './playback';

describe('playback queue', () => {
  it('plays in order and stops at the end with repeat off', () => {
    const q = createQueue(3);
    expect(nextTrack(q, true)).toBe(1);
    expect(nextTrack({ ...q, current: 2 }, true)).toBeNull();
    expect(nextTrack({ ...q, current: 2 }, false)).toBe(0); // a Next press wraps
  });

  it('repeat all wraps; repeat one replays on end but Next still skips', () => {
    const q = { ...createQueue(3), current: 2 };
    expect(nextTrack({ ...q, repeat: 'all' }, true)).toBe(0);
    expect(nextTrack({ ...q, repeat: 'one' }, true)).toBe(2);
    expect(nextTrack({ ...q, repeat: 'one' }, false)).toBe(0);
  });

  it('previous stops at the start unless repeating', () => {
    const q = createQueue(3);
    expect(previousTrack({ ...q, current: 1 })).toBe(0);
    expect(previousTrack(q)).toBe(0);
    expect(previousTrack({ ...q, repeat: 'all' })).toBe(2);
  });

  it('shuffle keeps the current track first and visits every track once', () => {
    const order = shuffledOrder(6, 3, () => 0.42);
    expect(order[0]).toBe(3);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const q = setShuffle({ ...createQueue(6), current: 3 }, true, () => 0.1);
    expect(q.order[0]).toBe(3);
    expect(nextTrack(q, true)).toBe(q.order[1]);
    expect(setShuffle(q, false).order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('cycles repeat modes', () => {
    expect(nextRepeat('off')).toBe('all');
    expect(nextRepeat('all')).toBe('one');
    expect(nextRepeat('one')).toBe('off');
  });

  it('formats durations', () => {
    expect(formatDuration(4000)).toBe('0:04');
    expect(formatDuration(245_000)).toBe('4:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(undefined)).toBe('');
  });
});
