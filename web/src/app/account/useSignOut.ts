import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import { accountApi } from '../../lib/accountApi';
import { signedOut } from '../../lib/session';

/** §13.1: `POST /api/auth/logout`, broadcast, clear the cache, go to `/app`. Signing out never fails. */
export function useSignOut() {
  const client = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    try {
      await accountApi.logout();
    } catch {
      // Logging out is idempotent; the cookie may already be gone.
    }
    signedOut(client);
    navigate('/', { replace: true, state: { toast: 'You’re signed out.' } });
  }, [client, navigate]);
}
