import { ApiError, CLIENT_ERROR, type UploadRejectionReason } from './api';
import { conversionMessage, isConversionCode } from './conversionErrors';
import { formatBytes } from './format';
import { DISPLAY_NAME_REASON_TEXT, USERNAME_REASON_TEXT, type DisplayNameProblem, type UsernameReason } from './usernames';
import { PASSWORD_PROBLEM_TEXT, type PasswordProblem } from './passwordStrength';
import { ADULT_REGION_TEXT } from './upload/options';

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
  // Waits (`retry_after`) can be fractional (milestone-5 §18.1): round up, never down to 0.
  const whole = Math.max(1, Math.ceil(seconds));
  return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
};

const day = (seconds: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(seconds * 1000));

const reasonOf = (body: unknown): string | null => {
  const reason = (body as Record<string, unknown> | undefined)?.reason;
  return typeof reason === 'string' ? reason : null;
};

/** milestone-6 §10.1: why a hostname was refused. */
const HOSTNAME_REASONS: Record<string, string> = {
  syntax: 'That isn’t a valid hostname. Enter something like i.example.com.',
  wildcard: 'Wildcard domains aren’t supported. Enter one hostname, like i.example.com.',
  ip: 'Use a hostname, not an IP address.',
  apex: 'Use a subdomain, like i.example.com. Root domains aren’t supported yet.',
  public_suffix: 'That’s a public suffix, not a domain you can own.',
  reserved: 'That hostname belongs to files.gg.',
};

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
  // Milestone 5 (§12): conversions, and the Redis rate limits (§18).
  if (isConversionCode(error.code)) {
    const details = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    return conversionMessage(error.code, details, { apiMessage: error.message }) ?? error.message;
  }
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
    // Milestone 6 §19.8: view limits.
    case 'VIEW_LIMIT_TOO_LOW': {
      const used = num(body, 'views_used');
      return used !== null
        ? `${used.toLocaleString('en')} ${used === 1 ? 'person has' : 'people have'} already viewed this file. Set a limit of at least ${(used + 1).toLocaleString('en')}, or remove it.`
        : 'That limit is lower than the views already used. Set a higher one, or remove it.';
    }
    case 'UNLOCK_REQUIRED':
      return 'Unlock this file with its password first.';
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
    // Milestone 7 §11.3: adult content from a blocked country (451).
    case 'ADULT_CONTENT_UNAVAILABLE':
      return ADULT_REGION_TEXT;
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
    // Milestone 6: accounts, sessions, upload keys and domains (milestone-6 §14).
    case 'CSRF':
      return 'Something went wrong. Reload the page and try again.';
    case 'REQUEST_TOO_LARGE':
      return 'That’s too much to send at once.';
    case 'INVALID_CREDENTIALS':
      return 'Wrong email or password.';
    case 'USERNAME_INVALID':
      return USERNAME_REASON_TEXT[(reasonOf(body) ?? 'characters') as UsernameReason] ?? 'That username isn’t allowed.';
    case 'USERNAME_TAKEN':
      return USERNAME_REASON_TEXT.taken;
    case 'USERNAME_COOLDOWN': {
      const at = num(body, 'available_at');
      return at !== null ? `You can change your username again on ${day(at)}.` : 'You changed your username recently. Try again later.';
    }
    case 'DISPLAY_NAME_INVALID':
      return DISPLAY_NAME_REASON_TEXT[(reasonOf(body) ?? 'length') as DisplayNameProblem] ?? 'That display name isn’t allowed.';
    case 'INVALID_PASSWORD':
      return PASSWORD_PROBLEM_TEXT[(reasonOf(body) ?? 'too_short') as PasswordProblem] ?? 'That password isn’t allowed.';
    case 'SAME_PASSWORD':
      return 'That’s your current password. Choose a new one.';
    case 'EMAIL_TAKEN':
      return 'An account already uses that email.';
    case 'INVALID_EMAIL':
      return 'That email address doesn’t look right.';
    case 'INVALID_TOKEN':
      return 'This link is invalid or has expired.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Verify your email first, so you can recover your account.';
    case 'NOTHING_TO_VERIFY':
      return 'Your email is already verified.';
    case 'REAUTH_REQUIRED':
      return 'Confirm it’s you to continue.';
    case 'INVALID_OAUTH_STATE':
      return 'This sign-in link expired. Try again.';
    case 'DISCORD_CODE_INVALID':
      return 'Discord didn’t accept that sign-in. Try again.';
    case 'DISCORD_UNAVAILABLE':
      return 'Discord isn’t answering right now. Try again in a moment.';
    case 'INVALID_SIGNUP_TOKEN':
      return 'This sign-up took too long. Continue with Discord again.';
    case 'DISCORD_EMAIL_IN_USE':
      return 'An account already uses this email. Sign in with your password, then link Discord in Settings.';
    case 'IDENTITY_IN_USE':
      return 'That Discord account is linked to another files.gg account.';
    case 'IDENTITY_ALREADY_LINKED':
      return 'Your account is already linked to a different Discord account.';
    case 'IDENTITY_MISMATCH':
      return 'That’s a different Discord account from the one linked to files.gg.';
    case 'UNKNOWN_IDENTITY':
      return 'No Discord account is linked.';
    case 'LAST_LOGIN_METHOD':
      return 'Add a password and verify your email first, so you can still sign in.';
    case 'UNKNOWN_SESSION':
      return 'That session already ended.';
    case 'UPLOAD_KEY_REQUIRED':
      return 'Create a free account to upload with ShareX.';
    case 'UPLOAD_KEY_INVALID':
      return 'That upload key isn’t valid any more.';
    case 'UPLOAD_KEY_NOT_ALLOWED':
      return 'Upload keys can only upload files.';
    case 'UPLOAD_KEY_SCOPE':
      return 'This key can’t add to albums.';
    case 'UPLOAD_KEY_LIMIT': {
      const limit = num(body, 'limit');
      return `You have the most upload keys allowed (${limit ?? 20}). Revoke one to make another.`;
    }
    case 'UNKNOWN_UPLOAD_KEY':
      return 'That upload key doesn’t exist.';
    case 'ACCOUNT_PENDING_DELETION': {
      const at = num(body, 'scheduled_for');
      return at !== null ? `Your account is set to be deleted on ${day(at)}. Keep your account to use it again.` : 'Your account is set to be deleted. Keep your account to use it again.';
    }
    case 'ACCOUNT_DELETE_NOT_ALLOWED':
      return reasonOf(body) === 'staff' ? 'Staff accounts can’t be deleted while they’re staff.' : 'Your account is already set to be deleted.';
    case 'EXPORT_LIMIT': {
      const wait = num(body, 'retry_after');
      return wait !== null ? `You can request one export a day. Try again in ${duration(wait)}.` : 'You can request one export a day.';
    }
    case 'EXPORT_NOT_READY':
      return 'This export isn’t ready yet.';
    case 'UNKNOWN_EXPORT':
      return 'This export expired. Request a new one.';
    case 'PREMIUM_REQUIRED':
      return 'Custom domains need premium.';
    case 'ENTITLEMENT_EXISTS':
      return 'This account already has premium. Change its expiry instead.';
    case 'UNKNOWN_ENTITLEMENT':
      return 'That entitlement doesn’t exist.';
    case 'UNKNOWN_USER':
      return 'That account doesn’t exist.';
    case 'INVALID_HOSTNAME':
      return HOSTNAME_REASONS[reasonOf(body) ?? 'syntax'] ?? HOSTNAME_REASONS.syntax!;
    case 'DOMAIN_TAKEN':
      return 'That domain is already connected to files.gg.';
    case 'DOMAIN_LIMIT_REACHED': {
      const limit = num(body, 'limit');
      return `You have the most domains allowed (${limit ?? 5}). Remove one to add another.`;
    }
    case 'DOMAIN_REQUIREMENTS': {
      if (reasonOf(body) === 'email_not_verified') return 'Verify your email to add domains.';
      const at = num(body, 'available_at');
      return at !== null ? `New accounts can add domains after a week. You can add one on ${day(at)}.` : 'New accounts can add domains after a week.';
    }
    case 'UNKNOWN_DOMAIN':
      return 'That domain doesn’t exist.';
    case 'DOMAIN_NOT_ACTIVE':
      return 'That domain isn’t active yet.';
    case 'DOMAIN_NOT_FAILED':
      return 'Only a failed domain can be retried.';
    case 'DOMAIN_DISABLED':
      return 'files.gg disabled this domain, so it can’t be removed. You can appeal in Notices.';
    case 'DOMAIN_CHECK_RATE_LIMITED': {
      const wait = num(body, 'retry_after');
      return wait !== null ? `Checked just now. Try again in ${duration(wait)}.` : 'Checked just now. Try again in a minute.';
    }
    case 'DOMAIN_ONLY_NOT_AVAILABLE':
      return 'You need a working domain first.';
    case 'DOMAINS_UNAVAILABLE':
      return 'Custom domains aren’t available right now. Try again later.';
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

/** The form field each Milestone 6 field code belongs to. */
const FIELD_OF: Record<string, string> = {
  USERNAME_INVALID: 'username',
  USERNAME_TAKEN: 'username',
  USERNAME_COOLDOWN: 'username',
  DISPLAY_NAME_INVALID: 'display_name',
  INVALID_PASSWORD: 'password',
  SAME_PASSWORD: 'password',
  EMAIL_TAKEN: 'email',
  INVALID_EMAIL: 'email',
};

/**
 * Field errors from `400 INVALID_PARAMETERS { errors }` (the server's own words) or a
 * single field code (in ours). `password` also answers for `new_password`.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  const errors = (error.body as { errors?: unknown } | undefined)?.errors;
  if (errors && typeof errors === 'object') {
    for (const [field, message] of Object.entries(errors as Record<string, unknown>)) {
      if (typeof message === 'string') out[field === 'new_password' ? 'password' : field] = message;
    }
  }
  const field = error.code ? FIELD_OF[error.code] : undefined;
  if (field) out[field] = errorMessage(error);
  return out;
}
