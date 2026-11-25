import { ApiError, CLIENT_ERROR } from './api';
import { formatBytes } from './format';

/** Every contract §7 code, plus the client's own. */
export const UPLOAD_ERROR_CODES = [
  'FILE_TOO_LARGE',
  'STORAGE_LIMIT_REACHED',
  'EXPIRY_NOT_ALLOWED',
  'CAPTCHA_INVALID',
  'TOO_MANY_ATTEMPTS',
  'WRONG_PASSWORD',
  'PASSWORD_EXPIRED',
  'UNLOCK_EXPIRED',
  'UNKNOWN_FILE',
  'UNKNOWN_UPLOAD',
  'UPLOAD_INCOMPLETE',
  'CHUNK_SIZE_MISMATCH',
  'PRIVATE_REQUIRES_ACCOUNT',
  'RESERVED_VANITY',
] as const;

/** Milestone 3 codes (milestone-3 contract §6): albums and the album ZIP. */
export const ALBUM_ERROR_CODES = [
  'UNKNOWN_ALBUM',
  'INVALID_ALBUM',
  'INVALID_ALBUM_FILES',
  'ALBUM_FULL',
  'ALBUM_LIMIT_REACHED',
  'ANONYMOUS_ALBUM_NOT_ALLOWED',
  'ZIP_TOO_LARGE',
] as const;

const num = (body: unknown, key: string): number | null => {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const duration = (seconds: number): string => {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} days`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hours`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.max(1, Math.round(seconds))} seconds`;
};

/** A friendly message for any API (or client) error code, using the error's details. */
export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.';
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const { body } = error;
  switch (error.code) {
    case 'FILE_TOO_LARGE': {
      const limit = num(body, 'limit');
      return limit !== null ? `This file is too large. The limit is ${formatBytes(limit)}.` : 'This file is too large.';
    }
    case 'STORAGE_LIMIT_REACHED': {
      const limit = num(body, 'limit');
      const used = num(body, 'used');
      return limit !== null && used !== null
        ? `Your storage is full (${formatBytes(used)} of ${formatBytes(limit)} used). Delete files to make room.`
        : 'Your storage is full. Delete files to make room.';
    }
    case 'EXPIRY_NOT_ALLOWED': {
      const max = num(body, 'max_expiry');
      return max !== null ? `That expiry isn't allowed. The longest is ${duration(max)}.` : "That expiry isn't allowed.";
    }
    case 'CAPTCHA_INVALID':
      return "We couldn't confirm you're a person. Try again.";
    case 'TOO_MANY_ATTEMPTS': {
      const wait = num(body, 'retry_after');
      return wait !== null ? `Too many attempts. Try again in ${duration(wait)}.` : 'Too many attempts. Try again later.';
    }
    case 'WRONG_PASSWORD':
      return "That password isn't right.";
    case 'PASSWORD_EXPIRED':
      return "This link's password has expired.";
    case 'UNLOCK_EXPIRED':
      return 'Your access has expired. Enter the password again.';
    case 'UNKNOWN_FILE':
      return "This file doesn't exist or has expired.";
    case 'UNKNOWN_UPLOAD':
      return 'This upload expired or was cancelled. Start it again.';
    case 'UPLOAD_INCOMPLETE': {
      const missing = (body as { missing?: unknown } | undefined)?.missing;
      const count = Array.isArray(missing) ? missing.length : null;
      return count ? `The upload is missing ${count} ${count === 1 ? 'part' : 'parts'}. Resume to finish it.` : 'The upload is incomplete. Resume to finish it.';
    }
    case 'CHUNK_SIZE_MISMATCH':
      return 'A part of the upload had the wrong size. Start the upload again.';
    case 'PRIVATE_REQUIRES_ACCOUNT':
      return 'Sign in to keep files private.';
    case 'RESERVED_VANITY':
      return "That link name is reserved. Try another.";
    case 'UNKNOWN_ALBUM':
      return "This album doesn't exist or was deleted.";
    case 'INVALID_ALBUM':
      return "That album doesn't exist or isn't yours.";
    case 'INVALID_ALBUM_FILES': {
      const ids = (body as { file_ids?: unknown } | undefined)?.file_ids;
      const count = Array.isArray(ids) ? ids.length : null;
      return count
        ? `${count} ${count === 1 ? "file can't" : "files can't"} go in an album. Only your own, live files can be added.`
        : 'Only your own, live files can be added to an album.';
    }
    case 'ALBUM_FULL': {
      const limit = num(body, 'limit');
      return `This album is full. An album holds up to ${(limit ?? 500).toLocaleString('en')} files.`;
    }
    case 'ALBUM_LIMIT_REACHED': {
      const limit = num(body, 'limit');
      return `You have the most albums allowed (${(limit ?? 1000).toLocaleString('en')}). Delete one to make another.`;
    }
    case 'ANONYMOUS_ALBUM_NOT_ALLOWED':
      return 'Without an account, an album can only be made from up to 50 files you just uploaded. Sign in to make and edit albums.';
    case 'ZIP_TOO_LARGE': {
      const limit = num(body, 'limit');
      return limit !== null
        ? `This album is over ${formatBytes(limit)}, too large to download as one ZIP. Download the files one by one.`
        : 'This album is too large to download as one ZIP. Download the files one by one.';
    }
    case CLIENT_ERROR.network:
      return "Couldn't reach files.gg. Check your connection and try again.";
    case CLIENT_ERROR.invalidResponse:
      return 'files.gg sent an unexpected response. Try again.';
  }
  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status >= 500) return 'files.gg had a problem. Try again in a moment.';
  return error.message || 'Something went wrong. Try again.';
}

/** A local limit failure, shaped like the API's, so the same messages apply. */
export function localError(code: 'FILE_TOO_LARGE' | 'STORAGE_LIMIT_REACHED', details: Record<string, number>): ApiError {
  return new ApiError(413, code, code, { code, ...details });
}
