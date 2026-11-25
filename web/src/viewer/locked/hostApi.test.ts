import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { resetHostContext } from '../host/context';
import { enterCustomHost } from '../host/testing';
import { viewerApi } from './hostApi';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** milestone-3's first signed-URL vector: the signature covers the path only. */
const SIGNED_PATH = '/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';
const file = {
  kind: 'image',
  filename: 'holiday.png',
  url: 'https://files.gg/abc123',
  cdn_url: `https://cdn.files.gg${SIGNED_PATH}`,
  thumbnail: { url: 'https://cdn.files.gg/previews/thumb/abc123.webp?v=5&expires=1795603600&sig=T_t-1', type: 'thumb' },
};

function mockFetch(response: () => Response) {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => response());
  vi.stubGlobal('fetch', fn);
  return fn;
}

const call = (fetch: ReturnType<typeof mockFetch>, n = 0) => {
  const [url, init] = fetch.mock.calls[n]!;
  return { url, init, headers: init.headers as Record<string, string> };
};

afterEach(() => {
  resetHostContext();
  localStorage.clear();
});

describe('viewerApi on a custom host (milestone-6 §10.11)', () => {
  it('unlock: POST api.files.gg without credentials, cookie, fingerprint or CSRF header', async () => {
    enterCustomHost();
    localStorage.setItem('filesgg.fingerprint', '42');
    localStorage.setItem('filesgg.token', 'legacy');
    const fetch = mockFetch(() => json({ token: 't', expires_at: 1, file }));
    await viewerApi.unlock('file', 'abc123', 'pw', 'XXXX.DUMMY.TOKEN.XXXX');
    const { url, init, headers } = call(fetch);
    expect(url).toBe('https://api.files.gg/access/unlock/files/abc123');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.mode).toBe('cors');
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'Content-Type']);
    expect(JSON.parse(String(init.body))).toEqual({ password: 'pw', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
  });

  it('view: X-Filesgg-Access is the only extra header; refresh sends the token in the body', async () => {
    enterCustomHost();
    const fetch = mockFetch(() => json({ token: 't', expires_at: 1, album: { vanity: 'Ab3', items: [] } }));
    await viewerApi.view('album', 'Ab3', 'pass');
    await viewerApi.refreshUnlock('file', 'a/b', 'tok');
    expect(call(fetch, 0).url).toBe('https://api.files.gg/access/view/albums/Ab3');
    expect(call(fetch, 0).init.credentials).toBe('omit');
    expect(call(fetch, 0).headers).toEqual({ Accept: 'application/json', 'X-Filesgg-Access': 'pass' });
    expect(call(fetch, 1).url).toBe('https://api.files.gg/access/refresh/files/a/b');
    expect(call(fetch, 1).init.credentials).toBe('omit');
    expect(JSON.parse(String(call(fetch, 1).init.body))).toEqual({ token: 'tok' });
  });

  it('rehosts every payload URL onto this domain, byte for byte after the origin, so signatures still verify', async () => {
    enterCustomHost();
    mockFetch(() => json({ token: 't', expires_at: 1, file }));
    const response = await viewerApi.view('file', 'abc123', 'pass');
    const shown = response.file as typeof file;
    expect(shown.cdn_url).toBe(`https://i.example.com${SIGNED_PATH}`);
    expect(new URL(shown.cdn_url).pathname + new URL(shown.cdn_url).search).toBe(SIGNED_PATH);
    expect(shown.thumbnail.url).toBe('https://i.example.com/previews/thumb/abc123.webp?v=5&expires=1795603600&sig=T_t-1');
    expect(shown.url).toBe('https://i.example.com/abc123');
    expect(shown.filename).toBe('holiday.png');
  });

  it('errors are ApiErrors with the API\'s code; offline is a network error', async () => {
    enterCustomHost();
    mockFetch(() => json({ code: 'UNKNOWN_FILE', message: 'Unknown file.', status: 404 }, 404));
    const failure = await viewerApi.unlock('file', 'gone', 'pw', 't').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, code: 'UNKNOWN_FILE' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(viewerApi.view('file', 'abc', 'x')).rejects.toMatchObject({ status: 0, isNetworkError: true });
  });

  it('uses api_origin from #host-data, not a hard-coded host', async () => {
    enterCustomHost({ apiOrigin: 'https://api.staging.example' });
    const fetch = mockFetch(() => json({ token: 't', expires_at: 1 }));
    await viewerApi.view('file', 'abc', 'x');
    expect(call(fetch).url).toBe('https://api.staging.example/access/view/files/abc');
  });
});

describe('viewerApi on files.gg', () => {
  it('goes through lib/api (never credential-less, never rehosted)', async () => {
    const fetch = mockFetch(() => json({ token: 't', expires_at: 1, file }));
    const response = await viewerApi.view('file', 'abc123', 'pass');
    expect(call(fetch).init.credentials).not.toBe('omit');
    expect(call(fetch).url).toMatch(/\/access\/view\/files\/abc123$/);
    expect((response.file as typeof file).cdn_url).toBe(file.cdn_url);
  });
});
