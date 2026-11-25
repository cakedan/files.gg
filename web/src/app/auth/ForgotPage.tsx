import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { accountApi } from '../../lib/accountApi';
import { fieldClass } from '../access/fieldUtils';
import { TurnstileField } from '../account/TurnstileField';
import { AuthCard, FormError } from './AuthLayout';
import { authErrorMessage } from './authUtils';

/** The answer whatever happened (§4.4: no enumeration). */
export const FORGOT_SENT = 'If an account uses that email, we’ve sent a link. It works for 1 hour.';

/** `/app/forgot` (§4.4, §13.2). */
export default function ForgotPage() {
  const id = useId();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const turnstile = useTurnstile('forgot', !sent);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const token = await turnstile.take();
      await accountApi.forgot({ email: email.trim(), turnstile_token: token });
      setSent(true);
    } catch (failure) {
      setError(authErrorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthCard
      title="Reset your password"
      description={sent ? undefined : 'Enter your account’s email and we’ll send you a link.'}
      footer={
        <Link to="/login" className="text-gg hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="text-sm">
          {FORGOT_SENT}
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="text-sm font-medium">
              Email
            </label>
            <input id={`${id}-email`} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={`${fieldClass} w-full`} />
          </div>
          <FormError>{error}</FormError>
          <Button type="submit" variant="primary" disabled={pending || !email.trim()} className="w-full">
            {pending ? 'Sending…' : 'Send link'}
          </Button>
          <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />
        </form>
      )}
    </AuthCard>
  );
}
