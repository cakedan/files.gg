import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  api,
  ensureGuest,
  type AccessParams,
  type AppealBody,
  type CreateAlbumBody,
  type MyReportsParams,
  type Notice,
  type NoticesParams,
  type Report,
  type ReportMessage,
  type MyAlbumsParams,
  type MyFilesParams,
  type MyFilesResponse,
  type OwnerAlbum,
  type OwnerFile,
  type PatchAlbumBody,
  type ViewLimitAction,
  type Visibility,
} from './api';
import { useSession } from './session';
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
  /** Milestone 6 §10.9: an owner pass on one of your custom domains (under `filePass(id)`, so it's revoked with it). */
  filePassOn: (id: string, domainId: string) => ['owner-pass', 'file', id, 'domain', domainId] as const,
  /** One owner file (`GET /users/@me/files/<id>`), polled while its scan is pending. */
  myFile: (id: string) => ['users', '@me', 'file', id] as const,
  badges: ['users', '@me', 'badges'] as const,
  myReportsAll: ['users', '@me', 'reports'] as const,
  myReports: (params: MyReportsParams) => ['users', '@me', 'reports', 'list', params] as const,
  myReport: (id: string) => ['users', '@me', 'reports', 'detail', id] as const,
  reportMessages: (id: string) => ['users', '@me', 'reports', 'messages', id] as const,
  noticesAll: ['users', '@me', 'warnings'] as const,
  notices: (params: NoticesParams) => ['users', '@me', 'warnings', params] as const,
};

/**
 * The signed-in user (milestone-6 §13.1): the same query as `useSession()`, so `data` is
 * the user, or `null` signed out. The argument is ignored (it used to gate a token check).
 */
export function useMe(_enabled?: boolean) {
  return useSession();
}

/** True once the session says someone is signed in. */
export function useSignedIn(): boolean {
  return Boolean(useSession().data);
}

/** Anonymous owners (`Authorization: Guest`) need a guest token before their first call. */
async function withGuest<T>(call: () => Promise<T>): Promise<T> {
  await ensureGuest();
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
    queryFn: ({ signal }) => withGuest(() => api.myFiles(params, signal)),
    placeholderData: keepPreviousData,
    enabled,
    ...ownerUrlQueryOptions,
  });
}

export function useMyLimits(enabled = true) {
  return useQuery({ queryKey: queryKeys.myLimits, queryFn: ({ signal }) => withGuest(() => api.myLimits(signal)), enabled });
}

export function useMyAlbums(params: MyAlbumsParams = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.myAlbums(params),
    queryFn: ({ signal }) => withGuest(() => api.myAlbums(params, signal)),
    placeholderData: keepPreviousData,
    enabled,
    ...ownerUrlQueryOptions,
  });
}

/** While an item's scan is pending (milestone-4 §11.2), the album is refetched every 5 s. */
export const ALBUM_PENDING_POLL_MS = 5_000;

export function useAlbum(id: string) {
  return useQuery({
    queryKey: queryKeys.album(id),
    queryFn: ({ signal }) => api.album(id, signal),
    ...ownerUrlQueryOptions,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.safety?.state === 'pending') ? ALBUM_PENDING_POLL_MS : OWNER_URL_REFRESH_MS,
  });
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

export interface ViewLimitChange {
  id: string;
  /** 1–1000, or null to remove the limit. */
  limit: number | null;
  action?: ViewLimitAction;
  /** After a `private` action fired: share it with the link again (§19.3). */
  visibility?: Visibility;
}

/**
 * Milestone 6 §19.3: set, change or remove a file's view limit (`PATCH`). Not optimistic:
 * a limit at or below `views_used` is refused (`400 VIEW_LIMIT_TOO_LOW { views_used }`).
 */
export function useSetViewLimit() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ id, limit, action, visibility }: ViewLimitChange) =>
      api.updateFile(id, {
        view_limit: limit,
        ...(limit !== null && action ? { view_limit_action: action } : {}),
        ...(visibility ? { visibility } : {}),
      }),
    onSuccess: (file, { id, visibility }) => {
      replaceCachedFiles(client, [file]);
      // A visibility change bumps access_version, which revokes owner passes.
      if (visibility) void client.invalidateQueries({ queryKey: queryKeys.filePass(id) });
    },
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
    ...(body.nsfw !== undefined ? { nsfw_marked: body.nsfw, nsfw: body.nsfw || album.items.some((item) => item.shown && item.nsfw) } : {}),
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
    mutationFn: (body: CreateAlbumBody) => withGuest(() => api.createAlbum(body)),
    onSuccess: (album) => client.setQueryData(queryKeys.album(album.id), album),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll }),
  });
}

// ---------------------------------------------------------------------------
// Milestone 4: badges, My reports, notices and NSFW (milestone-4 §6–§8, §11.2)
// ---------------------------------------------------------------------------

/** Badges are fetched on load, every 60 s while the page is visible, and on focus (§11.2). */
export const BADGES_REFRESH_MS = 60_000;

