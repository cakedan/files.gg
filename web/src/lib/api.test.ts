import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, apiBaseUrl, authHeaders, buildUrl, parseApiError, request } from './api';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fn = vi.fn<typeof fetch>(typeof response === 'function' ? response : async () => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof mockFetch>): Record<string, string> {
  const init = fn.mock.calls[0]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('apiBaseUrl', () => {
  it('defaults to https://api.files.gg and strips trailing slashes', () => {
    expect(apiBaseUrl(undefined)).toBe('https://api.files.gg');
    expect(apiBaseUrl('')).toBe('https://api.files.gg');
    expect(apiBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('builds URLs with query params, skipping empty values', () => {
    expect(buildUrl('/users/@me/files', { query: 'cat', offset: 0, temporary: true, type: undefined, sort_by: '' }, 'https://a.b')).toBe(
      'https://a.b/users/@me/files?query=cat&offset=0&temporary=true',
    );
  });
});

describe('authHeaders', () => {
  it('reads JSON-encoded values written by the old app', () => {
    localStorage.setItem('token', JSON.stringify('tok.en'));
    expect(authHeaders()).toEqual({ Authorization: 'tok.en' });
  });

  it('accepts raw (non-JSON) values', () => {
    localStorage.setItem('token', 'raw-token');
    expect(authHeaders()).toEqual({ Authorization: 'raw-token' });
  });

  it('sends X-Fingerprint only while signed out, like the old app', () => {
    localStorage.setItem('fingerprint', JSON.stringify('1234567890'));
    expect(authHeaders()).toEqual({ 'X-Fingerprint': '1234567890' });
    localStorage.setItem('token', JSON.stringify('tok'));
    expect(authHeaders()).toEqual({ Authorization: 'tok' });
  });

  it('sends nothing when storage is empty', () => {
    expect(authHeaders()).toEqual({});
  });

  it('survives getItem throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(authHeaders()).toEqual({});
  });

  it('survives the localStorage getter itself throwing', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      expect(authHeaders()).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });
});

describe('request', () => {
  it('sends auth headers and parses JSON', async () => {
    localStorage.setItem('token', JSON.stringify('tok'));
    const fetchMock = mockFetch(json({ id: '1', username: 'dan' }));
    await expect(api.me()).resolves.toEqual({ id: '1', username: 'dan' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.files.gg/users/@me');
    expect(sentHeaders(fetchMock)).toMatchObject({ Authorization: 'tok', Accept: 'application/json' });
  });

  it('still makes the request when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const fetchMock = mockFetch(json({ ok: true }));
    await request('/anything');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('X-Fingerprint');
  });

  it('defaults the files list to 25 per page', async () => {
    const fetchMock = mockFetch(json({ count: 0, items: [], size: 0, total: { count: 0, size: 0 } }));
    await api.myFiles({ query: 'cat', sort_by: 'largest' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.files.gg/users/@me/files?limit=25&query=cat&sort_by=largest');
  });

  it('serialises object bodies as JSON', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await expect(request('/users/@me/files/delete', { method: 'POST', body: { file_ids: ['1'] } })).resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"file_ids":["1"]}');
    expect(sentHeaders(fetchMock)['Content-Type']).toBe('application/json');
  });

  it('throws ApiError with status, code and message from a { code, message } body', async () => {
    mockFetch(json({ code: 'FILE_TOO_LARGE', message: 'File is too large', status: 413, limit: 100, used: 5 }, { status: 413 }));
    const error = await request('/files', { method: 'POST' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 413, code: 'FILE_TOO_LARGE', message: 'File is too large' });
    expect((error as ApiError).body).toMatchObject({ limit: 100, used: 5 });
  });

  it('keeps numeric codes from the current API', async () => {
    mockFetch(json({ code: 140401, message: 'Unknown File', status: 404 }, { status: 404, statusText: 'Not Found' }));
    await expect(request('/files/x')).rejects.toMatchObject({ status: 404, code: 140401, message: 'Unknown File' });
  });

  it('falls back to statusText for non-JSON error bodies', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(request('/x')).rejects.toMatchObject({ status: 502, code: null, message: 'Bad Gateway' });
  });

  it('turns network failures into ApiError status 0', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await request('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR', isNetworkError: true });
  });

  it('rethrows aborts untouched', async () => {
    mockFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(request('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('parseApiError', () => {
  it('handles an empty body', async () => {
    const error = await parseApiError(new Response(null, { status: 401, statusText: 'Unauthorized' }));
    expect(error).toMatchObject({ status: 401, code: null, message: 'Unauthorized', isUnauthorized: true });
  });

  it('ignores non-string messages and non-scalar codes', async () => {
    const error = await parseApiError(json({ code: { nested: true }, message: 42 }, { status: 400 }));
    expect(error.code).toBeNull();
    expect(error.message).toBe('Request failed with status 400');
  });
});
