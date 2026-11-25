/**
 * Messages for the conversion codes (milestone-5 §12), for `POST` errors and for a
 * conversion's own `error` (`{ code, message, metadata }`), which carries the same
 * details as an HTTP error's body.
 */

import { formatBytes } from './format';

export const CONVERSION_ERROR_CODES = [
  'UNSUPPORTED_CONVERSION',
  'INVALID_OPTION',
  'TARGET_SIZE_TOO_SMALL',
  'CONVERSION_TOO_LARGE',
  'CONVERSION_LIMIT_REACHED',
  'CONVERSION_REQUIRES_ACCOUNT',
  'SOURCE_UNAVAILABLE',
  'VIEW_LIMITED_SOURCE',
  'RATE_LIMITED',
  'RATE_LIMIT_UNAVAILABLE',
  'CONVERTER_BUSY',
  'CONVERSION_TIMEOUT',
  'CONVERSION_FAILED',
] as const;
export type ConversionCode = (typeof CONVERSION_ERROR_CODES)[number];

export const isConversionCode = (code: unknown): code is ConversionCode =>
  typeof code === 'string' && (CONVERSION_ERROR_CODES as readonly string[]).includes(code);

/** `CONVERSION_FAILED`'s `reason` (§12), never tool output. */
const FAILED_REASONS: Record<string, string> = {
  unreadable_source: 'files.gg couldn’t read the file.',
  bad_output: 'The result wasn’t a valid file.',
  empty_output: 'The result was empty.',
  too_many_pages: 'It has too many pages.',
  target_size_missed: 'It couldn’t be made that small. Try a lower max height, a shorter clip, or removing the audio.',
  internal: 'Something went wrong on our side.',
};

/** The tier a `CONVERSION_TIMEOUT` says gets more time (§7.1). */
const TIER_LABELS: Record<string, string> = {
  member: 'Signed-in accounts get',
  premium: 'Premium gets',
};

const num = (details: Record<string, unknown>, key: string): number | null => {
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** `2 minutes`, `45 seconds`, `1 hour 30 minutes`. */
export function spokenDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} ${total === 1 ? 'second' : 'seconds'}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  return parts.join(' ') || '0 seconds';
}

/** A `CONVERSION_TOO_LARGE` limit in its `unit` (§7.2): bytes, seconds, pages or images. */
function limitText(value: number, unit: unknown): string {
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'seconds') return spokenDuration(value);
  if (unit === 'pages') return `${value.toLocaleString('en')} ${value === 1 ? 'page' : 'pages'}`;
  if (unit === 'images') return `${value.toLocaleString('en')} ${value === 1 ? 'image' : 'images'}`;
  return value.toLocaleString('en');
}

export interface ConversionMessageOptions {
  /** Signed out: `CONVERTER_BUSY` keeps "or sign in to skip the queue". */
  anonymous?: boolean;
  /** The API's own message, for the codes with two texts (§12). */
  apiMessage?: string;
}

/** A friendly message for a conversion code, or null for any other code. */
export function conversionMessage(code: string | null, details: Record<string, unknown> = {}, { anonymous = true, apiMessage }: ConversionMessageOptions = {}): string | null {
  switch (code) {
    case 'UNSUPPORTED_CONVERSION':
      return 'This file can’t be converted to that format.';
    case 'INVALID_OPTION': {
      const option = typeof details.option === 'string' ? details.option.replaceAll('_', ' ') : null;
      return option ? `That ${option} isn’t valid for this conversion.` : 'That option isn’t valid for this conversion.';
    }
    case 'TARGET_SIZE_TOO_SMALL': {
      const minimum = num(details, 'minimum_mb');
      return minimum !== null ? `That size is too small for this video. Try at least ${Math.ceil(minimum)} MB.` : 'That size is too small for this video.';
    }
    case 'CONVERSION_TOO_LARGE': {
      const limit = num(details, 'limit');
      return limit !== null ? `This file is too big to convert. The limit is ${limitText(limit, details.unit)}.` : 'This file is too big to convert.';
    }
    case 'CONVERSION_LIMIT_REACHED': {
      const wait = num(details, 'retry_after');
      const after = wait !== null ? ` Try again in ${spokenDuration(Math.ceil(wait))}.` : '';
      return details.limit === 'concurrent' ? `Too many conversions at once. Wait for one to finish.${after}` : `You’ve reached your conversion limit for today.${after}`;
    }
    case 'CONVERSION_REQUIRES_ACCOUNT':
      return apiMessage && /bulk/i.test(apiMessage) ? 'Sign in to convert in bulk.' : 'Sign in to convert documents.';
    case 'SOURCE_UNAVAILABLE':
      return 'That file isn’t available.';
    case 'VIEW_LIMITED_SOURCE':
      return 'Files with a view limit can only be converted by their owner.';
    case 'RATE_LIMITED': {
      const wait = num(details, 'retry_after');
      // §18.1: `retry_after` has 3 decimals; never say "0 seconds".
      return wait !== null ? `You’re doing that too fast. Try again in ${spokenDuration(Math.max(1, Math.ceil(wait)))}.` : 'You’re doing that too fast.';
    }
    case 'RATE_LIMIT_UNAVAILABLE':
      return 'Try again in a moment.';
    case 'CONVERTER_BUSY':
      return anonymous ? 'Busy right now. Try again, or sign in to skip the queue.' : 'Busy right now. Try again in a few minutes.';
    case 'CONVERSION_TIMEOUT': {
      const ran = num(details, 'ran_seconds');
      const queued = num(details, 'queued_seconds');
      const tier = typeof details.tier === 'string' ? TIER_LABELS[details.tier] : undefined;
      const max = num(details, 'max_seconds');
      let text = 'The conversion took too long.';
      if (ran !== null) text += ` It ran for ${spokenDuration(ran)}${queued ? ` after ${spokenDuration(queued)} in line` : ''}.`;
      if (tier) text += max !== null ? ` ${tier} up to ${spokenDuration(max)}.` : ` ${tier} more time.`;
      return text;
    }
    case 'CONVERSION_FAILED': {
      const reason = typeof details.reason === 'string' ? FAILED_REASONS[details.reason] : undefined;
      return reason ? `The conversion failed. ${reason}` : 'The conversion failed.';
    }
  }
  return null;
}