export function useBadges(enabled?: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.badges,
    queryFn: ({ signal }) => api.badges(signal),
    enabled: (enabled ?? true) && signedIn,
    staleTime: 5_000,
    refetchInterval: BADGES_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useMyReports(params: MyReportsParams, enabled = true) {
  return useQuery({
    queryKey: queryKeys.myReports(params),
    queryFn: ({ signal }) => api.myReports(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMyReport(id: string) {
  return useQuery({ queryKey: queryKeys.myReport(id), queryFn: ({ signal }) => api.myReport(id, signal) });
}

/** The thread changed since it was last read: a new count or a new last message. */
const threadChanged = (before: { items: ReportMessage[] } | undefined, after: { items: ReportMessage[] }) =>
  !before || before.items.length !== after.items.length || before.items.at(-1)?.id !== after.items.at(-1)?.id;

/**
 * Reading the thread marks the report read, so the unread counts refresh after it:
 * only when there was something new to read, since the badges poll on their own.
 */
export function useReportMessages(id: string, enabled = true) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.reportMessages(id),
    queryFn: async ({ signal }) => {
      const result = await api.reportMessages(id, signal);
      const before = client.getQueryData<{ items: ReportMessage[] }>(queryKeys.reportMessages(id));
      if (threadChanged(before, result)) void client.invalidateQueries({ queryKey: queryKeys.badges });
      markReportRead(client, id);
      return result;
    },
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/** Zeroes a report's `unread` in every cached list and its detail. */
function markReportRead(client: QueryClient, id: string) {
  const read = (report: Report) => (report.id === id && report.unread ? { ...report, unread: 0 } : report);
  client.setQueryData<Report>(queryKeys.myReport(id), (report) => (report ? read(report) : report));
  for (const [key, data] of client.getQueriesData<{ count: number; items: Report[] }>({ queryKey: [...queryKeys.myReportsAll, 'list'] })) {
    if (data?.items) client.setQueryData(key, { ...data, items: data.items.map(read) });
  }
}

export function useSendReportMessage(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.sendReportMessage(id, body),
    onSuccess: (message) =>
      client.setQueryData<{ items: (typeof message)[] }>(queryKeys.reportMessages(id), (data) => ({ items: [...(data?.items ?? []), message] })),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.myReport(id) });
      void client.invalidateQueries({ queryKey: [...queryKeys.myReportsAll, 'list'], refetchType: 'none' });
    },
  });
}

export function useReopenReport(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.reopenReport(id),
    onSuccess: (report) => client.setQueryData(queryKeys.myReport(id), report),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [...queryKeys.myReportsAll, 'list'] });
      void client.invalidateQueries({ queryKey: queryKeys.reportMessages(id) });
    },
  });
}

export function useNotices(params: NoticesParams = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.notices(params),
    queryFn: ({ signal }) => api.notices(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

function patchCachedNotices(client: QueryClient, update: (notice: Notice) => Notice) {
  for (const [key, data] of client.getQueriesData<{ items: Notice[]; unacknowledged: number }>({ queryKey: queryKeys.noticesAll })) {
    if (!data?.items) continue;
    const items = data.items.map(update);
    const newlyAcknowledged = items.filter((notice, i) => notice.acknowledged_at !== null && data.items[i]!.acknowledged_at === null).length;
    client.setQueryData(key, { ...data, items, unacknowledged: Math.max(0, data.unacknowledged - newlyAcknowledged) });
  }
}

export function useAcknowledgeNotices() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.acknowledgeNotices(ids),
    onSuccess: ({ acknowledged }) => {
      const done = new Set(acknowledged);
      const at = Math.floor(Date.now() / 1000);
      patchCachedNotices(client, (notice) => (done.has(notice.id) && notice.acknowledged_at === null ? { ...notice, acknowledged_at: at } : notice));
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.badges });
      void client.invalidateQueries({ queryKey: queryKeys.noticesAll });
    },
  });
}

export function useAppealNotice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AppealBody }) => api.appealNotice(id, body),
    onSuccess: (updated) => patchCachedNotices(client, (notice) => (notice.id === updated.id ? updated : notice)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.noticesAll });
      void client.invalidateQueries({ queryKey: queryKeys.badges });
    },
  });
}

/** Mark or unmark as sensitive: one file (`PATCH`) or several (`POST …/files/nsfw`), optimistic. */
export function useSetNsfw() {
  const client = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: async ({ ids, nsfw }: { ids: string[]; nsfw: boolean }): Promise<{ items: OwnerFile[]; skipped: string[] }> => {
      if (ids.length === 1) return { items: [await api.setFileNsfw(ids[0]!, nsfw)], skipped: [] };
      const items: OwnerFile[] = [];
      const skipped: string[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const result = await api.setFilesNsfw(ids.slice(i, i + 100), nsfw);
        items.push(...result.items);
        skipped.push(...result.skipped);
      }
      return { items, skipped };
    },
    onMutate: async ({ ids, nsfw }) => {
      const set = new Set(ids);
      return {
        snapshot: await updateCachedFiles(client, (file) => {
          if (!set.has(file.id)) return file;
          if (nsfw) return { ...file, nsfw: true };
          // Only the uploader's own mark can be taken back (§4.5); the server answers the rest.
          return file.safety?.nsfw_locked || file.safety?.nsfw_source !== 'uploader' ? file : { ...file, nsfw: false };
        }),
      };
    },
    onSuccess: ({ items }) => replaceCachedFiles(client, items),
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: () => {
      settle();
      void client.invalidateQueries({ queryKey: queryKeys.myAlbumsAll, refetchType: 'none' });
    },
  });
}

export function useRequestNsfwReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, message }: { id: string; message?: string }) => api.requestNsfwReview(id, message),
    onSuccess: (_data, { id }) =>
      void updateCachedFiles(client, (file) => (file.id === id && file.safety ? { ...file, safety: { ...file.safety, nsfw_review: 'open' } } : file)),
    onSettled: () => void client.invalidateQueries({ queryKey: queryKeys.myFilesAll }),
  });
}
