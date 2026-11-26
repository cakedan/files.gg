import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { ALBUM_ERROR_CODES, errorMessage } from './errors';

const err = (status: number, code: string | null, details: Record<string, unknown> = {}) =>
  new ApiError(status, code, 'raw server message', { code, ...details });

describe('errorMessage: upload limits', () => {
  it('explains a custom link pattern with no free links', () => {
    expect(errorMessage(err(409, 'VANITY_EXHAUSTED'))).toBe('That link pattern has no free links left. Pick a longer or different pattern.');
  });
});

describe('errorMessage: file types', () => {
  it('explains why an executable was refused', () => {
    expect(errorMessage(err(400, 'FILE_TYPE_NOT_ALLOWED'))).toBe(
      "This type of file can't be uploaded. Programs, installers and scripts aren't allowed.",
    );
    expect(errorMessage(err(400, 'INVALID_MIMETYPE'))).toBe("files.gg doesn't accept this type of file.");
  });
});

describe('errorMessage: Milestone 3 codes', () => {
  it.each([
    [err(404, 'UNKNOWN_ALBUM'), "This album doesn't exist or was deleted."],
    [err(400, 'INVALID_ALBUM'), "That album doesn't exist or isn't yours."],
    [err(400, 'INVALID_ALBUM_FILES', { file_ids: ['1', '2'] }), "2 files can't go in an album. Only your own, live files can be added."],
    [err(400, 'INVALID_ALBUM_FILES', { file_ids: ['1'] }), "1 file can't go in an album. Only your own, live files can be added."],
    [err(400, 'ALBUM_FULL', { limit: 500 }), 'This album is full. An album holds up to 500 files.'],
    [err(400, 'ALBUM_LIMIT_REACHED', { limit: 1000 }), 'You have the most albums allowed (1,000). Delete one to make another.'],
    [
      err(403, 'ANONYMOUS_ALBUM_NOT_ALLOWED'),
      'Without an account, an album can only be made from up to 50 files you just uploaded. Sign in to make and edit albums.',
    ],
    [err(413, 'ZIP_TOO_LARGE', { limit: 2_000_000_000 }), 'This album is over 2 GB, too large to download as one ZIP. Download the files one by one.'],
  ])('%#: maps %s', (error, message) => {
    expect(errorMessage(error)).toBe(message);
  });

  it('covers every album code with its own message', () => {
    const messages = ALBUM_ERROR_CODES.map((code) => errorMessage(err(400, code)));
    expect(new Set(messages).size).toBe(ALBUM_ERROR_CODES.length);
    expect(messages.some((message) => message === 'raw server message')).toBe(false);
  });

  it('falls back sensibly for sessions, server errors and unknown codes', () => {
    expect(errorMessage(err(401, 'UNAUTHORIZED'))).toBe('Your session has expired. Sign in again.');
    expect(errorMessage(err(503, 'UNAVAILABLE'))).toBe('files.gg had a problem. Try again in a moment.');
    expect(errorMessage(err(400, 'SOMETHING_NEW'))).toBe('raw server message');
    expect(errorMessage(new Error('x'))).toBe('Something went wrong. Try again.');
  });

  it('copy follows the style guide: sentence case, no "please", no exclamation marks', () => {
    for (const code of ALBUM_ERROR_CODES) {
      const message = errorMessage(err(400, code, { limit: 1, file_ids: ['1'] }));
      expect(message).not.toMatch(/please|!/i);
      expect(message[0]).toBe(message[0]!.toUpperCase());
    }
  });
});

describe('errorMessage: view limits (milestone-6 §19.8)', () => {
  it('VIEW_LIMIT_TOO_LOW uses views_used', () => {
    expect(errorMessage(err(400, 'VIEW_LIMIT_TOO_LOW', { views_used: 4 }))).toBe('4 people have already viewed this file. Set a limit of at least 5, or remove it.');
    expect(errorMessage(err(400, 'VIEW_LIMIT_TOO_LOW', { views_used: 1 }))).toBe('1 person has already viewed this file. Set a limit of at least 2, or remove it.');
    expect(errorMessage(err(400, 'VIEW_LIMIT_TOO_LOW', { views_used: 1200 }))).toBe('1,200 people have already viewed this file. Set a limit of at least 1,201, or remove it.');
    expect(errorMessage(err(400, 'VIEW_LIMIT_TOO_LOW'))).toBe('That limit is lower than the views already used. Set a higher one, or remove it.');
  });

  it('UNLOCK_REQUIRED asks for the password first', () => {
    expect(errorMessage(err(401, 'UNLOCK_REQUIRED'))).toBe('Unlock this file with its password first.');
  });

  it('follows the style guide', () => {
    for (const message of [errorMessage(err(400, 'VIEW_LIMIT_TOO_LOW', { views_used: 2 })), errorMessage(err(401, 'UNLOCK_REQUIRED'))]) {
      expect(message).not.toMatch(/please|!/i);
      expect(message[0]).toBe(message[0]!.toUpperCase());
    }
  });
});

describe('milestone 5: conversions and Redis rate limits (§12, §18)', () => {
  it('maps the conversion codes through their details', () => {
    expect(errorMessage(err(403, 'CONVERSION_REQUIRES_ACCOUNT', { sign_in: true }))).toBe('Sign in to convert documents.');
    expect(errorMessage(err(404, 'SOURCE_UNAVAILABLE'))).toBe('That file isn’t available.');
    expect(errorMessage(err(400, 'TARGET_SIZE_TOO_SMALL', { minimum_mb: 14.2 }))).toBe('That size is too small for this video. Try at least 15 MB.');
  });

  it('RATE_LIMITED and TOO_MANY_ATTEMPTS round a fractional retry_after up', () => {
    expect(errorMessage(err(429, 'RATE_LIMITED', { retry_after: 1.25 }))).toBe('You’re doing that too fast. Try again in 2 seconds.');
    expect(errorMessage(err(429, 'TOO_MANY_ATTEMPTS', { retry_after: 0.4 }))).toBe('Too many attempts. Try again in 1 second.');
    expect(errorMessage(err(503, 'RATE_LIMIT_UNAVAILABLE'))).toBe('Try again in a moment.');
  });
});

describe('milestone 7: regional rules (§11.3, §11.4)', () => {
  it('ADULT_CONTENT_UNAVAILABLE says adult content is not available in the region', () => {
    expect(errorMessage(err(451, 'ADULT_CONTENT_UNAVAILABLE'))).toBe("Adult content isn't available in your region.");
  });
});
