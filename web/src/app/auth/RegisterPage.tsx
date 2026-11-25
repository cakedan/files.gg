import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { Button } from '../../components/Button';
import { SignUpAgreement } from '../../components/TermsAgreement';
import { useTurnstile } from '../../components/useTurnstile';
import { accountApi } from '../../lib/accountApi';
import { GUEST_KEY } from '../../lib/api';
import { fieldErrors } from '../../lib/errors';
import { PASSWORD_PROBLEM_TEXT, passwordProblem } from '../../lib/passwordStrength';
import { getItem } from '../../lib/storage';
import { useCompleteSignIn } from '../../lib/session';
import { cleanDisplayName, DISPLAY_NAME_MAX, DISPLAY_NAME_REASON_TEXT, displayNameProblem, normalizeUsername, usernameProblem } from '../../lib/usernames';
import { fieldClass } from '../access/fieldUtils';
import { PasswordInput, StrengthMeter } from '../account/PasswordInput';
import { TurnstileField } from '../account/TurnstileField';
import { UsernameField } from '../account/UsernameField';
import { AuthCard, FormError } from './AuthLayout';
import { authErrorMessage, signedInToast, useNext, useSignedInTarget } from './authUtils';
import { DiscordButton } from './DiscordButton';

/** `/app/register` (milestone-6 §4.3, §13.2). */
export default function RegisterPage() {
  const id = useId();
  const signedInTarget = useSignedInTarget();
  // Set as this page signs in, so its own navigation (with the toast) wins over the redirect.
  const [leaving, setLeaving] = useState(false);
  const next = useNext();
  const navigate = useNavigate();
  const completeSignIn = useCompleteSignIn();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const turnstile = useTurnstile('register');
  const hasGuest = Boolean(getItem(GUEST_KEY));

  if (signedInTarget && !leaving) return <Navigate to={signedInTarget} replace />;

  const displayProblem = displayNameProblem(displayName);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const local: Record<string, string> = {};
    if (!email.trim()) local.email = 'Enter your email.';
    const name = normalizeUsername(username);
    if (usernameProblem(name)) local.username = 'Choose a valid username.';
    const pwProblem = passwordProblem(password, { username: name, email });
    if (pwProblem) local.password = PASSWORD_PROBLEM_TEXT[pwProblem];
    if (displayProblem) local.display_name = DISPLAY_NAME_REASON_TEXT[displayProblem];
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const token = await turnstile.take();
      const display = cleanDisplayName(displayName);
      const { user } = await accountApi.register({ email: email.trim(), username: name, password, ...(display ? { display_name: display } : {}), turnstile_token: token });
      const toast = signedInToast(hasGuest, false) ?? 'Welcome to files.gg. Check your email to verify it.';
      setLeaving(true);
      completeSignIn(user);
      navigate(next ?? '/', { replace: true, state: { toast } });
    } catch (failure) {
      const fields = fieldErrors(failure);
      setErrors(fields);
      setError(Object.keys(fields).length > 0 ? null : authErrorMessage(failure));
      setPending(false);
    }
  };

  return (
    <AuthCard
      title="Create an account"
      description="Keep your files, make albums and upload from ShareX."
      footer={
        <>
          Already have an account?{' '}
          <Link to={next ? `/login?next=${encodeURIComponent(`/app${next}`)}` : '/login'} className="text-gg hover:underline">
            Sign in
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
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(errors.email) || undefined}
            aria-describedby={errors.email ? `${id}-email-error` : undefined}
            className={`${fieldClass} w-full`}
          />
          {errors.email && (
            <p id={`${id}-email-error`} className="text-xs text-danger">
              {errors.email}
            </p>
          )}
        </div>
        <UsernameField value={username} onChange={setUsername} error={errors.username} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-display`} className="text-sm font-medium">
            Display name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id={`${id}-display`}
            autoComplete="nickname"
            value={displayName}
            maxLength={DISPLAY_NAME_MAX * 2}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(errors.display_name ?? displayProblem) || undefined}
            aria-describedby={`${id}-display-hint`}
            className={`${fieldClass} w-full`}
          />
          <p id={`${id}-display-hint`} className={`text-xs ${errors.display_name || displayProblem ? 'text-danger' : 'text-muted'}`}>
            {errors.display_name ?? (displayProblem ? DISPLAY_NAME_REASON_TEXT[displayProblem] : 'Shown next to your username. It doesn’t have to be unique.')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-password`} className="text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id={`${id}-password`}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors.password) || undefined}
            aria-describedby={`${id}-password-hint`}
          />
          <StrengthMeter password={password} />
          <p id={`${id}-password-hint`} className={`text-xs ${errors.password ? 'text-danger' : 'text-muted'}`}>
            {errors.password ?? 'At least 8 characters. Longer is better.'}
          </p>
        </div>
        <p className="text-xs text-muted">Files you uploaded from this browser will move to your account.</p>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" disabled={pending} className="w-full">
          {pending ? 'Creating your account…' : 'Create account'}
        </Button>
        <SignUpAgreement />
        <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />
      </form>
      <DiscordButton next={next} />
    </AuthCard>
  );
}
