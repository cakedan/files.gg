import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accessPath, api, ApiError, apiBaseUrl, authHeaders, buildUrl, ensureGuest, onAuthEvent, openPath, parseApiError, request, setSignedInState, signedInState, type AuthEvent } from './api';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

function mockFetch(response: Response | ((input: RequestInfo | URL) => Promise<Response>)) {
  const fn = vi.fn<typeof fetch>(typeof response === 'function' ? response : async () => response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof mockFetch>, n = 0): Record<string, string> {
  const init = fn.mock.calls[n]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

const API = `${window.location.origin}/api`;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('apiBaseUrl', () => {
  it('defaults to same-origin /api (milestone-6 §13.1) and strips trailing slashes', () => {
    expect(apiBaseUrl(undefined)).toBe(API);
    expect(apiBaseUrl('')).toBe(API);
    expect(apiBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('resolves any path base against the page origin', () => {
    expect(apiBaseUrl('/api/')).toBe(API);
  });

  it('builds URLs with query params, skipping empty values', () => {
    expect(buildUrl('/users/@me/files', { query: 'cat', offset: 0, temporary: true, type: undefined, sort_by: '' }, 'https://a.b')).toBe(
      'https://a.b/users/@me/files?query=cat&offset=0&temporary=true',
    );
  });
});

describe('authHeaders (milestone-6 §3.6, §13.1)', () => {
  it('never sends a credential: no Authorization, and the old filesgg.token is ignored', () => {
    localStorage.setItem('filesgg.token', 'tok.en');
    expect(authHeaders()).toEqual({});
    expect(authHeaders('POST')).toEqual({ 'X-Filesgg-Csrf': '1' });
  });

  it('adds X-Filesgg-Csrf on every state-changing method, never on safe ones', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(authHeaders(method)).toEqual({ 'X-Filesgg-Csrf': '1' });
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(authHeaders(method)).toEqual({});
  });

  it('ignores the old app\'s keys', () => {
    localStorage.setItem('token', JSON.stringify('old'));
    localStorage.setItem('fingerprint', JSON.stringify('123'));
    expect(authHeaders()).toEqual({});
  });

  it('sends Authorization: Guest only while not known to be signed in', () => {
    localStorage.setItem('filesgg.guest', '1234567890');
    expect(authHeaders()).toEqual({ Authorization: 'Guest 1234567890' });
    setSignedInState(false);
    expect(authHeaders()).toEqual({ Authorization: 'Guest 1234567890' });
    setSignedInState(true);
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

describe('session and cookie behaviour (milestone-6 §3, §13.1)', () => {
  it('calls same-origin /api with credentials: same-origin, and the CSRF header only on writes', async () => {
    const fetchMock = mockFetch(async () => json({}));
    await request('/users/@me');
    await request('/users/@me', { method: 'PATCH', body: { display_name: 'Dan' } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/users/@me`);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(sentHeaders(fetchMock, 0)).not.toHaveProperty('X-Filesgg-Csrf');
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
    expect(sentHeaders(fetchMock, 1)['X-Filesgg-Csrf']).toBe('1');
    expect(sentHeaders(fetchMock, 1)).not.toHaveProperty('Authorization');
  });

  it('sends the CSRF header on public writes too (unlock carries the cookie same-origin), and drops it with credentials: omit', async () => {
    const fetchMock = mockFetch(async () => json({ token: 't', expires_at: 1, file: {} }));
    await api.unlock('file', 'v1', 'pw', 'XXXX.DUMMY.TOKEN.XXXX');
    expect(sentHeaders(fetchMock)['X-Filesgg-Csrf']).toBe('1');
    await request('/x', { method: 'POST', credentials: 'omit' });
    expect(sentHeaders(fetchMock, 1)).not.toHaveProperty('X-Filesgg-Csrf');
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe('omit');
  });

  it('api.session reads GET /auth/session and remembers the answer', async () => {
    mockFetch(json({ user: { id: '1', username: 'dan.w' } }));
    await expect(api.session()).resolves.toMatchObject({ id: '1' });
    expect(signedInState()).toBe(true);
    mockFetch(json({ user: null }));
    await expect(api.session()).resolves.toBeNull();
    expect(signedInState()).toBe(false);
  });

  it('a 401 on a signed-in call announces "unauthorized"; signed out or on /auth/* it does not', async () => {
    const events: AuthEvent[] = [];
    const stop = onAuthEvent((event) => events.push(event));
    mockFetch(json({ code: 'UNAUTHORIZED', message: 'x', status: 401 }, { status: 401 }));
    await request('/users/@me/files').catch(() => undefined);
    expect(events).toEqual([]);
    setSignedInState(true);
    await request('/auth/reauth', { method: 'POST' }).catch(() => undefined);
    expect(events).toEqual([]);
    await request('/users/@me/files').catch(() => undefined);
    expect(events).toEqual([{ type: 'unauthorized' }]);
    stop();
  });

  it('announces 403 CSRF (and logs it) and 403 ACCOUNT_PENDING_DELETION', async () => {
    const events: AuthEvent[] = [];
    const stop = onAuthEvent((event) => events.push(event));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch(json({ code: 'CSRF', message: 'x', status: 403 }, { status: 403 }));
    await request('/users/@me', { method: 'PATCH' }).catch(() => undefined);
    expect(events[0]).toMatchObject({ type: 'csrf' });
    expect(log).toHaveBeenCalled();
    mockFetch(json({ code: 'ACCOUNT_PENDING_DELETION', message: 'x', status: 403, scheduled_for: 1 }, { status: 403 }));
    await request('/users/@me/files').catch(() => undefined);
    expect(events[1]).toEqual({ type: 'pending-deletion' });
    stop();
  });

  it('ensureGuest asks who is signed in first: none when signed in, else the stored or a new one', async () => {
    const fetchMock = mockFetch(async (input) =>
      String(input).endsWith('/auth/session') ? json({ user: null }) : json({ guest: '123' }),
    );
    await expect(ensureGuest()).resolves.toBe('123');
    expect(localStorage.getItem('filesgg.guest')).toBe('123');
    await expect(ensureGuest()).resolves.toBe('123');
    expect(fetchMock.mock.calls.map(([url]) => String(url).replace(API, ''))).toEqual(['/auth/session', '/auth/guest']);
    setSignedInState(true);
    await expect(ensureGuest()).resolves.toBeNull();
  });
});

describe('request', () => {
  it('parses JSON', async () => {
    const fetchMock = mockFetch(json({ id: '1', username: 'dan' }));
    await expect(api.me()).resolves.toEqual({ id: '1', username: 'dan' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/users/@me`);
    expect(sentHeaders(fetchMock)).toMatchObject({ Accept: 'application/json' });
  });

  it('still makes the request when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const fetchMock = mockFetch(json({ ok: true }));
    await request('/anything');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
  });

  it('defaults the files list to 25 per page', async () => {
    const fetchMock = mockFetch(json({ count: 0, items: [], size: 0, total: { count: 0, size: 0 } }));
    await api.myFiles({ query: 'cat', sort_by: '-size' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/users/@me/files?limit=25&query=cat&sort_by=-size`);
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
  it('unlock posts password + Turnstile token without the guest', async () => {
    localStorage.setItem('filesgg.guest', '123');
    const fetchMock = mockFetch(json({ token: 't', expires_at: 1, file: {} }));
    await api.unlock('album', 'v1', 'pw', 'XXXX.DUMMY.TOKEN.XXXX');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/access/unlock/albums/v1`);
    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
  });

  it('view sends the token in X-Filesgg-Access, never the query string', async () => {
    const fetchMock = mockFetch(json({ file: {}, token: 'secret-token', expires_at: 1 }));
    await api.view('file', 'abcd/xyz', 'secret-token');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API}/access/view/files/abcd/xyz`);
    expect(sentHeaders(fetchMock)['X-Filesgg-Access']).toBe('secret-token');
  });

  it('puts the vanity last in every access route, so word vanities are never read as an action (milestone-6 §20.1)', async () => {
    const fetchMock = mockFetch(async () => json({ file: {}, token: 't', expires_at: 1 }));
    await api.refreshUnlock('file', 'unlock/view', 't');
    await api.view('album', 'Ab3', 't');
    await api.openFile('report/x', 'XXXX.DUMMY.TOKEN.XXXX');
    await api.unlock('file', 'a b/c', 'pw', 'XXXX.DUMMY.TOKEN.XXXX');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${API}/access/refresh/files/unlock/view`,
      `${API}/access/view/albums/Ab3`,
      `${API}/access/open/files/report/x`,
      `${API}/access/unlock/files/a%20b/c`,
    ]);
    expect(accessPath('view', 'file', 'x/y')).toBe('/access/view/files/x/y');
    expect(openPath('abc')).toBe('/access/open/files/abc');
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
    expect(sent.url).toBe(`${API}${path}`);
    expect(sent.method ?? 'GET').toBe(method);
    expect(sent.body).toEqual(body);
  });

  it('maps an album error body to an ApiError with its details', async () => {
    mockFetch(json({ code: 'INVALID_ALBUM_FILES', message: 'nope', status: 400, file_ids: ['5'] }, { status: 400 }));
    const error = await api.addAlbumFiles('9', ['5']).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, code: 'INVALID_ALBUM_FILES', body: { file_ids: ['5'] } });
  });
});
