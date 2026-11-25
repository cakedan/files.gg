import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveAccess } from '../../lib/access';
import { resetHostContext } from '../host/context';
import { enterCustomHost } from '../host/testing';
import { accessHeaders, checkSignedIn } from './send';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  resetHostContext();
  localStorage.clear();
});

describe('checkSignedIn (milestone-6 §13.1)', () => {
  it('reads GET /auth/session: a user is signed in, null is not', async () => {
    const fetch = vi.fn(async () => json({ user: { id: '1', username: 'dan.w' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(checkSignedIn()).resolves.toBe(true);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toMatch(/\/auth\/session$/);
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: null })));
    await expect(checkSignedIn()).resolves.toBe(false);
  });

  it('never throws: a failure counts as signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(checkSignedIn()).resolves.toBe(false);
  });

  it('a custom domain is never signed in and asks nothing', async () => {
    enterCustomHost();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(checkSignedIn()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('accessHeaders', () => {
  it('sends the album\'s unlock token for one of its items, on files.gg or a custom domain', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    saveAccess('album', 'Ab3', { token: 'album-token', expires_at: future });
    expect(accessHeaders({ target: { type: 'url', url: 'https://files.gg/a/Ab3?item=2' } })).toEqual({ 'X-Filesgg-Access': 'album-token' });
    expect(accessHeaders({ target: { type: 'url', url: 'https://i.example.com/a/Ab3?item=2' } })).toEqual({ 'X-Filesgg-Access': 'album-token' });
    expect(accessHeaders({ target: { type: 'url', url: 'https://files.gg/a/Ab3' } })).toBeUndefined();
    expect(accessHeaders({ target: { type: 'url', url: 'https://files.gg/a/Ab3/2' } })).toBeUndefined();
    expect(accessHeaders({ target: { type: 'url', url: 'https://files.gg/a/Other?item=2' } })).toBeUndefined();
    expect(accessHeaders({ target: { type: 'domain', hostname: 'i.example.com' } })).toBeUndefined();
  });
});
