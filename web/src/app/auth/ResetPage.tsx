import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { accountApi } from '../../lib/accountApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/errors';
import { PASSWORD_PROBLEM_TEXT, passwordProblem } from '../../lib/passwordStrength';
import { useCompleteSignIn } from '../../lib/session';
import { PasswordInput, StrengthMeter } from '../account/PasswordInput';
import { TurnstileField } from '../account/TurnstileField';
import { AuthCard, FormError } from './AuthLayout';
import { authErrorMessage, readFragmentToken } from './authUtils';

/** `/app/reset#token=…` (§4.4, §13.2): a new password, then signed in as that account. */
export default function ResetPage() {
  const id = useId();
  const [token] = useState(readFragmentToken);
  const navigate = useNavigate();
  const completeSignIn = useCompleteSignIn();
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [pending, setPending] = useState(false);
  const turnstile = useTurnstile('reset', !invalid);

  if (invalid || !token) {
    return (
      <AuthCard title="This link is invalid or has expired" footer={<Link to="/login" className="text-gg hover:underline">Back to sign in</Link>}>
        <p className="text-sm text-muted">Reset links work once, for 1 hour.</p>
        <Link to="/forgot" className="text-sm text-gg hover:underline">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const problem = passwordProblem(password);
    if (problem) {
      setFieldError(PASSWORD_PROBLEM_TEXT[problem]);
      return;
    }
    setPending(true);
    setError(null);
    setFieldError(null);
    try {
      const captcha = await turnstile.take();
      const { user } = await accountApi.reset({ token, password, turnstile_token: captcha });
      completeSignIn(user);
      navigate('/', { replace: true, state: { toast: 'Your password was changed, and you’re signed in.' } });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'INVALID_TOKEN') {
        setInvalid(true);
        return;
      }
      const fields = fieldErrors(failure);
      if (fields.password) setFieldError(fields.password);
      else setError(authErrorMessage(failure));
      setPending(false);
    }
  };

  return (
    <AuthCard title="Choose a new password" description="Every device signed in to your account will be signed out.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-password`} className="text-sm font-medium">
            New password
          </label>
          <PasswordInput
            id={`${id}-password`}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(fieldError) || undefined}
            aria-describedby={`${id}-hint`}
          />
          <StrengthMeter password={password} />
          <p id={`${id}-hint`} className={`text-xs ${fieldError ? 'text-danger' : 'text-muted'}`}>
            {fieldError ?? 'At least 8 characters. Longer is better.'}
          </p>
        </div>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" disabled={pending || !password} className="w-full">
          {pending ? 'Saving…' : 'Save and sign in'}
        </Button>
        <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />
      </form>
    </AuthCard>
  );
}
