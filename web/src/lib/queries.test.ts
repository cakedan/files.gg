import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { stubApi } from '../test/apiStub';
import { filesResponse, ownerAlbum, ownerFile } from '../test/ownerFiles';
import { mapFilesResponse, queryKeys, reorderAlbum, restore, updateCachedFiles, useReportMessages } from './queries';

describe('optimistic cache helpers', () => {
  const files = [ownerFile({ id: '1', size: 100 }), ownerFile({ id: '2', size: 200 }), ownerFile({ id: '3', size: 300 })];

  it('mapFilesResponse drops removed items and adjusts counts and sizes', () => {
    const data = filesResponse(files, 10);
    const next = mapFilesResponse(data, (file) => (file.id === '2' ? null : file));
    expect(next.items.map((file) => file.id)).toEqual(['1', '3']);
    expect(next).toMatchObject({ count: 2, size: 400, total: { count: 9, size: 400 } });
    expect(mapFilesResponse(data, (file) => file)).toBe(data);
  });

  it('updateCachedFiles patches every cached list and restore puts them back', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.myFiles({ offset: 0 }), filesResponse(files));
    client.setQueryData(queryKeys.myFiles({ type: 'image' }), filesResponse(files.slice(1)));
    const snapshot = await updateCachedFiles(client, (file) => (file.id === '2' ? { ...file, name: 'renamed' } : file));
    for (const [, data] of client.getQueriesData<ReturnType<typeof filesResponse>>({ queryKey: queryKeys.myFilesAll })) {
      expect(data!.items.find((file) => file.id === '2')!.name).toBe('renamed');
    }
    restore(client, snapshot);
    expect(client.getQueryData<ReturnType<typeof filesResponse>>(queryKeys.myFiles({ offset: 0 }))!.items[1]!.name).toBe(files[1]!.name);
  });

  it('reorderAlbum follows the given order and renumbers positions', () => {
    const album = ownerAlbum(files);
    const next = reorderAlbum(album, ['3', '1', 'gone', '2']);
    expect(next.items.map((item) => [item.id, item.position])).toEqual([
      ['3', 0],
      ['1', 1],
      ['2', 2],
    ]);
  });
});

describe('useReportMessages (milestone-4 §11.2)', () => {
  it('refreshes the badges only when the thread changed, not on every poll', async () => {
    localStorage.setItem('filesgg.token', 'tok');
    let messages = [{ id: 'm1', author: 'staff', body: 'Hi', created_at: 1 }];
    stubApi({ 'GET /users/@me/reports/:id/messages': () => ({ items: messages }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const badgeRefreshes = () => invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKeys.badges)).length;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useReportMessages('r1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(badgeRefreshes()).toBe(1);
    // A poll with nothing new.
    await act(() => result.current.refetch());
    expect(badgeRefreshes()).toBe(1);
    // A new staff message.
    messages = [...messages, { id: 'm2', author: 'staff', body: 'Done', created_at: 2 }];
    await act(() => result.current.refetch());
    expect(badgeRefreshes()).toBe(2);
    localStorage.clear();
  });
});
