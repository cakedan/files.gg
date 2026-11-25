import { afterEach, describe, expect, it } from 'vitest';

import { shareUrl } from '../urls';
import { hostContext, mainUrl, parseHostContext, resetHostContext, siteName } from './context';
import { fallbackUrl } from './fallback';
import { customHostContext, enterCustomHost } from './testing';

const base = { origin: 'https://i.example.com', locationHost: 'i.example.com' };
const hostJson = (data: Record<string, unknown>) => JSON.stringify(data);

afterEach(() => {
  resetHostContext();
  document.body.replaceChildren();
});

describe('parseHostContext', () => {
  it('is files.gg without data-host="custom"', () => {
    expect(parseHostContext({ ...base, dataHost: null, hostJson: hostJson({ host: 'evil.example' }) })).toMatchObject({
      custom: false,
      host: '',
      mainOrigin: 'https://files.gg',
    });
  });

  it('reads #host-data on a custom host (milestone-6 §13.4)', () => {
    const context = parseHostContext({
      ...base,
      dataHost: 'custom',
      hostJson: hostJson({ host: 'I.Example.com', main_origin: 'https://files.gg', api_origin: 'https://api.files.gg/' }),
    });
    expect(context).toEqual({
      custom: true,
      host: 'i.example.com',
      origin: 'https://i.example.com',
      mainOrigin: 'https://files.gg',
      apiOrigin: 'https://api.files.gg',
      cdnOrigin: 'https://cdn.files.gg',
    });
  });

  it('falls back to safe defaults for malformed or unsafe data, never to plain http on a public host', () => {
    const context = parseHostContext({
      ...base,
      dataHost: 'custom',
      hostJson: hostJson({ host: 'bad host!', main_origin: 'http://files.gg', api_origin: 'javascript:alert(1)', cdn_origin: 'https://user:pw@cdn.example' }),
    });
    expect(context).toMatchObject({
      custom: true,
      host: 'i.example.com',
      mainOrigin: 'https://files.gg',
      apiOrigin: 'https://api.files.gg',
      cdnOrigin: 'https://cdn.files.gg',
    });
    expect(parseHostContext({ ...base, dataHost: 'custom', hostJson: '{not json' })).toMatchObject({ custom: true, apiOrigin: 'https://api.files.gg' });
  });

  it('allows http only on a local development host, and keeps a path on the API base (a prefixed mock)', () => {
    const context = parseHostContext({
      origin: 'http://localhost:5173',
      locationHost: 'localhost:5173',
      dataHost: 'custom',
      hostJson: hostJson({ host: 'localhost:5173', main_origin: 'http://localhost:5173', api_origin: 'http://localhost:5173/__mock-api' }),
    });
    expect(context).toMatchObject({ host: 'localhost:5173', mainOrigin: 'http://localhost:5173', apiOrigin: 'http://localhost:5173/__mock-api' });
  });

  it('reads the live document once, until reset', () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.dataset.host = 'custom';
    const data = document.createElement('script');
    data.id = 'host-data';
    data.type = 'application/json';
    data.textContent = hostJson({ host: 'i.example.com', main_origin: 'https://files.gg', api_origin: 'https://api.files.gg' });
    document.body.append(root, data);
    resetHostContext();
    expect(hostContext()).toMatchObject({ custom: true, host: 'i.example.com', origin: window.location.origin });
    root.dataset.host = '';
    expect(hostContext().custom).toBe(true);
    resetHostContext();
    expect(hostContext().custom).toBe(false);
  });
});

describe('links on a custom host', () => {
  it('titles use the domain; files.gg paths go to the main origin', () => {
    expect(siteName()).toBe('files.gg');
    expect(mainUrl('/legal/terms')).toBe('/legal/terms');
    enterCustomHost();
    expect(siteName()).toBe('i.example.com');
    expect(mainUrl('/legal/terms')).toBe('https://files.gg/legal/terms');
  });

  it('Copy link is built on location.origin: a payload URL on files.gg moves onto this domain, byte for byte', () => {
    const location = { origin: 'https://i.example.com', pathname: '/abc' };
    const custom = customHostContext();
    expect(shareUrl('https://files.gg/abc', location, custom)).toBe('https://i.example.com/abc');
    expect(shareUrl('https://files.gg/a/Ab3#pw=x%20y', location, custom)).toBe('https://i.example.com/a/Ab3#pw=x%20y');
    expect(shareUrl('https://i.example.com/abc', location, custom)).toBe('https://i.example.com/abc');
    expect(shareUrl(undefined, location, custom)).toBe('https://i.example.com/abc');
    // files.gg itself is unchanged.
    expect(shareUrl('https://files.gg/abc', { origin: 'https://files.gg', pathname: '/abc' }, { ...custom, custom: false })).toBe('https://files.gg/abc');
  });

  it('"Open on files.gg to continue" goes to the same file, album or report page on files.gg', () => {
    expect(fallbackUrl({ type: 'file', vanity: 'abc' }, 'https://files.gg')).toBe('https://files.gg/abc');
    expect(fallbackUrl({ type: 'album', vanity: 'Ab 3' }, 'https://files.gg')).toBe('https://files.gg/a/Ab%203');
    // milestone-6 §20.2: the report pages put the vanity last
    expect(fallbackUrl({ type: 'file', vanity: 'abc', report: true }, 'https://files.gg')).toBe('https://files.gg/report/abc');
    expect(fallbackUrl({ type: 'file', vanity: 'abcd/xyz', report: true }, 'https://files.gg')).toBe('https://files.gg/report/abcd/xyz');
    expect(fallbackUrl({ type: 'album', vanity: 'Ab3', report: true }, 'https://files.gg')).toBe('https://files.gg/report/a/Ab3');
    expect(fallbackUrl({ type: 'any' }, 'https://files.gg')).toBe('https://files.gg/report');
  });
});
