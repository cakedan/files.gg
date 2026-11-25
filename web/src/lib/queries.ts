import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  api,
  ensureFingerprint,
  type AccessParams,
  type CreateAlbumBody,
  type MyAlbumsParams,
  type MyFilesParams,
  type MyFilesResponse,
  type OwnerAlbum,
  type OwnerFile,
  type PatchAlbumBody,
  type Visibility,
} from './api';
import { signedUrlExpiry, URL_SWAP_LEAD_MS } from './signedUrls';

export const queryKeys = {
  me: ['users', '@me'] as const,
  myLimits: ['users', '@me', 'limits'] as const,
  /** Prefix of every files list, for invalidation and optimistic updates. */
  myFilesAll: ['users', '@me', 'files'] as const,
  myFiles: (params: MyFilesParams) => ['users', '@me', 'files', params] as const,
  myAlbumsAll: ['users', '@me', 'albums'] as const,
  myAlbums: (params: MyAlbumsParams) => ['users', '@me', 'albums', 'list', params] as const,
  album: (id: string) => ['users', '@me', 'albums', 'detail', id] as const,
  /** Owner passes ("Open as owner") live outside the files prefix, so list refetches keep them. */
  filePass: (id: string) => ['owner-pass', 'file', id] as const,
};

export function useMe(enabled = true) {
  return useQuery({ queryKey: queryKeys.me, queryFn: ({ signal }) => api.me(signal), enabled });
}

/** Anonymous owners (X-Fingerprint) need a fingerprint before their first call. */
async function withFingerprint<T>(call: () => Promise<T>): Promise<T> {
  await ensureFingerprint();
  return call();
}

/**
 * Owner payloads carry URLs signed for 1 h (contract §6). Lists and albums refetch
 * well before that, and on focus once they're older than this; the thumbnails on
 * screen keep their URLs until those near expiry (lib/signedUrls.ts).
 */
export const OWNER_URL_REFRESH_MS = 40 * 60 * 1000;

const ownerUrlQueryOptions = {
  refetchInterval: OWNER_URL_REFRESH_MS,
  refetchOnWindowFocus: (query: { state: { dataUpdatedAt: number } }) => Date.now() - query.state.dataUpdatedAt > OWNER_URL_REFRESH_MS,
} as const;

export function useMyFiles(params: MyFilesParams = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.myFiles(params),
    queryFn: ({ signal }) => withFingerprint(() => api.myFiles(params, signal)),
    placeholderData: keepPreviousData,
    enabled,
    ...ownerUrlQueryOptions,
  });
}

export function useMyLimits() {
  return useQuery({ queryKey: queryKeys.myLimits, queryFn: ({ signal }) => withFingerprint(() => api.myLimits(signal)) });
}

export function useMyAlbums(params: MyAlbumsParams = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.myAlbums(params),
    queryFn: ({ signal }) => withFingerprint(() => api.myAlbums(params, signal)),
    placeholderData: keepPreviousData,
    enabled,
    ...ownerUrlQueryOptions,
  });
}

export function useAlbum(id: string) {
  return useQuery({ queryKey: queryKeys.album(id), queryFn: ({ signal }) => api.album(id, signal), ...ownerUrlQueryOptions });
}

/**
 * For an image that failed to load: when its signed URL has expired (a laptop woke up
 * after an hour, say), refetch the owner lists and albums for fresh ones.
 */
export function useRefetchExpiredUrls() {
  const client = useQueryClient();
  return useCallback(
    (url: string) => {
      const expires = signedUrlExpiry(url);
      if (expires === null || expires * 1000 > Date.now() + URL_SWAP_LEAD_MS) return;
      void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll });
    },
    [client],
  );
}

/** Owner passes ("Open as owner", a `#t=` page URL) last 1 h; reuse one for 45 min. */
export const OWNER_PASS_STALE_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// Optimistic updates of every cached files list
// ---------------------------------------------------------------------------

type Snapshot = Array<[QueryKey, unknown]>;

/** Pure: applies `update` to each item of a list response, dropping the ones it maps to null. */
export function mapFilesResponse(data: MyFilesResponse, update: (file: OwnerFile) => OwnerFile | null): MyFilesResponse {
  let removedCount = 0;
  let removedSize = 0;
  const items: OwnerFile[] = [];
  for (const file of data.items) {
    const next = update(file);
    if (next) items.push(next);
    else {
      removedCount++;
      removedSize += file.size;
    }
  }
  if (removedCount === 0 && items.every((item, i) => item === data.items[i])) return data;
  return {
    ...data,
    items,
    count: Math.max(0, data.count - removedCount),
    size: Math.max(0, data.size - removedSize),
    total: { count: Math.max(0, data.total.count - removedCount), size: Math.max(0, data.total.size - removedSize) },
  };
}

