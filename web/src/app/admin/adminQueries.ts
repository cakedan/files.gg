import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../../lib/queries';
import { adminApi, type ActionBody, type AdminDomainsParams, type AuditParams, type BanBody, type CaseDetail, type CasesParams, type RescanBody } from './adminApi';

/** §11.3: `GET /admin/summary` is polled every 30 s while any admin page is open. */
export const SUMMARY_POLL_MS = 30_000;

export const adminKeys = {
  all: ['admin'] as const,
  summary: ['admin', 'summary'] as const,
  cases: (params: CasesParams) => ['admin', 'cases', params] as const,
  case: (id: string) => ['admin', 'case', id] as const,
  file: (id: string) => ['admin', 'file', id] as const,
  album: (id: string) => ['admin', 'album', id] as const,
  user: (id: string) => ['admin', 'user', id] as const,
  domain: (id: string) => ['admin', 'domain', id] as const,
  domains: (params: AdminDomainsParams) => ['admin', 'domains', params] as const,
  lookup: (q: string) => ['admin', 'lookup', q] as const,
  bans: (active: boolean) => ['admin', 'bans', active] as const,
  audit: (params: AuditParams) => ['admin', 'audit', params] as const,
  staff: ['admin', 'staff'] as const,
};

export function useAdminSummary() {
  return useQuery({
    queryKey: adminKeys.summary,
    queryFn: ({ signal }) => adminApi.summary(signal),
    refetchInterval: SUMMARY_POLL_MS,
    // Notifications are for when the tab is in the background (§11.3).
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  });
}

export function useCases(params: CasesParams) {
  return useInfiniteQuery({
    queryKey: adminKeys.cases(params),
    queryFn: ({ pageParam, signal }) => adminApi.cases({ ...params, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    // An interval refetch re-requests every loaded page, so the queue polls only while
    // just its first page is loaded; after "Load more" it refreshes on focus and after actions.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) <= 1 ? SUMMARY_POLL_MS : false),
    staleTime: 5_000,
  });
}

export function useCase(id: string) {
  return useQuery({ queryKey: adminKeys.case(id), queryFn: ({ signal }) => adminApi.case(id, signal), staleTime: 5_000 });
}

export const useAdminFile = (id: string) => useQuery({ queryKey: adminKeys.file(id), queryFn: ({ signal }) => adminApi.file(id, signal) });
export const useAdminAlbum = (id: string) => useQuery({ queryKey: adminKeys.album(id), queryFn: ({ signal }) => adminApi.album(id, signal) });
export const useAdminUser = (id: string) => useQuery({ queryKey: adminKeys.user(id), queryFn: ({ signal }) => adminApi.user(id, signal) });
export const useAdminDomain = (id: string) => useQuery({ queryKey: adminKeys.domain(id), queryFn: ({ signal }) => adminApi.domain(id, signal) });

/** `/app/admin/domains` (§10.12): filtered by hostname and status, newest first. */
export function useAdminDomains(params: AdminDomainsParams) {
  return useInfiniteQuery({
    queryKey: adminKeys.domains(params),
    queryFn: ({ pageParam, signal }) => adminApi.domains({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
}

export function useLookup(q: string) {
  return useQuery({ queryKey: adminKeys.lookup(q), queryFn: ({ signal }) => adminApi.lookup(q, signal), enabled: q.trim().length > 0 });
}

export function useBans(active = true) {
  return useInfiniteQuery({
    queryKey: adminKeys.bans(active),
    queryFn: ({ pageParam, signal }) => adminApi.bans({ active, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
}

export function useAudit(params: AuditParams, enabled = true) {
  return useInfiniteQuery({
    queryKey: adminKeys.audit(params),
    queryFn: ({ pageParam, signal }) => adminApi.audit({ ...params, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled,
  });
}

export const useStaffList = (enabled: boolean) => useQuery({ queryKey: adminKeys.staff, queryFn: ({ signal }) => adminApi.staff(signal), enabled });

/** Everything staff do can change any admin view and the sidebar badge. */
function useAdminSettle() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: adminKeys.all });
    void client.invalidateQueries({ queryKey: queryKeys.badges });
  };
}

/** A case mutation that writes the returned case into the cache. */
function useCaseMutation<V>(id: string, mutationFn: (vars: V) => Promise<CaseDetail>) {
  const client = useQueryClient();
  const settle = useAdminSettle();
  return useMutation({
    mutationFn,
    onSuccess: (detail) => client.setQueryData(adminKeys.case(id), detail),
    onSettled: settle,
  });
}

export const useClaim = (id: string) => useCaseMutation(id, (force: boolean) => adminApi.claim(id, force));
export const useRelease = (id: string) => useCaseMutation(id, () => adminApi.release(id));
export const useCloseCase = (id: string) => useCaseMutation(id, (body: Parameters<typeof adminApi.close>[1]) => adminApi.close(id, body));
export const useDecideAppeal = (id: string) => useCaseMutation(id, (body: Parameters<typeof adminApi.decideAppeal>[1]) => adminApi.decideAppeal(id, body));
export const useCybertip = (id: string) => useCaseMutation(id, (reportId: string) => adminApi.cybertip(id, reportId));
export const useSecondReview = (id: string) => useCaseMutation(id, (value: boolean) => adminApi.updateCase(id, { needs_second_review: value }));

export function useCaseMessage(caseId: string) {
  const settle = useAdminSettle();
  return useMutation({ mutationFn: ({ reportId, body }: { reportId: string; body: string }) => adminApi.message(caseId, reportId, body), onSettled: settle });
}

/** A claim from the queue, by case id. */
export function useQueueClaim() {
  const settle = useAdminSettle();
  return useMutation({
    mutationFn: ({ id, release, force = false }: { id: string; release: boolean; force?: boolean }) => (release ? adminApi.release(id) : adminApi.claim(id, force)),
    onSettled: settle,
  });
}

export function useAdminAction() {
  const settle = useAdminSettle();
  return useMutation({ mutationFn: (body: ActionBody) => adminApi.action(body), onSettled: settle });
}

export function useCreateBan() {
  const settle = useAdminSettle();
  return useMutation({ mutationFn: (body: BanBody) => adminApi.createBan(body), onSettled: settle });
}

export function useLiftBan() {
  const settle = useAdminSettle();
  return useMutation({ mutationFn: (id: string) => adminApi.liftBan(id), onSettled: settle });
}

export function useRescans() {
  const settle = useAdminSettle();
  return useMutation({ mutationFn: (body: RescanBody) => adminApi.rescans(body), onSettled: settle });
}

/** Premium (milestone-6 §9.3): grant, change the expiry, revoke. Admin only; each needs a note. */
export type PremiumChange =
  | { type: 'grant'; expires_at: number | null; note: string }
  | { type: 'change'; id: string; expires_at: number | null; note: string }
  | { type: 'revoke'; id: string; note: string };

export function usePremiumChange(userId: string) {
  const settle = useAdminSettle();
  return useMutation({
    mutationFn: (change: PremiumChange) =>
      change.type === 'grant'
        ? adminApi.grantPremium(userId, change.expires_at === null ? { note: change.note } : { expires_at: change.expires_at, note: change.note })
        : change.type === 'change'
          ? adminApi.changeEntitlement(userId, change.id, { expires_at: change.expires_at, note: change.note })
          : adminApi.revokeEntitlement(userId, change.id, change.note),
    onSettled: settle,
  });
}
