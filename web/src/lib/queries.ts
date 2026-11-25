import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, type MyFilesParams } from './api';

export const queryKeys = {
  me: ['users', '@me'] as const,
  myFiles: (params: MyFilesParams) => ['users', '@me', 'files', params] as const,
  myLimits: ['users', '@me', 'limits'] as const,
};

export function useMe(enabled = true) {
  return useQuery({ queryKey: queryKeys.me, queryFn: ({ signal }) => api.me(signal), enabled });
}

export function useMyFiles(params: MyFilesParams = {}) {
  return useQuery({
    queryKey: queryKeys.myFiles(params),
    queryFn: ({ signal }) => api.myFiles(params, signal),
    placeholderData: keepPreviousData,
  });
}

export function useMyLimits() {
  return useQuery({ queryKey: queryKeys.myLimits, queryFn: ({ signal }) => api.myLimits(signal) });
}
