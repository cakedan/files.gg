import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api, type OwnerFile } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { OWNER_PASS_STALE_MS, queryKeys } from '../../lib/queries';
import { useToast } from '../components/toastContext';

/**
 * Copy link, Copy direct link, Open, "Open as owner" (mints an owner pass and opens its
 * URL) and "Open on <domain>" (an owner pass on that custom domain, milestone-6 §10.9).
 */
export function useFileActions() {
  const client = useQueryClient();
  const notify = useToast();

  const copyLink = useCallback(
    async (file: Pick<OwnerFile, 'url'>) => {
      notify((await copyText(file.url)) ? 'Link copied.' : "Couldn't copy the link.", 'success');
    },
    [notify],
  );

  /** §10.9: `direct_url` is the bytes on the link domain (signed like `cdn_url` when protected). */
  const copyDirectLink = useCallback(
    async (file: Pick<OwnerFile, 'direct_url' | 'cdn_url'>) => {
      notify((await copyText(file.direct_url ?? file.cdn_url)) ? 'Direct link copied.' : "Couldn't copy the link.", 'success');
    },
    [notify],
  );

  const open = useCallback((file: Pick<OwnerFile, 'url'>) => {
    window.open(file.url, '_blank', 'noopener');
  }, []);

  const openWithPass = useCallback(
    async (file: Pick<OwnerFile, 'id'>, domainId?: string) => {
      // Open the tab now, in the click, so pop-up blockers allow it; navigate once the pass is minted.
      const tab = window.open('about:blank', '_blank');
      if (tab) tab.opener = null;
      try {
        const pass = await client.fetchQuery({
          queryKey: domainId ? queryKeys.filePassOn(file.id, domainId) : queryKeys.filePass(file.id),
          queryFn: () => api.filePass(file.id, domainId),
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

  const openAsOwner = useCallback((file: Pick<OwnerFile, 'id'>) => openWithPass(file), [openWithPass]);
  const openOnDomain = useCallback((file: Pick<OwnerFile, 'id'>, domainId: string) => openWithPass(file, domainId), [openWithPass]);

  return { copyLink, copyDirectLink, open, openAsOwner, openOnDomain };
}
