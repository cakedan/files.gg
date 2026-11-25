/** `peaks.json` (contract §2): `{ "version": 1, "length": 1000, "peaks": [0..1] }`. */

/** Validates a parsed peaks file. Values are clamped to [0, 1]; anything else is null. */
export function parsePeaks(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, peaks } = value as { version?: unknown; peaks?: unknown };
  if (version !== 1 || !Array.isArray(peaks) || peaks.length === 0) return null;
  const out: number[] = [];
  for (const p of peaks) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    out.push(Math.min(1, Math.max(0, p)));
  }
  return out;
}

/** Reduces peaks to `bars` buckets, keeping each bucket's maximum. */
export function downsamplePeaks(peaks: number[], bars: number): number[] {
  if (bars <= 0 || peaks.length === 0) return [];
  if (peaks.length <= bars) return peaks.slice();
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * peaks.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / bars));
    let max = 0;
    for (let j = start; j < end; j++) max = Math.max(max, peaks[j]!);
    out.push(max);
  }
  return out;
}

/** Fetches and validates peaks. Rejects on network errors, non-2xx and bad JSON. */
export async function fetchPeaks(url: string, signal?: AbortSignal): Promise<number[]> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`peaks: HTTP ${response.status}`);
  const peaks = parsePeaks(await response.json());
  if (!peaks) throw new Error('peaks: invalid file');
  return peaks;
}

/**
 * An SVG path of mirrored bars in a `bars × 100` box, one unit per bar (with a gap),
 * centred vertically. A minimum height keeps silence visible as a line.
 */
export function peaksPath(values: number[]): string {
  let d = '';
  values.forEach((v, i) => {
    const h = Math.max(4, v * 96);
    const y = (100 - h) / 2;
    d += `M${i + 0.15} ${y.toFixed(1)}h0.7v${h.toFixed(1)}h-0.7z`;
  });
  return d;
}
