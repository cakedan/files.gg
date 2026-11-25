import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import type { User } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { broadcastSessionChange, SESSION_QUERY_KEY } from '../../lib/session';
import { fieldClass } from '../access/fieldUtils';
import { ExportsSection } from '../account/ExportsSection';
import { isReauthCancelled, useReauth } from '../account/useReauth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Dialog } from '../components/Dialog';
import { FINAL_DELETION_TEXT, isSuspended, methodsOf } from './settingsUtils';
import { LockedNote, Panel } from './Panel';

/** Settings → Data (milestone-6 §8.7, §8.8, §13.3): the export, and deleting the account. */
export default function DataTab({ user }: { user: User }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Download your data">
        <ExportsSection />
      </Panel>
      <DeletePanel user={user} />
    </div>
  );
}

type Step = 'closed' | 'username' | 'final';

function DeletePanel({ user }: { user: User }) {
  const id = useId();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const { run, confirmIdentity, dialog } = useReauth();
  const [step, setStep] = useState<Step>('closed');
  const [typed, setTyped] = useState('');
  const request = useMutation({
    mutationFn: () => run(() => accountApi.requestDeletion(user.username)),
    onSuccess: () => {
      setStep('closed');
      // The session now carries `deletion`, which shows the Keep my account screen everywhere.
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      broadcastSessionChange();
    },
  });

  const description = 'Your account is locked and its files and albums go offline at once. You have 14 days to change your mind.';
  if (user.staff) {
    return (
      <Panel title="Delete account" description={description} tone="danger">
        <LockedNote>Staff accounts can’t be deleted while they’re staff.</LockedNote>
      </Panel>
    );
  }
  if (isSuspended(user)) {
    return (
      <Panel title="Delete account" description={description} tone="danger">
        <LockedNote>Suspended accounts can’t request deletion. Ask files.gg staff through your notices.</LockedNote>
      </Panel>
    );
  }

  const confirmUsername = async (event: React.FormEvent) => {
    event.preventDefault();
    if (typed.trim().toLowerCase() !== user.username) return;
    // §13.3: type the username, re-authenticate, then a final confirmation.
    try {
      await confirmIdentity(methodsOf(user), 'Confirm it’s you');
      setStep('final');
    } catch (error) {
      if (!isReauthCancelled(error)) throw error;
    }
  };

  return (
    <Panel title="Delete account" description={description} tone="danger">
      <ul className="list-disc pl-5 text-sm text-muted">
        <li>Your files and albums look missing to everyone, your upload keys and domains stop working, and every other device is signed out.</li>
        <li>Sign in within 14 days and choose Keep my account to cancel.</li>
        <li>After 14 days your account, files, albums and domains are deleted for good. Reports you sent are kept without your name.</li>
      </ul>
      <div>
        <Button variant="danger" onClick={() => setStep('username')}>
          Delete account
        </Button>
      </div>
      {step === 'username' && (
        <Dialog
          title="Delete your account?"
          onClose={() => setStep('closed')}
          initialFocus={input}
          size="sm"
          alert
          footer={
            <>
              <Button onClick={() => setStep('closed')}>Cancel</Button>
              <Button type="submit" form={`${id}-form`} variant="danger" disabled={typed.trim().toLowerCase() !== user.username}>
                Continue
              </Button>
            </>
          }
        >
          <form id={`${id}-form`} onSubmit={(event) => void confirmUsername(event)} className="flex flex-col gap-2">
            <label htmlFor={`${id}-username`} className="text-sm">
              Type your username, <span className="font-semibold">{user.username}</span>, to continue.
            </label>
            <input ref={input} id={`${id}-username`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} className={`${fieldClass} w-full`} />
          </form>
        </Dialog>
      )}
      {step === 'final' && (
        <ConfirmDialog
          title="Delete your account?"
          confirmLabel="Delete my account"
          pendingLabel="Deleting…"
          pending={request.isPending}
          error={request.error && !isReauthCancelled(request.error) ? errorMessage(request.error) : null}
          onConfirm={() => request.mutate()}
          onClose={() => setStep('closed')}
        >
          <p>{FINAL_DELETION_TEXT}</p>
        </ConfirmDialog>
      )}
      {dialog}
    </Panel>
  );
}
