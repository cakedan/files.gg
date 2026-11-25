import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { filesResponse, ownerAlbum, ownerFile } from '../test/ownerFiles';
import { mapFilesResponse, queryKeys, reorderAlbum, restore, updateCachedFiles } from './queries';

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
