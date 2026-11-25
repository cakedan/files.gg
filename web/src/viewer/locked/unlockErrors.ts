import { ApiError } from '../../lib/api';
import { REMOVED_REASONS, type RemovedReason } from '../types';

export type UnlockErrorKind =
  | 'wrong'
  | 'rate-limited'
  | 'expired'
  | 'captcha'
  | 'verification'
  | 'network'
  | 'pending'
  | 'removed'
  | 'missing'
  | 'other';

export interface UnlockError {
  kind: UnlockErrorKind;
  /** ms epoch when another attempt is allowed (rate limit). */
  retryAt?: number;
  /** The password came from a `#pw=` link. */
  fromLink?: boolean;
  /** `removed`: the public reason (milestone-4 §2.4). */
  reason?: RemovedReason;
}

/** Maps an unlock failure to a UI state (contract §5 order: Turnstile, rate limit, expiry, password). */
export function classifyUnlockError(error: unknown, nowMs: number = Date.now()): UnlockError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'WRONG_PASSWORD':
        return { kind: 'wrong' };
      case 'TOO_MANY_ATTEMPTS': {
        const body = error.body as { retry_after?: unknown } | undefined;
        const seconds = typeof body?.retry_after === 'number' && body.retry_after > 0 ? body.retry_after : 60;
        return { kind: 'rate-limited', retryAt: nowMs + seconds * 1000 };
      }
      case 'PASSWORD_EXPIRED':
        return { kind: 'expired' };
      case 'CAPTCHA_INVALID':
        return { kind: 'captcha' };
      // Milestone 4 §12: the file or album isn't viewable right now, whatever the password.
      case 'FILE_PENDING':
        return { kind: 'pending' };
      case 'FILE_REMOVED':
      case 'ALBUM_REMOVED': {
        const reason = (error.body as { reason?: unknown } | undefined)?.reason;
        return {
          kind: 'removed',
          reason: (REMOVED_REASONS as readonly unknown[]).includes(reason) ? (reason as RemovedReason) : 'terms',
        };
      }
    }
    // Unknown, deleted, expired, or the owner's account is pending deletion (milestone-6
    // §8.8): every host shows it as missing, never as removed.
    if (error.status === 404) return { kind: 'missing' };
    if (error.isNetworkError) return { kind: 'network' };
    return { kind: 'other' };
  }
  if (error instanceof Error && error.message.startsWith('turnstile')) return { kind: 'verification' };
  return { kind: 'other' };
}

/** "0:42", "4:05". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The message shown under the password field. Rate limits never hint at how close a guess was. */
export function unlockErrorMessage(error: UnlockError, nowMs: number = Date.now()): string {
  switch (error.kind) {
    case 'wrong':
      return error.fromLink ? "The password in this link didn't work. Type it in instead." : "That password isn't right.";
    case 'rate-limited': {
      const left = (error.retryAt ?? nowMs) - nowMs;
      return left > 0 ? `Too many attempts. Try again in ${formatCountdown(left)}.` : 'You can try again now.';
    }
    case 'expired':
      return "This link's password has expired.";
    case 'captcha':
      return "We couldn't confirm you're a person. Try again.";
    case 'verification':
      return "The human check couldn't load. Check your connection or disable blockers for challenges.cloudflare.com.";
    case 'network':
      return "Couldn't reach files.gg. Check your connection and try again.";
    case 'pending':
      return "It's still being checked. Try again in a few seconds.";
    case 'removed':
      return "It's no longer available.";
    case 'missing':
      return "It doesn't exist or has expired.";
    case 'other':
      return "Couldn't unlock right now. Try again in a moment.";
  }
}
