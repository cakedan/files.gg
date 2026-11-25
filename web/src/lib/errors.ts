import { ApiError, CLIENT_ERROR, type UploadRejectionReason } from './api';
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
  'FILE_TYPE_NOT_ALLOWED',
  'INVALID_MIMETYPE',
  'TOO_MANY_UPLOADS',
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

const day = (seconds: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(seconds * 1000));

/** milestone-4 §11.2: why an upload was rejected after scanning (`410 UPLOAD_REJECTED { reason }`). */
export const UPLOAD_REJECTED_MESSAGES: Record<UploadRejectionReason, string> = {
  NSFW_REQUIRES_ACCOUNT: 'Sign in to upload sensitive media.',
  ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT: 'Sign in to upload encrypted archives.',
  ENCRYPTED_PDF_REQUIRES_ACCOUNT: 'Sign in to upload password-protected PDFs.',
  MALWARE_DETECTED: 'This file looks like malware, so it wasn’t uploaded.',
  FILE_TYPE_NOT_ALLOWED: 'This file contains a type that isn’t allowed on files.gg.',
  FILE_BLOCKED: 'This file can’t be uploaded.',
};

export const uploadRejectedMessage = (reason: unknown): string =>
  UPLOAD_REJECTED_MESSAGES[reason as UploadRejectionReason] ?? UPLOAD_REJECTED_MESSAGES.FILE_BLOCKED;

/** A friendly message for any API (or client) error code, using the error's details. */
export function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.';
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const { body } = error;
  switch (error.code) {
    case 'FILE_TYPE_NOT_ALLOWED':
      return "This type of file can't be uploaded. Programs, installers and scripts aren't allowed.";
    case 'INVALID_MIMETYPE':
      return "files.gg doesn't accept this type of file.";
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
    case 'VANITY_EXHAUSTED':
      return 'That link pattern has no free links left. Pick a longer or different pattern.';
    case 'TOO_MANY_UPLOADS': {
      const limit = num(body, 'limit');
      return limit !== null
        ? `Too many uploads in progress (the limit is ${limit}). Finish or cancel one first.`
        : 'Too many uploads in progress. Finish or cancel one first.';
    }
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
    // Milestone 4 reports (milestone-4 §7, §12).
    case 'CANNOT_REPORT_YOURSELF':
      return "You can't report your own file or album.";
    case 'INVALID_REPORT_TARGET':
      return "That can't be reported. Check that the link is to a file or album on files.gg.";
    case 'DETAILS_REQUIRED':
      return 'Add some details.';
    case 'MAX_REPORTS': {
      const wait = num(body, 'retry_after');
      return wait !== null ? `You've sent a lot of reports. Try again in ${duration(wait)}.` : "You've sent a lot of reports. Try again later.";
    }
    // Milestone 4 scanning, moderation and accounts (milestone-4 §2, §8, §9, §12).
    case 'NSFW_REQUIRES_ACCOUNT':
    case 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT':
    case 'MALWARE_DETECTED':
    case 'FILE_BLOCKED':
      return uploadRejectedMessage(error.code);
    case 'UPLOAD_REJECTED':
      return uploadRejectedMessage((body as Record<string, unknown> | undefined)?.reason);
    case 'FILE_PENDING':
      return 'This file is still being checked. Try again in a few seconds.';
    case 'FILE_REMOVED':
      return 'This file was removed.';
    case 'ALBUM_REMOVED':
      return 'This album was removed.';
    case 'NSFW_LOCKED':
      return 'files.gg marked this file as sensitive, so it can’t be unmarked. Ask for a review instead.';
    case 'DMCA_FIELDS_REQUIRED':
      return 'Fill in every field of the notice.';
    case 'MAX_MESSAGES': {
      const wait = num(body, 'retry_after');
      return wait !== null ? `You’ve sent a lot of messages. Try again in ${duration(wait)}.` : 'You’ve sent a lot of messages. Try again later.';
    }
    case 'UNKNOWN_REPORT':
      return 'This report doesn’t exist.';
    case 'REPORT_CLOSED':
      return 'This report is closed, so you can’t reply any more.';
    case 'REOPEN_NOT_ALLOWED':
      return 'This report can’t be reopened.';
    case 'UNKNOWN_WARNING':
      return 'This notice doesn’t exist.';
    case 'APPEAL_NOT_ALLOWED':
      return 'This can’t be appealed, or was already appealed.';
    case 'ACCOUNT_SUSPENDED': {
      const until = num(body, 'until');
      return until !== null ? `Your account is suspended until ${day(until)}.` : 'Your account has been suspended.';
    }
    case 'UPLOADS_RESTRICTED': {
      const until = num(body, 'until');
      return until !== null ? `Uploads are restricted on your account until ${day(until)}.` : 'Uploads are restricted on your account.';
    }
    case 'BANNED':
      return 'Uploads from this device or network aren’t allowed.';
    case 'UNKNOWN_CASE':
      return 'This case doesn’t exist.';
    case 'CASE_CLAIMED':
      return 'Someone else has claimed this case.';
    case 'SAME_MODERATOR':
      return 'You took the original action, so another staff member has to decide this appeal.';
    case 'INVALID_ACTION':
      return 'That action doesn’t apply here.';
    case 'FORBIDDEN':
      return 'You don’t have permission to do that.';
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
