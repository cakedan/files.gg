import { useQuery } from '@tanstack/react-query';

import { accountApi, type DomainStatus } from '../../lib/accountApi';

export const accountKeys = {
  sessions: ['users', '@me', 'sessions'] as const,
  exports: ['users', '@me', 'exports'] as const,
  uploadKeys: ['users', '@me', 'upload-keys'] as const,
  domains: ['users', '@me', 'domains'] as const,
};

/** An export is polled every 5 s while it's being made. */
export const EXPORT_POLL_MS = 5_000;
/** §13.4: domains are polled every 10 s while one is pending and the page is visible. */
export const DOMAIN_POLL_MS = 10_000;

export const PENDING_DOMAIN: ReadonlySet<DomainStatus> = new Set(['pending_dns', 'pending_cert']);

export const useAccountSessions = () =>
  useQuery({ queryKey: accountKeys.sessions, queryFn: ({ signal }) => accountApi.sessions(signal), refetchOnWindowFocus: true });

export function useExports(enabled = true) {
  return useQuery({
    queryKey: accountKeys.exports,
    queryFn: ({ signal }) => accountApi.exports(signal),
    enabled,
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.status === 'queued' || item.status === 'running') ? EXPORT_POLL_MS : false),
  });
}

export const useUploadKeys = (enabled = true) => useQuery({ queryKey: accountKeys.uploadKeys, queryFn: ({ signal }) => accountApi.uploadKeys(signal), enabled });

export function useDomains(enabled = true) {
  return useQuery({
    queryKey: accountKeys.domains,
    queryFn: ({ signal }) => accountApi.domains(signal),
    enabled,
    refetchInterval: (query) => (query.state.data?.items.some((domain) => PENDING_DOMAIN.has(domain.status)) ? DOMAIN_POLL_MS : false),
    refetchIntervalInBackground: false,
  });
}
