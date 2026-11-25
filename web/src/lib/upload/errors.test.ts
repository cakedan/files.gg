import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { errorMessage, localError, UPLOAD_ERROR_CODES } from './errors';
import { checkLimits } from './limits';

const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new ApiError(status, code, 'raw server message', { code, ...details });

describe('errorMessage', () => {
  it.each([
    [err(413, 'FILE_TOO_LARGE', { limit: 26214400 }), 'This file is too large. The limit is 25 MB.'],
    [err(413, 'STORAGE_LIMIT_REACHED', { limit: 10737418240, used: 10737418000 }), 'Your storage is full (10 GB of 10 GB used). Delete files to make room.'],
    [err(400, 'EXPIRY_NOT_ALLOWED', { max_expiry: 1814400 }), "That expiry isn't allowed. The longest is 21 days."],
    [err(403, 'CAPTCHA_INVALID'), "We couldn't confirm you're a person. Try again."],
    [err(429, 'TOO_MANY_ATTEMPTS', { retry_after: 120 }), 'Too many attempts. Try again in 2 minutes.'],
    [err(401, 'WRONG_PASSWORD'), "That password isn't right."],
    [err(410, 'PASSWORD_EXPIRED'), "This link's password has expired."],
    [err(401, 'UNLOCK_EXPIRED'), 'Your access has expired. Enter the password again.'],
    [err(404, 'UNKNOWN_FILE'), "This file doesn't exist or has expired."],
    [err(404, 'UNKNOWN_UPLOAD'), 'This upload expired or was cancelled. Start it again.'],
    [err(409, 'UPLOAD_INCOMPLETE', { missing: [3, 4] }), 'The upload is missing 2 parts. Resume to finish it.'],
    [err(400, 'CHUNK_SIZE_MISMATCH', { expected: 10485760 }), 'A part of the upload had the wrong size. Start the upload again.'],
    [err(400, 'PRIVATE_REQUIRES_ACCOUNT'), 'Sign in to keep files private.'],
    [err(400, 'RESERVED_VANITY'), "That link name is reserved. Try another."],
  ])('%#: maps %s', (error, message) => {
    expect(errorMessage(error)).toBe(message);
  });

  it('covers every contract §7 code with its own message', () => {
    for (const code of UPLOAD_ERROR_CODES) {
      expect(errorMessage(err(400, code))).not.toBe('raw server message');
    }
  });

  it('degrades gracefully without details, for network errors and unknown codes', () => {
    expect(errorMessage(err(413, 'FILE_TOO_LARGE'))).toBe('This file is too large.');
    expect(errorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(/Couldn't reach files.gg/);
    expect(errorMessage(new ApiError(502, null, 'Bad Gateway'))).toMatch(/had a problem/);
    expect(errorMessage(new DOMException('Aborted', 'AbortError'))).toBe('Cancelled.');
    expect(errorMessage('boom')).toBe('Something went wrong. Try again.');
  });
});

describe('checkLimits (before uploading)', () => {
  const limits = {
    storage: { used: 9 * 1024 ** 3, limit: 10 * 1024 ** 3 },
    max_file_size_single: 100 * 1024 ** 2,
    max_file_size_chunked: 1024 ** 3,
    max_expiry: null,
    allow_no_expiry: true,
    anonymous: false,
  };

  it('uses the chunked limit above 10 MiB and the single limit below', () => {
    expect(checkLimits(5 * 1024 ** 2, limits)).toBeNull();
    expect(checkLimits(2 * 1024 ** 3, limits)).toMatchObject({ code: 'FILE_TOO_LARGE', body: { limit: 1024 ** 3 } });
    expect(checkLimits(5 * 1024 ** 2, { ...limits, max_file_size_single: 1024 ** 2 })).toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('counts storage including what is already queued', () => {
    expect(checkLimits(512 * 1024 ** 2, limits)).toBeNull();
    expect(checkLimits(512 * 1024 ** 2, limits, 600 * 1024 ** 2)).toMatchObject({ code: 'STORAGE_LIMIT_REACHED' });
  });

  it('anonymous callers have no storage limit, and missing limits skip the check', () => {
    expect(checkLimits(20 * 1024 ** 2, { ...limits, storage: { used: 0, limit: null }, max_file_size_chunked: 25 * 1024 ** 2 })).toBeNull();
    expect(checkLimits(10 ** 12, null)).toBeNull();
    expect(localError('FILE_TOO_LARGE', { limit: 1 }).status).toBe(413);
  });
});
