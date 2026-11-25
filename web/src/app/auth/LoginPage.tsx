import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { accountApi } from '../../lib/accountApi';
import { FINGERPRINT_KEY } from '../../lib/api';
import { getItem } from '../../lib/storage';
import { useCompleteSignIn } from '../../lib/session';
import { fieldClass } from '../access/fieldUtils';
import { PasswordInput } from '../account/PasswordInput';
import { TurnstileField } from '../account/TurnstileField';
import { AuthCard, FormError } from './AuthLayout';
import { authErrorMessage, signedInToast, useNext, useSignedInTarget } from './authUtils';
import { DiscordButton } from './DiscordButton';

/** `/app/login` (milestone-6 §4.1, §13.2): email only, never a username. */
export default function LoginPage() {
  const id = useId();
  const signedInTarget = useSignedInTarget();
  // Set as this page signs in, so its own navigation (with the toast) wins over the redirect.
  const [leaving, setLeaving] = useState(false);
  const next = useNext();
  const navigate = useNavigate();
  const completeSignIn = useCompleteSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const turnstile = useTurnstile('login');
  const hasFingerprint = Boolean(getItem(FINGERPRINT_KEY));

  if (signedInTarget && !leaving) return <Navigate to={signedInTarget} replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const token = await turnstile.take();
      const { user } = await accountApi.login({ email: email.trim(), password, turnstile_token: token });
      const toast = signedInToast(hasFingerprint, user.deletion !== null);
      setLeaving(true);
      completeSignIn(user);
      navigate(next ?? '/', { replace: true, state: toast ? { toast } : null });
    } catch (failure) {
      setError(authErrorMessage(failure));
      setPending(false);
    }
  };

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back to files.gg."
      footer={
        <>
          New to files.gg?{' '}
          <Link to={next ? `/register?next=${encodeURIComponent(`/app${next}`)}` : '/register'} className="text-gg hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            Email
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`${fieldClass} w-full`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-password`} className="text-sm font-medium">
              Password
            </label>
            <Link to="/forgot" className="text-xs text-gg hover:underline">
              Forgot password?
            </Link>
          </div>
          <PasswordInput id={`${id}-password`} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {hasFingerprint && <p className="text-xs text-muted">Files you uploaded from this browser will move to your account.</p>}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" disabled={pending || !email.trim() || !password} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
        <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />
      </form>
      <DiscordButton next={next} />
    </AuthCard>
  );
}
