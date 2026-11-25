import { describe, expect, it } from 'vitest';

import { nextStep, PENDING_STALE_MS, readProgress, withProgress, type PendingProgress } from './pendingReload';

const at = (start: number, reloads: number, now: number, path = '/abc'): PendingProgress => ({ start, reloads, at: now, path });

describe('pending reload schedule (milestone-4 §11.1)', () => {
  it('reloads after 2, 3, 5, 8 and 13 s, then every 15 s, and stalls at 2 minutes', () => {
    let now = 0;
    let progress = readProgress(null, '/abc', now);
    const delays: number[] = [];
    for (;;) {
      const step = nextStep(progress, now);
      if (step.action === 'stall') {
        now += step.delay;
        break;
      }
      delays.push(step.delay);
      now += step.delay;
      progress = { ...progress, reloads: progress.reloads + 1, at: now };
    }
    expect(delays).toEqual([2000, 3000, 5000, 8000, 13_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
    // 106 s of reloads, then the stalled message at exactly 2 minutes.
    expect(now).toBe(120_000);
  });

  it('continues a run from history.state, for the same page only', () => {
    const state = withProgress({ other: 1 }, at(1000, 3, 11_000));
    expect(state.other).toBe(1);
    expect(readProgress(state, '/abc', 12_000)).toEqual(at(1000, 3, 11_000));
    expect(readProgress(state, '/elsewhere', 12_000)).toEqual(at(12_000, 0, 12_000, '/elsewhere'));
  });

  it('starts over when the saved run is from an earlier visit', () => {
    const state = withProgress(null, at(0, 4, 10_000));
    expect(readProgress(state, '/abc', 10_000 + PENDING_STALE_MS + 1)).toMatchObject({ reloads: 0 });
  });

  it('removes the run on Retry', () => {
    expect(withProgress(withProgress({ keep: true }, at(0, 1, 0)), null)).toEqual({ keep: true });
  });
});
