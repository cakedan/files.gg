/** `m:ss`, or `h:mm:ss` when `reference` (the duration) is an hour or longer. Seconds in. */
export function formatTime(seconds: number, reference: number = seconds): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || (Number.isFinite(reference) && reference >= 3600)) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** A spoken form for `aria-valuetext`: "1 minute 5 seconds". */
export function spokenTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const parts = [h ? part(h, 'hour') : null, m ? part(m, 'minute') : null, part(s, 'second')];
  return parts.filter(Boolean).join(' ');
}
