import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import type { User } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { broadcastSessionChange, setSessionUser } from '../../lib/session';
import { epochMs, formatDay } from '../../lib/time';
import { useToast } from '../components/toastContext';
import { ExportsSection } from './ExportsSection';
import { useSignOut } from './useSignOut';

/**
 * While a deletion is pending (milestone-6 §8.8, §13.3) every dashboard route shows only
 * this: the date, **Keep my account**, **Download my data** and **Sign out**.
 */
export function PendingDeletionScreen({ user }: { user: User & { deletion: NonNullable<User['deletion']> } }) {
  const client = useQueryClient();
  const notify = useToast();
  const signOut = useSignOut();
  const [exporting, setExporting] = useState(false);
  const keep = useMutation({
    mutationFn: () => accountApi.cancelDeletion(),
    onSuccess: (updated) => {
      setSessionUser(client, updated);
      broadcastSessionChange();
      notify('Your account is back. Your files and albums will be online again in a few seconds.');
    },
  });
  const date = formatDay(epochMs(user.deletion.scheduled_for));

  useEffect(() => {
    document.title = 'Keep your account? · files.gg';
  }, []);

  return (
    <section className="mx-auto flex max-w-xl flex-col gap-5 rounded-xl border border-danger/40 bg-surface p-5 sm:p-6" aria-labelledby="pending-deletion-title">
      <div className="flex items-start gap-3">
        <CalendarClock aria-hidden className="mt-0.5 size-6 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <h1 id="pending-deletion-title" className="text-xl font-semibold tracking-tight">
            Your account will be deleted on {date}
          </h1>
          <p className="text-sm text-muted">Your files and albums are offline until then.</p>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p>Until you keep your account:</p>
        <ul className="list-disc pl-5 text-muted">
          <li>your files and albums look missing to everyone who opens them;</li>
          <li>your upload keys and custom domains don’t work;</li>
          <li>nothing in the dashboard can be changed. You can still download your data.</li>
        </ul>
        <p className="text-muted">After {date} your account is deleted for good and can’t be recovered.</p>
      </div>
      {keep.isError && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(keep.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => keep.mutate()} disabled={keep.isPending}>
          {keep.isPending ? 'Keeping your account…' : 'Keep my account'}
        </Button>
        <Button onClick={() => setExporting((value) => !value)} aria-expanded={exporting}>
          Download my data
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
      {exporting && (
        <div className="border-t border-line pt-4">
          <ExportsSection />
        </div>
      )}
    </section>
  );
}
