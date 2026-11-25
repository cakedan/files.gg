import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchFragmentSecrets } from '../../lib/access';
import { GRAMMARS, LANGUAGE_NAMES, normalizeLanguage, resolveLanguage } from './languages';
import { fetchText, MAX_PREVIEW_BYTES, splitLines, tooLargeFromPayload } from './limits';
import { clampRange, formatLineHash, parseLineHash, selectLine } from './lineAnchors';

describe('line anchors', () => {
  it('parses #L5 and #L5-L9 (and tolerant spellings)', () => {
    expect(parseLineHash('#L5')).toEqual({ start: 5, end: 5 });
    expect(parseLineHash('#L5-L9')).toEqual({ start: 5, end: 9 });
    expect(parseLineHash('#L5-9')).toEqual({ start: 5, end: 9 });
    expect(parseLineHash('#L9-L5')).toEqual({ start: 5, end: 9 });
    expect(parseLineHash('#l12')).toEqual({ start: 12, end: 12 });
    expect(parseLineHash('#L5-L9=')).toEqual({ start: 5, end: 9 });
    for (const bad of ['', '#', '#L0', '#Lx', '#page=3', '#L5-', '#L5&pw=x']) expect(parseLineHash(bad)).toBeNull();
  });

  it('formats and clamps ranges', () => {
    expect(formatLineHash({ start: 5, end: 5 })).toBe('#L5');
    expect(formatLineHash({ start: 5, end: 9 })).toBe('#L5-L9');
    expect(clampRange({ start: 5, end: 90 }, 20)).toEqual({ start: 5, end: 20 });
    expect(clampRange({ start: 50, end: 90 }, 20)).toBeNull();
    expect(clampRange(null, 20)).toBeNull();
  });

  it('selects a line, or a range from the anchor on shift-click', () => {
    expect(selectLine(7, 3, false)).toEqual({ start: 7, end: 7 });
    expect(selectLine(7, 3, true)).toEqual({ start: 3, end: 7 });
    expect(selectLine(2, 9, true)).toEqual({ start: 2, end: 9 });
    expect(selectLine(4, null, true)).toEqual({ start: 4, end: 4 });
  });

  it('is left alone by the #pw= / #t= hash watcher in main.tsx', () => {
    window.history.replaceState(null, '', '/abc.py');
    const replace = vi.spyOn(window.history, 'replaceState');
    const onSecrets = vi.fn();
    const stop = watchFragmentSecrets(onSecrets);
    window.location.hash = '#L5-L9';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(onSecrets).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#L5-L9');
    stop();
    window.history.replaceState(null, '', '/');
  });
});

describe('languages', () => {
  const text = (filename: string, language?: string) => ({
    filename,
    extension: filename.includes('.') ? filename.split('.').pop()! : '',
    media: language === undefined ? undefined : { language },
  });

  it('prefers media.language, then the filename, then the extension, else plain text', () => {
    expect(resolveLanguage(text('script.txt', 'python'))).toBe('python');
    expect(resolveLanguage(text('main.rs'))).toBe('rust');
    expect(resolveLanguage(text('App.TSX'))).toBe('tsx');
    expect(resolveLanguage(text('Dockerfile'))).toBe('dockerfile');
    expect(resolveLanguage(text('notes.txt'))).toBeNull();
    expect(resolveLanguage(text('data.unknownext'))).toBeNull();
    expect(resolveLanguage(text('a.js', 'klingon'))).toBe('javascript');
  });

  it('understands common aliases', () => {
    expect(normalizeLanguage('bash')).toBe('shellscript');
    expect(normalizeLanguage('C++')).toBe('cpp');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('plaintext')).toBeNull();
  });

  it('has a grammar loader and a name for every language', () => {
    expect(Object.keys(GRAMMARS).sort()).toEqual(Object.keys(LANGUAGE_NAMES).sort());
  });
});

describe('limits', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('knows from the payload when a file is too large', () => {
    expect(tooLargeFromPayload({ size: MAX_PREVIEW_BYTES })).toBe(false);
    expect(tooLargeFromPayload({ size: MAX_PREVIEW_BYTES + 1 })).toBe(true);
    expect(tooLargeFromPayload({ size: 10, media: { lines: 20_001 } })).toBe(true);
    expect(tooLargeFromPayload({ size: 10, media: { lines: 20_000 } })).toBe(false);
  });

  it('splits lines like the viewer shows them', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual(['']);
    expect(splitLines('\n')).toEqual(['']);
  });

  it('fetches text and enforces the byte and line limits', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(new Response('one\r\ntwo\n'));
    const signed = 'https://cdn.files.gg/files/a.txt?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';
    await expect(fetchText(signed)).resolves.toEqual({ status: 'ready', text: 'one\ntwo\n', lines: ['one', 'two'] });
    expect(fetchMock).toHaveBeenLastCalledWith(signed, expect.objectContaining({ credentials: 'omit' }));

    fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(MAX_PREVIEW_BYTES + 1) } }));
    await expect(fetchText('u')).resolves.toEqual({ status: 'too-large' });

    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(MAX_PREVIEW_BYTES + 1)));
    await expect(fetchText('u')).resolves.toEqual({ status: 'too-large' });

    fetchMock.mockResolvedValueOnce(new Response('\n'.repeat(20_001) + 'x'));
    await expect(fetchText('u')).resolves.toEqual({ status: 'too-large', lines: 20_002 });

    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    await expect(fetchText('u')).rejects.toThrow();
  });
});
