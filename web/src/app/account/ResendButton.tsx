import { useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';

/** **Send a new link** (`POST /auth/verify/resend`). */
export function ResendButton({ label = 'Send a new link' }: { label?: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    setState('sending');
    setError(null);
    accountApi.resendVerification().then(
      () => setState('sent'),
      (failure: unknown) => {
        setError(errorMessage(failure));
        setState('idle');
      },
    );
  };
  return (
    <div className="flex flex-col gap-2">
      {state === 'sent' ? (
        <p role="status" className="text-sm">
          Sent. Check your inbox.
        </p>
      ) : (
        <Button onClick={send} disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : label}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
