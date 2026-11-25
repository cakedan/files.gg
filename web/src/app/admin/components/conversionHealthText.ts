import type { ConversionHealth as Health } from '../adminApi';

/** The admin conversion card's helpers (ConversionHealth.tsx). */

export function count(jobs: Health['jobs'], field: string): number {
  const value = Number(jobs[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function formatWait(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** The most common failure reasons across every queue (`failures:<queue>:<reason>`), most first; cancels aren't failures. */
export function topFailures(jobs: Health['jobs'], limit = 5): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const field of Object.keys(jobs)) {
    const [kind, , ...rest] = field.split(':');
    if (kind !== 'failures' || rest.length === 0) continue;
    const reason = rest.join(':');
    // someone pressing Cancel isn't a failure; it has its own column
    if (reason === 'cancelled') continue;
    totals.set(reason, (totals.get(reason) ?? 0) + count(jobs, field));
  }
  return [...totals.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);
}