/** Cancels in-flight list fetches, snapshots every list, and applies `update` to each. */
export async function updateCachedFiles(
  client: QueryClient,
  update: (file: OwnerFile) => OwnerFile | null,
): Promise<Snapshot> {
  await client.cancelQueries({ queryKey: queryKeys.myFilesAll });
  const snapshot = client.getQueriesData({ queryKey: queryKeys.myFilesAll });
  for (const [key, data] of snapshot) {
    if (isFilesResponse(data)) client.setQueryData(key, mapFilesResponse(data, update));
  }
  return snapshot;
}

/** Replaces cached copies of these files with the server's versions. */
export function replaceCachedFiles(client: QueryClient, files: OwnerFile[]): void {
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const [key, data] of client.getQueriesData({ queryKey: queryKeys.myFilesAll })) {
    if (isFilesResponse(data)) client.setQueryData(key, mapFilesResponse(data, (file) => byId.get(file.id) ?? file));
  }
}

export function restore(client: QueryClient, snapshot: Snapshot | undefined): void {
  for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

const isFilesResponse = (data: unknown): data is MyFilesResponse =>
  typeof data === 'object' && data !== null && Array.isArray((data as MyFilesResponse).items) && 'total' in data;

const expiresAtFrom = (expiresIn: number | null, nowMs = Date.now()) =>
  expiresIn === null ? null : Math.floor(nowMs / 1000) + expiresIn;

// ---------------------------------------------------------------------------
// File mutations: optimistic, rolled back on error, refetched when settled
// ---------------------------------------------------------------------------

function useSettle() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
    void client.invalidateQueries({ queryKey: queryKeys.myLimits });
  };
}

export function useDeleteFiles() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 1) {
        await api.deleteFile(ids[0]!);
        return ids;
      }
      const deleted: string[] = [];
      for (let i = 0; i < ids.length; i += 100) deleted.push(...(await api.deleteFiles(ids.slice(i, i + 100))).deleted);
      return deleted;
    },
    onMutate: async (ids) => {
      const gone = new Set(ids);
      return { snapshot: await updateCachedFiles(client, (file) => (gone.has(file.id) ? null : file)) };
    },
    onError: (_error, _ids, context) => restore(client, context?.snapshot),
    onSettled: () => {
      settle();
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll });
    },
  });
}

export function useRenameFile() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateFile(id, { filename: name }),
    onMutate: async ({ id, name }) => ({
      snapshot: await updateCachedFiles(client, (file) =>
        file.id === id ? { ...file, name, filename: file.extension ? `${name}.${file.extension}` : name } : file,
      ),
    }),
    onSuccess: (file) => replaceCachedFiles(client, [file]),
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: settle,
  });
}

export function useSetExpiry() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ ids, expiresIn }: { ids: string[]; expiresIn: number | null }) => api.setFilesExpiry(ids, expiresIn),
    onMutate: async ({ ids, expiresIn }) => {
      const set = new Set(ids);
      const expires_at = expiresAtFrom(expiresIn);
      return {
        snapshot: await updateCachedFiles(client, (file) =>
          set.has(file.id) ? { ...file, expires_at } : file,
        ),
      };
    },
    onSuccess: ({ items }) => replaceCachedFiles(client, items),
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: settle,
  });
}

export interface AccessTarget {
  kind: 'file' | 'files' | 'album';
  ids: string[];
}

export interface AccessResult {
  password?: string | undefined;
  /** Updated files (file and bulk targets). */
  files?: OwnerFile[];
  album?: OwnerAlbum;
}

