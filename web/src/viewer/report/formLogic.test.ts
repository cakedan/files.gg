import { describe, expect, it } from 'vitest';

import { buildReport, emptyDmca, initialReportUrl, parseReportUrl, reasonsFor, serverFieldErrors, validateReport, type ReportFormState } from './formLogic';

const state = (extra: Partial<ReportFormState> = {}): ReportFormState => ({
  url: '',
  reason: '',
  part: 'whole',
  details: '',
  contactEmail: '',
  dmca: emptyDmca(),
  ...extra,
});

describe('parseReportUrl', () => {
  it('accepts files.gg and cdn.files.gg links, with or without a scheme', () => {
    expect(parseReportUrl('https://files.gg/abc123.png?x=1#y')).toEqual({ kind: 'url', url: 'https://files.gg/abc123.png' });
    expect(parseReportUrl('files.gg/abc123')).toEqual({ kind: 'url', url: 'https://files.gg/abc123' });
    expect(parseReportUrl('https://cdn.files.gg/previews/thumb/abc.webp?v=5')).toEqual({
      kind: 'url',
      url: 'https://cdn.files.gg/previews/thumb/abc.webp',
    });
  });

  it('turns album page links into album targets, but not album items', () => {
    expect(parseReportUrl('https://files.gg/a/Ab3dE6gH')).toMatchObject({ kind: 'album', vanity: 'Ab3dE6gH' });
    expect(parseReportUrl('https://files.gg/a/Ab3dE6gH/report')).toMatchObject({ kind: 'album', vanity: 'Ab3dE6gH' });
    expect(parseReportUrl('https://files.gg/a/Ab3dE6gH/2')).toEqual({ kind: 'url', url: 'https://files.gg/a/Ab3dE6gH/2' });
  });

  it('rejects other hosts, schemes and empty paths', () => {
    for (const bad of ['', 'https://example.com/abc', 'ftp://files.gg/abc', 'https://files.gg/', 'https://files.gg/report', 'not a url at all', 'https://www.files.gg/abc123', 'www.files.gg/a/Ab3dE6gH']) {
      expect(parseReportUrl(bad)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('reasons (§7.3)', () => {
  it('offers bug only on the any page', () => {
    expect(reasonsFor({ type: 'file', vanity: 'a' })).not.toContain('bug');
    expect(reasonsFor({ type: 'album', vanity: 'a' })).toHaveLength(9);
    expect(reasonsFor({ type: 'any' })).toContain('bug');
  });
});

describe('validateReport', () => {
  const file = { type: 'file', vanity: 'abc' } as const;

  it('needs a reason, and details for other, bug and copyright', () => {
    expect(validateReport(file, state(), false)).toEqual({ reason: 'Choose a reason.' });
    expect(validateReport(file, state({ reason: 'spam' }), false)).toEqual({});
    expect(validateReport(file, state({ reason: 'other' }), false)).toEqual({ details: 'Add some details.' });
    expect(validateReport({ type: 'any' }, state({ reason: 'bug' }), false)).toEqual({ details: 'Add some details.' });
  });

  it('checks the optional contact email only when signed out', () => {
    expect(validateReport(file, state({ reason: 'spam', contactEmail: 'nope' }), false)).toEqual({
      contact_email: "That email address doesn't look right.",
    });
    expect(validateReport(file, state({ reason: 'spam', contactEmail: 'nope' }), true)).toEqual({});
  });

  it('needs a link on the any page, except for bugs', () => {
    expect(validateReport({ type: 'any' }, state({ reason: 'spam' }), true).url).toBe('Enter the link to the file or album.');
    expect(validateReport({ type: 'any' }, state({ reason: 'spam', url: 'https://example.com/x' }), true).url).toBe(
      'Enter a files.gg or cdn.files.gg link.',
    );
    expect(validateReport({ type: 'any' }, state({ reason: 'bug', details: 'Broken' }), true)).toEqual({});
  });

  it('needs every DMCA field for copyright', () => {
    const errors = validateReport(file, state({ reason: 'copyright', details: 'Mine' }), true);
    expect(Object.keys(errors).sort()).toEqual(
      [
        'dmca.accurate_and_authorised',
        'dmca.address',
        'dmca.email',
        'dmca.good_faith',
        'dmca.name',
        'dmca.phone',
        'dmca.signature',
        'dmca.urls',
        'dmca.work',
      ].sort(),
    );
    const urls = validateReport(file, state({ reason: 'copyright', dmca: { ...emptyDmca('https://example.com/x') } }), true);
    expect(urls['dmca.urls']).toBe('Every link must be a files.gg or cdn.files.gg link.');
  });
});

describe('buildReport', () => {
  it('builds file, album (with part), url and bug targets', () => {
    expect(buildReport({ type: 'file', vanity: 'abc' }, state({ reason: 'spam' }), true)).toEqual({
      target: { type: 'file', vanity: 'abc' },
      reason: 'spam',
    });
    expect(buildReport({ type: 'album', vanity: 'Ab3' }, state({ reason: 'harassment', part: 'captions' }), true).target).toEqual({
      type: 'album',
      vanity: 'Ab3',
      part: 'captions',
    });
    expect(buildReport({ type: 'any' }, state({ reason: 'malware', url: 'files.gg/abc.png' }), true).target).toEqual({
      type: 'url',
      url: 'https://files.gg/abc.png',
    });
    expect(buildReport({ type: 'any' }, state({ reason: 'bug', url: 'files.gg/abc', details: 'x' }), true).target).toEqual({ type: 'bug' });
  });

  it('sends the contact email only when signed out, and trims details', () => {
    const s = state({ reason: 'spam', details: '  hi  ', contactEmail: ' me@example.com ' });
    expect(buildReport({ type: 'file', vanity: 'a' }, s, false)).toMatchObject({ details: 'hi', contact_email: 'me@example.com' });
    expect(buildReport({ type: 'file', vanity: 'a' }, s, true).contact_email).toBeUndefined();
  });

  it('includes the DMCA notice for copyright, with one URL per line', () => {
    const dmca = {
      name: 'A',
      address: 'B',
      phone: '1',
      email: 'a@b.co',
      work: 'My photo',
      urls: 'https://files.gg/abc\nfiles.gg/def',
      good_faith: true,
      accurate_and_authorised: true,
      signature: 'A',
    };
    expect(buildReport({ type: 'file', vanity: 'abc' }, state({ reason: 'copyright', details: 'x', dmca }), true).dmca).toEqual({
      ...dmca,
      urls: ['https://files.gg/abc', 'https://files.gg/def'],
    });
  });
});

describe('serverFieldErrors', () => {
  it('maps DETAILS_REQUIRED and DMCA_FIELDS_REQUIRED', () => {
    expect(serverFieldErrors({ errors: { details: 'Too short.' } }, 'DETAILS_REQUIRED')).toEqual({ details: 'Too short.' });
    expect(serverFieldErrors({}, 'DETAILS_REQUIRED')).toEqual({ details: 'Add some details.' });
    expect(serverFieldErrors({ errors: { phone: 'Required.', bogus: 'x' } }, 'DMCA_FIELDS_REQUIRED')).toEqual({ 'dmca.phone': 'Required.' });
    expect(serverFieldErrors({ errors: { details: 'x' } }, 'MAX_REPORTS')).toEqual({});
  });
});

describe('initialReportUrl', () => {
  it('reads ?url=', () => {
    expect(initialReportUrl('?url=https%3A%2F%2Ffiles.gg%2Fabc')).toBe('https://files.gg/abc');
    expect(initialReportUrl('')).toBe('');
  });
});

describe('custom domains (milestone-6 §10.12)', () => {
  it('a custom host\'s own links are accepted there, by host and port, and nowhere else', () => {
    expect(parseReportUrl('https://i.example.com/abc', ['i.example.com'])).toEqual({ kind: 'url', url: 'https://i.example.com/abc' });
    expect(parseReportUrl('i.example.com/a/Ab3/report', ['i.example.com'])).toEqual({ kind: 'album', vanity: 'Ab3', url: 'https://i.example.com/a/Ab3/report' });
    expect(parseReportUrl('https://i.example.com/files/abc.png?sig=x', ['i.example.com'])).toEqual({ kind: 'url', url: 'https://i.example.com/files/abc.png' });
    expect(parseReportUrl('https://i.example.com/abc', [])).toEqual({ kind: 'invalid' });
    expect(parseReportUrl('https://j.example.com/abc', ['i.example.com'])).toEqual({ kind: 'invalid' });
    expect(parseReportUrl('https://files.gg/abc', ['i.example.com'])).toEqual({ kind: 'url', url: 'https://files.gg/abc' });
  });

  it('a domain is reported for malware, spam, harassment or something else, as { type: "domain", hostname }', () => {
    const target = { type: 'domain', hostname: 'i.example.com' } as const;
    expect(reasonsFor(target)).toEqual(['malware', 'spam', 'harassment', 'other']);
    expect(buildReport(target, state({ reason: 'malware' }), false)).toEqual({ target: { type: 'domain', hostname: 'i.example.com' }, reason: 'malware' });
    expect(validateReport(target, state({ reason: 'other' }), false).details).toBe('Add some details.');
  });
});
