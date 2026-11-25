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
    [err(413, 'ZIP_TOO_LARGE', { limit: 2147483648 }), 'This album is over 2 GB, too large to download as one ZIP. Download the files one by one.'],
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
