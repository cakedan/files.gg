import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signedInState } from './api';
import { broadcastSessionChange, loginPath, safeNext, SESSION_CHANNEL, SESSION_CHANGED, SESSION_QUERY_KEY, useCompleteSignIn, useSession, useSessionSync } from './session';

afterEach(() => localStorage.clear());

describe('next (milestone-6 §6.1)', () => {
  it.each([
    ['/app/files', '/files'],
    ['/app', '/'],
    ['/app/settings/security?x=1', '/settings/security?x=1'],
    ['//evil.example/app', null],
    ['/app//evil.example', null],
    ['https://evil.example/app/x', null],
    ['/files', null],
    ['/application', null],
    ['/app/\\evil', null],
    [null, null],
  ])('%s → %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });

  it('links to sign in with the page as next', () => {
    expect(loginPath('/files?page=2')).toBe('/login?next=%2Fapp%2Ffiles%3Fpage%3D2');
    expect(loginPath('/')).toBe('/login');
  });
});

const wrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);

describe('session (milestone-6 §13.1)', () => {
  it('useSession reads GET /api/auth/session, stale after 60 s', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { id: '1', username: 'a' } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient();
    const { result } = renderHook(() => useSession(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toMatchObject({ id: '1' }));
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${window.location.origin}/api/auth/session`);
    expect(client.getQueryCache().find({ queryKey: SESSION_QUERY_KEY })?.options).toMatchObject({ staleTime: 60_000, refetchOnWindowFocus: true });
    expect(signedInState()).toBe(true);
  });

  it('after a sign-in, drops the guest and the old account’s cache, and tells other tabs', async () => {
    localStorage.setItem('filesgg.guest', '123');
    const client = new QueryClient();
    client.setQueryData(['users', '@me', 'files', {}], { items: ['old'] });
    const listener = new BroadcastChannel(SESSION_CHANNEL);
    const received = new Promise((resolve) => (listener.onmessage = (event) => resolve(event.data)));
    const { result } = renderHook(() => useCompleteSignIn(), { wrapper: wrapper(client) });
    act(() => result.current({ id: '9', username: 'b' } as never));
    expect(localStorage.getItem('filesgg.guest')).toBeNull();
    expect(client.getQueryData(['users', '@me', 'files', {}])).toBeUndefined();
    expect(client.getQueryData(SESSION_QUERY_KEY)).toMatchObject({ id: '9' });
    await expect(received).resolves.toBe(SESSION_CHANGED);
    listener.close();
  });

  it('refetches the session when another tab says it changed, and clears the cache for a different account', async () => {
    let user: unknown = { id: '1' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user }))));
    const client = new QueryClient();
    client.setQueryData(SESSION_QUERY_KEY, { id: '1' });
    client.setQueryData(['users', '@me', 'files', {}], { items: [] });
    renderHook(() => useSessionSync(), { wrapper: wrapper(client) });
    user = null;
    broadcastSessionChange();
    await waitFor(() => expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull());
    await waitFor(() => expect(client.getQueryData(['users', '@me', 'files', {}])).toBeUndefined());
  });
});
