import { createElement, useCallback, useState, type ReactNode } from 'react';

import { ApiError } from '../../lib/api';
import { ReauthCancelled, reauthMethods, type ReauthMethod } from './reauth';
import { ReauthDialog } from './ReauthDialog';

export { isReauthCancelled, type ReauthMethod } from './reauth';

interface Pending {
  methods: ReauthMethod[];
  title: string;
  confirm: () => void;
  cancel: () => void;
}

/**
 * Re-authentication (milestone-6 §3.5, §13.3): wraps an action; on `403 REAUTH_REQUIRED`
 * it opens the shared dialog (the password, or Continue with Discord) and retries the
 * action once it's confirmed. Render `dialog` somewhere in the page.
 */
export function useReauth() {
  const [pending, setPending] = useState<Pending | null>(null);

  /** Asks first, whatever the session's freshness (account deletion, §13.3). */
  const confirmIdentity = useCallback(
    (methods: ReauthMethod[], title = 'Confirm it’s you') =>
      new Promise<void>((resolve, reject) => {
        setPending({
          methods,
          title,
          confirm: () => {
            setPending(null);
            resolve();
          },
          cancel: () => {
            setPending(null);
            reject(new ReauthCancelled());
          },
        });
      }),
    [],
  );

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'REAUTH_REQUIRED') throw error;
        await confirmIdentity(reauthMethods(error));
        return action();
      }
    },
    [confirmIdentity],
  );

  const dialog: ReactNode = pending ? createElement(ReauthDialog, { methods: pending.methods, title: pending.title, onConfirmed: pending.confirm, onCancel: pending.cancel }) : null;
  return { run, confirmIdentity, dialog };
}
