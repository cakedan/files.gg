import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, apiBaseUrl, authHeaders, buildUrl, ensureFingerprint, parseApiError, request } from './api';

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

  it('resolves a path base (the dev mock) against the page origin', () => {
    expect(apiBaseUrl('/__mock-api')).toBe(`${window.location.origin}/__mock-api`);
  });

  it('builds URLs with query params, skipping empty values', () => {
    expect(buildUrl('/users/@me/files', { query: 'cat', offset: 0, temporary: true, type: undefined, sort_by: '' }, 'https://a.b')).toBe(
      'https://a.b/users/@me/files?query=cat&offset=0&temporary=true',
    );
  });
});

describe('authHeaders', () => {
  it('reads the token from filesgg.token, as a plain string', () => {
    localStorage.setItem('filesgg.token', 'tok.en');
    expect(authHeaders()).toEqual({ Authorization: 'tok.en' });
  });

  it('ignores the old app\'s keys', () => {
    localStorage.setItem('token', JSON.stringify('old'));
    localStorage.setItem('fingerprint', JSON.stringify('123'));
    expect(authHeaders()).toEqual({});
  });

  it('sends X-Fingerprint only while signed out', () => {
    localStorage.setItem('filesgg.fingerprint', '1234567890');
    expect(authHeaders()).toEqual({ 'X-Fingerprint': '1234567890' });
    localStorage.setItem('filesgg.token', 'tok');
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
    localStorage.setItem('filesgg.token', 'tok');
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
    await api.myFiles({ query: 'cat', sort_by: '-size' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.files.gg/users/@me/files?limit=25&query=cat&sort_by=-size');
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

  it('accepts only string codes: a numeric one is dropped', async () => {
    mockFetch(json({ code: 140401, message: 'Unknown File', status: 404 }, { status: 404, statusText: 'Not Found' }));
    await expect(request('/files/x')).rejects.toMatchObject({ status: 404, code: null, message: 'Unknown File' });
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

describe('Milestone 2 endpoints', () => {
  it('unlock posts password + Turnstile token without auth headers', async () => {
    localStorage.setItem('filesgg.token', 'tok');
    const fetchMock = mockFetch(json({ token: 't', expires_at: 1, file: {} }));
    await api.unlock('album', 'v1', 'pw', 'XXXX.DUMMY.TOKEN.XXXX');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.files.gg/albums/v1/unlock');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
  });

  it('view sends the token in X-Filesgg-Access, never the query string', async () => {
    const fetchMock = mockFetch(json({ file: {}, token: 'secret-token', expires_at: 1 }));
    await api.view('file', 'abcd/xyz', 'secret-token');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.files.gg/files/abcd/xyz/view');
    expect(sentHeaders(fetchMock)['X-Filesgg-Access']).toBe('secret-token');
  });

  it('ensureFingerprint reuses a stored fingerprint or fetches and stores one', async () => {
    const fetchMock = mockFetch(json({ fingerprint: '123' }));
    await expect(ensureFingerprint()).resolves.toBe('123');
    expect(localStorage.getItem('filesgg.fingerprint')).toBe('123');
    await expect(ensureFingerprint()).resolves.toBe('123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    localStorage.setItem('filesgg.token', 't');
    await expect(ensureFingerprint()).resolves.toBeNull();
  });
});

describe('Milestone 3 owner endpoints (milestone-3 contract §6)', () => {
  const lastCall = (fn: ReturnType<typeof mockFetch>) => {
    const [url, init] = fn.mock.calls.at(-1)!;
    return { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  it.each([
    ['updateFile', () => api.updateFile('7', { filename: 'new' }), 'PATCH', '/users/@me/files/7', { filename: 'new' }],
    ['deleteFile', () => api.deleteFile('7'), 'DELETE', '/users/@me/files/7', undefined],
    ['deleteFiles', () => api.deleteFiles(['1', '2']), 'POST', '/users/@me/files/delete', { file_ids: ['1', '2'] }],
    ['setFilesExpiry (keep forever)', () => api.setFilesExpiry(['1'], null), 'POST', '/users/@me/files/expiry', { file_ids: ['1'], expires_in: null }],
    [
      'setFilesAccess',
      () => api.setFilesAccess(['1'], { visibility: 'password', generate_password: true }),
      'POST',
      '/users/@me/files/access',
      { file_ids: ['1'], visibility: 'password', generate_password: true },
    ],
    ['filePass', () => api.filePass('7'), 'POST', '/users/@me/files/7/pass', undefined],
    ['createAlbum', () => api.createAlbum({ file_ids: ['1'] }), 'POST', '/users/@me/albums', { file_ids: ['1'] }],
    ['album', () => api.album('9'), 'GET', '/users/@me/albums/9', undefined],
    ['updateAlbum', () => api.updateAlbum('9', { cover_file_id: null }), 'PATCH', '/users/@me/albums/9', { cover_file_id: null }],
    ['deleteAlbum', () => api.deleteAlbum('9'), 'DELETE', '/users/@me/albums/9', undefined],
    ['deleteAlbum with files', () => api.deleteAlbum('9', true), 'DELETE', '/users/@me/albums/9?delete_files=true', undefined],
    ['setAlbumFiles', () => api.setAlbumFiles('9', ['2', '1']), 'PUT', '/users/@me/albums/9/files', { file_ids: ['2', '1'] }],
    ['addAlbumFiles', () => api.addAlbumFiles('9', ['3'], 0), 'POST', '/users/@me/albums/9/files', { file_ids: ['3'], position: 0 }],
    ['removeAlbumFile', () => api.removeAlbumFile('9', '3'), 'DELETE', '/users/@me/albums/9/files/3', undefined],
    ['setAlbumCaption', () => api.setAlbumCaption('9', '3', 'Hi'), 'PATCH', '/users/@me/albums/9/files/3', { caption: 'Hi' }],
    ['albumPass', () => api.albumPass('9'), 'POST', '/users/@me/albums/9/pass', undefined],
    ['myAlbums', () => api.myAlbums({ query: 'trip', offset: 0, limit: 10 }), 'GET', '/users/@me/albums?query=trip&offset=0&limit=10', undefined],
  ] as const)('%s', async (_name, call, method, path, body) => {
    const fetchMock = mockFetch(json({}));
    await call();
    const sent = lastCall(fetchMock);
    expect(sent.url).toBe(`https://api.files.gg${path}`);
    expect(sent.method ?? 'GET').toBe(method);
    expect(sent.body).toEqual(body);
  });

  it('maps an album error body to an ApiError with its details', async () => {
    mockFetch(json({ code: 'INVALID_ALBUM_FILES', message: 'nope', status: 400, file_ids: ['5'] }, { status: 400 }));
    const error = await api.addAlbumFiles('9', ['5']).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, code: 'INVALID_ALBUM_FILES', body: { file_ids: ['5'] } });
  });
});
