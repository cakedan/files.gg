import { describe, expect, it } from 'vitest';

import type { FormatOption, FormatsDocument } from '../../lib/conversions';
import { conversionMessage } from '../../lib/conversionErrors';
import { sourceKindOf } from '../../lib/convertKinds';
import {
  batchTargets,
  enumChoices,
  fieldError,
  formErrors,
  initialState,
  minimumTargetMb,
  pageCount,
  parsePages,
  pickFromLink,
  presetsFor,
  requestOptions,
  targetSizeMb,
} from './options';
import { POLL_HIDDEN_MS, POLL_MS, pollInterval } from './queries';

const opt = (name: string, type: FormatOption['type'], fallback: FormatOption['default'], extra: Partial<FormatOption> = {}): FormatOption => ({ name, type, label: name, default: fallback, ...extra });

/** One option of every §10.1 type. */
const EVERY_TYPE: FormatOption[] = [
  opt('quality', 'int', 85, { min: 1, max: 100 }),
  opt('trim_start', 'number', null, { min: 0 }),
  opt('strip_metadata', 'bool', true),
  opt('max_height', 'enum', null, { values: [1080, 720, 480] }),
  opt('background', 'color', '#ffffff'),
  opt('pages', 'pages', null),
  opt('target_size', 'size', null, { min: 1, max: 500, presets: { discord: 10 } }),
];

const formats: FormatsDocument = {
  version: 1,
  kinds: {
    image: { targets: [{ target: 'png', label: 'PNG', group: 'image', anonymous: true, options: [opt('strip_metadata', 'bool', true)] }, { target: 'jpg', label: 'JPG', group: 'image', anonymous: true, options: [opt('quality', 'int', 85, { min: 1, max: 100 }), opt('strip_metadata', 'bool', true)] }] },
    animated: { targets: [{ target: 'mp4', label: 'MP4', group: 'video', anonymous: true, options: [opt('fps', 'int', null, { min: 1, max: 60 }), opt('trim_start', 'number', null)] }] },
    video: { targets: [{ target: 'mp4', label: 'MP4', group: 'video', anonymous: true, options: [opt('max_height', 'enum', null, { values: [1080, 720, 480] }), opt('trim_start', 'number', null)] }] },
    document: { targets: [{ target: 'pdf', label: 'PDF', group: 'document', anonymous: false, options: [] }] },
  },
  presets: [
    { id: 'play_everywhere', label: 'Make it play everywhere', kinds: ['video'], target: 'mp4', options: {} },
    { id: 'remove_location', label: 'Remove photo location data', kinds: ['image'], target: 'same', options: { strip_metadata: true } },
  ],
};

describe('source kinds (§1.1)', () => {
  it.each([
    [{ mimetype: 'image/png' }, 'image'],
    [{ mimetype: 'image/gif', framecount: 1 }, 'image'],
    [{ mimetype: 'image/gif', framecount: 12 }, 'animated'],
    [{ mimetype: 'image/webp', media: { framecount: 3 } }, 'animated'],
    [{ mimetype: 'image/apng' }, 'animated'],
    [{ mimetype: 'video/mp4', kind: 'video' }, 'video'],
    [{ mimetype: 'video/mp4', kind: 'audio' }, 'audio'],
    [{ mimetype: 'audio/flac' }, 'audio'],
    [{ mimetype: 'application/vnd.oasis.opendocument.text' }, 'document'],
    [{ mimetype: 'application/pdf' }, 'pdf'],
    [{ mimetype: 'application/zip' }, null],
  ])('%o is %s', (file, kind) => expect(sourceKindOf(file)).toBe(kind));
});

describe('presets and targets (§10.1, §13.1)', () => {
  it('resolves "same" to the source’s format, and drops a preset the source can’t get', () => {
    expect(presetsFor(formats, 'image', 'jpeg').map((preset) => [preset.id, preset.resolved])).toEqual([['remove_location', 'jpg']]);
    expect(presetsFor(formats, 'image', 'heic')).toEqual([]);
    expect(presetsFor(formats, 'video', 'mov').map((preset) => preset.id)).toEqual(['play_everywhere']);
  });

  it('picks what a link asked for, if the source has it', () => {
    expect(pickFromLink(formats, 'video', 'mov', 'play_everywhere', null)).toEqual({ type: 'preset', id: 'play_everywhere' });
    expect(pickFromLink(formats, 'document', 'docx', null, 'pdf')).toEqual({ type: 'target', target: 'pdf' });
    expect(pickFromLink(formats, 'image', 'png', 'play_everywhere', 'mp4')).toBeNull();
  });

  it('batch targets keep only the options every selected kind has', () => {
    const [mp4] = batchTargets(formats, ['animated', 'video']);
    expect(mp4).toMatchObject({ target: 'mp4', kinds: ['animated', 'video'] });
    expect(mp4!.options.map((option) => option.name)).toEqual(['trim_start']);
  });
});

