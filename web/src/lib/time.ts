/**
 * Relative-time and expiry formatting for the viewer footer and dashboard.
 * Pure functions: pass `now` explicitly so they are trivially testable.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Payload times are epoch seconds (contract §4); these helpers work in ms. */
export const epochMs = (seconds: number): number => seconds * SECOND;

/** Epoch seconds, or null, as ms. */
export const epochMsOrNull = (seconds: number | null | undefined): number | null =>
  seconds === null || seconds === undefined ? null : seconds * SECOND;

/** How often relative labels refresh (Appendix A: a 30 s timer). */
export const RELATIVE_REFRESH_MS = 30 * SECOND;

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

type Unit = Intl.RelativeTimeFormatUnit;

/** Picks the largest sensible unit for a positive duration in ms. */
function pickUnit(ms: number): [number, Unit] {
  const seconds = Math.round(ms / SECOND);
  if (seconds < 60) return [seconds, 'second'];
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return [minutes, 'minute'];
  const hours = Math.round(ms / HOUR);
  if (hours < 24) return [hours, 'hour'];
  const days = Math.round(ms / DAY);
  if (days < 30) return [days, 'day'];
  const months = Math.round(ms / (DAY * 30.4375));
  if (months < 12) return [Math.max(months, 1), 'month'];
  return [Math.max(Math.round(ms / (DAY * 365.25)), 1), 'year'];
}

/**
 * "just now", "5 minutes ago", "in 3 days".
 * Anything within 45 seconds of `now` (either side) reads as "just now".
 */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const diff = timestamp - now;
  if (Math.abs(diff) < 45 * SECOND) {
    return 'just now';
  }
  const [value, unit] = pickUnit(Math.abs(diff));
  return relativeFormatter.format(diff < 0 ? -value : value, unit);
}

/** "Uploaded 3 days ago". */
export function formatUploaded(uploadedAt: number, now: number = Date.now()): string {
  return `Uploaded ${formatRelative(Math.min(uploadedAt, now), now)}`;
}

export type ExpiryTone = 'warn' | 'danger';

export interface ExpiryLabel {
  label: string;
  tone: ExpiryTone;
  expired: boolean;
}

/**
 * Expiry label per Appendix A: amber "Expires in…" while in the future,
 * red "Expired" once `expiresAt <= now`. Returns null when the file never expires.
 */
export function formatExpiry(expiresAt: number | null | undefined, now: number = Date.now()): ExpiryLabel | null {
  if (expiresAt === null || expiresAt === undefined || !Number.isFinite(expiresAt)) {
    return null;
  }
  const remaining = expiresAt - now;
  if (remaining <= 0) {
    return { label: 'Expired', tone: 'danger', expired: true };
  }
  if (remaining < MINUTE) {
    return { label: 'Expires in less than a minute', tone: 'warn', expired: false };
  }
  const [value, unit] = pickUnit(remaining);
  return { label: `Expires ${relativeFormatter.format(value, unit)}`, tone: 'warn', expired: false };
}

const fullDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

/** Full date for tooltips: "Tuesday, November 24, 2026 at 12:53:00 PM GMT". */
export function formatFullDate(timestamp: number): string {
  return fullDateFormatter.format(new Date(timestamp));
}