/** Change access for one file (`PATCH`), several (`POST …/files/access`) or an album (`PATCH`). */
export function useSetAccess() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: async ({ target, body }: { target: AccessTarget; body: AccessParams & { visibility: Visibility } }): Promise<AccessResult> => {
      if (target.kind === 'album') {
        const album = await api.updateAlbum(target.ids[0]!, body);
        return { album, password: album.password };
      }
      if (target.kind === 'file') {
        const file = await api.updateFile(target.ids[0]!, body);
        return { files: [file], password: file.password };
      }
      // The bulk endpoint can't clear a password expiry (contract §6 lists only `password_expires_in`).
      const { password_expires_at: _unused, ...bulk } = body;
      const { items, password } = await api.setFilesAccess(target.ids, bulk);
      return { files: items, password };
    },
    onMutate: async ({ target, body }) => {
      if (target.kind === 'album') return { snapshot: undefined };
      const set = new Set(target.ids);
      return {
        snapshot: await updateCachedFiles(client, (file) => (set.has(file.id) ? { ...file, visibility: body.visibility } : file)),
      };
    },
    onSuccess: (result, { target }) => {
      if (result.files) replaceCachedFiles(client, result.files);
      // A new access_version revokes owner passes: "Open as owner" mints a new one.
      for (const id of target.kind === 'album' ? [] : target.ids) void client.invalidateQueries({ queryKey: queryKeys.filePass(id) });
      if (result.album) client.setQueryData(queryKeys.album(result.album.id), stripPassword(result.album));
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { target }) => {
      settle();
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll, refetchType: target.kind === 'album' ? 'active' : 'none' });
    },
  });
}

/** Never keep a generated password in the query cache. */
function stripPassword<T extends object>(value: T): T {
  const { password: _p, url_with_password: _u, ...rest } = value as T & { password?: string; url_with_password?: string };
  return rest as T;
}

/** "Add to album…": an existing album (append) or a new one. */
export function useAddToAlbum() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, albumId, newAlbum }: { ids: string[]; albumId?: string; newAlbum?: Omit<CreateAlbumBody, 'file_ids'> }) =>
      albumId ? api.addAlbumFiles(albumId, ids) : api.createAlbum({ ...newAlbum, file_ids: ids }),
    onSuccess: (album) => client.setQueryData(queryKeys.album(album.id), album),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll });
      void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
    },
  });
}

// ---------------------------------------------------------------------------
// Album mutations (detail cache updated optimistically)
// ---------------------------------------------------------------------------

/** Pure: the album with items in `order` (unknown ids dropped) and positions renumbered. */
export function reorderAlbum(album: OwnerAlbum, order: string[]): OwnerAlbum {
  const byId = new Map(album.items.map((item) => [item.id, item]));
  const items = order
    .flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    })
    .map((item, position) => ({ ...item, position }));
  return { ...album, items };
}

function useAlbumMutation<V>(id: string, mutationFn: (vars: V) => Promise<OwnerAlbum>, optimistic?: (album: OwnerAlbum, vars: V) => OwnerAlbum) {
  const client = useQueryClient();
  const key = queryKeys.album(id);
  return useMutation({
    mutationFn,
    onMutate: async (vars: V) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<OwnerAlbum>(key);
      if (previous && optimistic) client.setQueryData(key, optimistic(previous, vars));
      return { previous };
    },
    onSuccess: (album) => client.setQueryData(key, stripPassword(album)),
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll, refetchType: 'none' }),
  });
}

export function useUpdateAlbum(id: string) {
  return useAlbumMutation(id, (body: PatchAlbumBody) => api.updateAlbum(id, body), (album, body) => ({
    ...album,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.layout !== undefined ? { layout: body.layout } : {}),
    ...(body.cover_file_id !== undefined ? { cover_file_id: body.cover_file_id } : {}),
  }));
}

export function useSetCaption(id: string) {
  return useAlbumMutation(
    id,
    ({ fileId, caption }: { fileId: string; caption: string }) => api.setAlbumCaption(id, fileId, caption),
    (album, { fileId, caption }) => ({ ...album, items: album.items.map((item) => (item.id === fileId ? { ...item, caption } : item)) }),
  );
}

export function useRemoveAlbumItem(id: string) {
  return useAlbumMutation(
    id,
    (fileId: string) => api.removeAlbumFile(id, fileId),
    (album, fileId) => reorderAlbum(album, album.items.filter((item) => item.id !== fileId).map((item) => item.id)),
  );
}

export function useAddAlbumItems(id: string) {
  return useAlbumMutation(id, (ids: string[]) => api.addAlbumFiles(id, ids));
}

export function useDeleteAlbum() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteFiles }: { id: string; deleteFiles: boolean }) => api.deleteAlbum(id, deleteFiles),
    onSuccess: (_data, { id }) => client.removeQueries({ queryKey: queryKeys.album(id) }),
    onSettled: (_data, _error, { deleteFiles }) => {
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll });
      if (deleteFiles) {
        void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
        void client.invalidateQueries({ queryKey: queryKeys.myLimits });
      }
    },
  });
}

export function useCreateAlbum() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAlbumBody) => withFingerprint(() => api.createAlbum(body)),
    onSuccess: (album) => client.setQueryData(queryKeys.album(album.id), album),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll }),
  });
}
