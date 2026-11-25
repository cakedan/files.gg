import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { accountApi } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';
import { broadcastSessionChange, SESSION_QUERY_KEY, useSession } from '../../lib/session';
import { ResendButton } from '../account/ResendButton';
import { AuthCard } from './AuthLayout';
import { readFragmentToken } from './authUtils';

type State = 'working' | 'verified' | 'invalid' | 'failed';

/** `/app/verify#token=…` (§2.5, §13.2). Works signed in or out; it never signs anyone in. */
export default function VerifyPage() {
  const [token] = useState(readFragmentToken);
  const [state, setState] = useState<State>(token ? 'working' : 'invalid');
  const [failure, setFailure] = useState<string | null>(null);
  const session = useSession();
  const client = useQueryClient();
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    accountApi.verify(token).then(
      () => {
        setState('verified');
        void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        broadcastSessionChange();
      },
      (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        if (code === 'INVALID_TOKEN' || code === 'EMAIL_TAKEN') {
          setFailure(code === 'EMAIL_TAKEN' ? errorMessage(error) : null);
          setState('invalid');
        } else {
          setFailure(errorMessage(error));
          setState('failed');
        }
      },
    );
  }, [token, client]);

  if (state === 'working') {
    return (
      <AuthCard title="Verifying your email">
        <p role="status" className="text-sm text-muted">
          One moment…
        </p>
      </AuthCard>
    );
  }
  if (state === 'verified') {
    return (
      <AuthCard title="Email verified">
        <p role="status" className="flex items-start gap-2 text-sm">
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-gg" />
          You can use it to recover your account and to add domains.
        </p>
        <Link to="/" className="text-sm text-gg hover:underline">
          Go to your dashboard
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={state === 'failed' ? 'Couldn’t verify your email' : 'This link is invalid or has expired'}>
      <p role="alert" className="flex items-start gap-2 text-sm text-muted">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        {failure ?? 'Verification links work once, for 24 hours.'}
      </p>
      {session.data ? (
        <ResendButton />
      ) : (
        <p className="text-sm text-muted">
          <Link to="/login?next=%2Fapp%2Fsettings%2Fsecurity" className="text-gg hover:underline">
            Sign in
          </Link>{' '}
          to send a new link.
        </p>
      )}
    </AuthCard>
  );
}