describe('the options form (§1.2, §10.1)', () => {
  it('starts every type at its default, with a preset on top', () => {
    expect(initialState(EVERY_TYPE)).toEqual({ quality: '85', trim_start: '', strip_metadata: true, max_height: '', background: '#ffffff', pages: '', target_size: '' });
    expect(initialState(EVERY_TYPE, { target_size: 'discord', strip_metadata: false })).toMatchObject({ target_size: 'preset:discord', strip_metadata: false });
  });

  it('validates every type', () => {
    const [quality, trim, , height, color, pages, size] = EVERY_TYPE as [FormatOption, FormatOption, FormatOption, FormatOption, FormatOption, FormatOption, FormatOption];
    expect(fieldError(quality, '101')).toBe('Enter a value (1–100).');
    expect(fieldError(quality, '8.5')).toBe('Enter a whole number (1–100).');
    expect(fieldError(quality, '')).toBe('Enter a value.');
    expect(fieldError(trim, '1.5')).toBeNull();
    expect(fieldError(trim, '-1')).toBe('Enter a value (at least 0).');
    expect(fieldError(height, '')).toBeNull();
    expect(fieldError(height, '999')).toBe('Pick one.');
    expect(fieldError(color, '#12345')).toBe('Enter a colour like #ffffff.');
    expect(fieldError(pages, '1-3,7')).toBeNull();
    expect(fieldError(pages, '3-1')).toBe('Enter pages like 1-3,7.');
    expect(fieldError(pages, '9', { pages: 8 })).toBe('This PDF has 8 pages.');
    expect(fieldError(size, 'preset:discord')).toBeNull();
    expect(fieldError(size, '600')).toBe('Enter a value (1–500).');
  });

  it('wants trim_end after trim_start', () => {
    const trims = [opt('trim_start', 'number', null), opt('trim_end', 'number', null)];
    expect(formErrors(trims, { trim_start: '5', trim_end: '2' })).toEqual({ trim_end: 'The end must be after the start.' });
    expect(formErrors(trims, { trim_start: '', trim_end: '2' })).toEqual({});
  });

  it('sends only what differs from the defaults, typed', () => {
    const state = { ...initialState(EVERY_TYPE), quality: '70', max_height: '720', background: '#FFAA00', pages: '1-2, 5', target_size: 'preset:discord' };
    expect(requestOptions(EVERY_TYPE, state)).toEqual({ quality: 70, max_height: 720, background: '#ffaa00', pages: '1-2,5', target_size: 'discord' });
    expect(requestOptions(EVERY_TYPE, initialState(EVERY_TYPE))).toEqual({});
    expect(requestOptions(EVERY_TYPE, { ...initialState(EVERY_TYPE), strip_metadata: false, target_size: '25' })).toEqual({ strip_metadata: false, target_size: 25 });
  });

  it('lists "Original" first for an enum whose default is none', () => {
    expect(enumChoices(EVERY_TYPE[3]!).map((choice) => choice.label)).toEqual(['Original', '1080p', '720p', '480p']);
  });

  it('counts pages and estimates a target size', () => {
    expect(parsePages('1-3,7')).toEqual([
      [1, 3],
      [7, 7],
    ]);
    expect(pageCount('1-3,7', 5)).toBe(3);
    expect(pageCount('', 5)).toBe(5);
    expect(targetSizeMb(EVERY_TYPE[6]!, 'preset:discord')).toBe(10);
    // A 10-minute video with sound needs at least (100 + 128) kbps.
    expect(minimumTargetMb(600_000, true)).toBe(18);
    expect(minimumTargetMb(10_000, false)).toBe(1);
  });
});

describe('polling (§8)', () => {
  it('polls every second, every 5 s hidden, and stops when finished', () => {
    expect(pollInterval(true, false)).toBe(POLL_MS);
    expect(POLL_MS).toBe(1000);
    expect(pollInterval(true, true)).toBe(POLL_HIDDEN_MS);
    expect(POLL_HIDDEN_MS).toBe(5000);
    expect(pollInterval(false, false)).toBe(false);
  });
});

describe('conversion messages (§12, §18)', () => {
  it('says how long a timeout ran and which tier gets more', () => {
    expect(conversionMessage('CONVERSION_TIMEOUT', { seconds: 120, ran_seconds: 120, queued_seconds: 8, tier: 'member', max_seconds: 600 })).toBe(
      'The conversion took too long. It ran for 2 minutes after 8 seconds in line. Signed-in accounts get up to 10 minutes.',
    );
  });

  it('explains failures, limits and the busy queue', () => {
    expect(conversionMessage('CONVERSION_FAILED', { reason: 'too_many_pages' })).toBe('The conversion failed. It has too many pages.');
    expect(conversionMessage('CONVERSION_TOO_LARGE', { limit: 50_000_000, unit: 'bytes' })).toBe('This file is too big to convert. The limit is 50 MB.');
    expect(conversionMessage('CONVERSION_LIMIT_REACHED', { limit: 'concurrent', retry_after: 4.2 })).toBe('Too many conversions at once. Wait for one to finish. Try again in 5 seconds.');
    expect(conversionMessage('CONVERTER_BUSY', {}, { anonymous: true })).toBe('Busy right now. Try again, or sign in to skip the queue.');
    expect(conversionMessage('CONVERTER_BUSY', {}, { anonymous: false })).toBe('Busy right now. Try again in a few minutes.');
    expect(conversionMessage('CONVERSION_REQUIRES_ACCOUNT', {}, { apiMessage: 'Sign in to convert in bulk' })).toBe('Sign in to convert in bulk.');
    expect(conversionMessage('UNKNOWN', {})).toBeNull();
  });

  it('rounds a fractional retry_after up (§18.1)', () => {
    expect(conversionMessage('RATE_LIMITED', { retry_after: 0.25 })).toBe('You’re doing that too fast. Try again in 1 second.');
    expect(conversionMessage('RATE_LIMITED', { retry_after: 2.001 })).toBe('You’re doing that too fast. Try again in 3 seconds.');
    expect(conversionMessage('RATE_LIMIT_UNAVAILABLE', {})).toBe('Try again in a moment.');
  });
});
