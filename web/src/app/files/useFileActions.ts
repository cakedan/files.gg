import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api, type OwnerFile } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { OWNER_PASS_STALE_MS, queryKeys } from '../../lib/queries';
import { useToast } from '../components/toastContext';

/** Copy link, Open, and "Open as owner" (mints an owner pass and opens its URL). */
export function useFileActions() {
  const client = useQueryClient();
  const notify = useToast();

  const copyLink = useCallback(
    async (file: Pick<OwnerFile, 'url'>) => {
      notify((await copyText(file.url)) ? 'Link copied.' : "Couldn't copy the link.", 'success');
    },
    [notify],
  );

  const open = useCallback((file: Pick<OwnerFile, 'url'>) => {
    window.open(file.url, '_blank', 'noopener');
  }, []);

  const openAsOwner = useCallback(
    async (file: Pick<OwnerFile, 'id'>) => {
      // Open the tab now, in the click, so pop-up blockers allow it; navigate once the pass is minted.
      const tab = window.open('about:blank', '_blank');
      if (tab) tab.opener = null;
      try {
        const pass = await client.fetchQuery({
          queryKey: queryKeys.filePass(file.id),
          queryFn: () => api.filePass(file.id),
          staleTime: OWNER_PASS_STALE_MS,
        });
        if (tab) tab.location.href = pass.url;
        else window.location.assign(pass.url);
      } catch (error) {
        tab?.close();
        notify(errorMessage(error), 'error');
      }
    },
    [client, notify],
  );

  return { copyLink, open, openAsOwner };
}
