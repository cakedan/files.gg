import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '../../components/Button';
import { useTurnstile } from '../../components/useTurnstile';
import { accountApi, type DiscordCallbackResponse } from '../../lib/accountApi';
import { ApiError, GUEST_KEY } from '../../lib/api';
import { clearOAuth, loadOAuth, startDiscord, type StoredOAuth } from '../../lib/discord';
import { fieldErrors } from '../../lib/errors';
import { getItem } from '../../lib/storage';
import { SESSION_QUERY_KEY, useCompleteSignIn } from '../../lib/session';
import { cleanDisplayName, DISPLAY_NAME_MAX, DISPLAY_NAME_REASON_TEXT, displayNameProblem, normalizeUsername, usernameProblem } from '../../lib/usernames';
import { fieldClass } from '../access/fieldUtils';
import { TurnstileField } from '../account/TurnstileField';
import { UsernameField } from '../account/UsernameField';
import { AuthCard, FormError } from './AuthLayout';
import { authErrorMessage, signedInToast } from './authUtils';
import { captureQuery, firstStep } from './discordCallback';
import { SignUpTerms } from './SignUpTerms';

type Signup = Extract<DiscordCallbackResponse, { status: 'signup_required' }>;

type View =
  | { kind: 'working' }
  | { kind: 'error'; message: string; purpose: StoredOAuth['purpose'] | null; emailInUse?: boolean }
  | { kind: 'signup'; signup: Signup; oauth: StoredOAuth };

/** Where link and re-auth return to: the page that started them, else Security settings. */
const settingsTarget = (oauth: StoredOAuth) => oauth.next ?? '/settings/security';

/**
 * `/app/auth/discord` (milestone-6 §5.2 steps 4–6, §5.3, §13.2): checks `state` against
 * the stored one (and sends nothing when it differs), clears the query, runs Turnstile for
 * a sign-in, and finishes the flow for its purpose.
 */
export default function DiscordPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const completeSignIn = useCompleteSignIn();
  const [oauth] = useState(loadOAuth);
  const [step] = useState(() => firstStep(oauth, captureQuery()));
  const [view, setView] = useState<View>(() => (step.kind === 'stop' ? { kind: 'error', message: step.message, purpose: oauth?.purpose ?? null } : { kind: 'working' }));
  const login = oauth?.purpose === 'login';
  const turnstile = useTurnstile('login', step.kind === 'callback' && login && view.kind === 'working');
  const started = useRef(false);
  const [hadGuest] = useState(() => Boolean(getItem(GUEST_KEY)));

  useEffect(() => {
    if (!oauth || started.current) return;
    started.current = true;
    if (step.kind === 'stop') {
      clearOAuth();
      return;
    }
    if (step.kind === 'retry') {
      startDiscord(oauth.purpose, oauth.next, { retry: true }).catch((failure: unknown) =>
        setView({ kind: 'error', message: authErrorMessage(failure), purpose: oauth.purpose }),
      );
      return;
    }
    const { code } = step;
    void (async () => {
      try {
        const turnstileToken = oauth.purpose === 'login' ? await turnstile.take() : undefined;
        const result = await accountApi.discordCallback({ code, state: oauth.state, code_verifier: oauth.verifier, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) });
        if (result.status === 'signup_required') {
          setView({ kind: 'signup', signup: result, oauth });
          return;
        }
        clearOAuth();
        if (result.status === 'signed_in') {
          const toast = signedInToast(hadGuest, result.user.deletion !== null);
          completeSignIn(result.user);
          navigate(oauth.next ?? '/', { replace: true, state: toast ? { toast } : null });
        } else if (result.status === 'linked') {
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          navigate(settingsTarget(oauth), { replace: true, state: { toast: 'Discord is linked. You can sign in with it now.' } });
        } else {
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          navigate(settingsTarget(oauth), { replace: true, state: { toast: 'Confirmed. You can continue.', reauthenticated: true } });
        }
      } catch (failure) {
        clearOAuth();
        setView({ kind: 'error', message: authErrorMessage(failure), purpose: oauth.purpose });
      }
    })();
    // Runs once per page load; `turnstile.take` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (view.kind === 'signup') return <ChooseUsername signup={view.signup} oauth={view.oauth} hadGuest={hadGuest} onError={setView} />;
  if (view.kind === 'error') {
    const back = view.purpose === 'link' || view.purpose === 'reauth' ? { to: '/settings/security', label: 'Back to settings' } : { to: '/login', label: 'Back to sign in' };
    return (
      <AuthCard title={view.emailInUse ? 'Sign in with your password' : 'Discord sign-in'}>
        <p role="alert" className="text-sm">
          {view.message}
        </p>
        <Link to={back.to} className="text-sm text-gg hover:underline">
          {view.emailInUse ? 'Sign in' : back.label}
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Signing in with Discord">
      <p role="status" className="text-sm text-muted">
        One moment…
      </p>
      {login && <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />}
    </AuthCard>
  );
}

/** "Choose your username" (§5.5): the suggestion filled in, a display name, the email line. */
function ChooseUsername({ signup, oauth, hadGuest, onError }: { signup: Signup; oauth: StoredOAuth; hadGuest: boolean; onError: (view: View) => void }) {
  const id = useId();
  const navigate = useNavigate();
  const completeSignIn = useCompleteSignIn();
  const [username, setUsername] = useState(signup.suggested_username);
  const [displayName, setDisplayName] = useState(signup.discord.display_name ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const turnstile = useTurnstile('register');
  const displayProblem = displayNameProblem(displayName);
  const inUse = signup.email.reason === 'in_use';

  useEffect(() => {
    // §5.5: a verified Discord email that belongs to an account is refused; say so at once.
    if (inUse) {
      clearOAuth();
      onError({ kind: 'error', message: 'An account already uses this email. Sign in with your password, then link Discord in Settings.', purpose: 'login', emailInUse: true });
    }
  }, [inUse, onError]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const name = normalizeUsername(username);
    const local: Record<string, string> = {};
    if (usernameProblem(name)) local.username = 'Choose a valid username.';
    if (displayProblem) local.display_name = DISPLAY_NAME_REASON_TEXT[displayProblem];
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const token = await turnstile.take();
      const display = cleanDisplayName(displayName);
      const { user } = await accountApi.discordSignup({ signup_token: signup.signup_token, username: name, ...(display ? { display_name: display } : {}), turnstile_token: token });
      clearOAuth();
      completeSignIn(user);
      navigate(oauth.next ?? '/', { replace: true, state: { toast: signedInToast(hadGuest, false) ?? 'Welcome to files.gg.' } });
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'DISCORD_EMAIL_IN_USE' || failure.code === 'INVALID_SIGNUP_TOKEN' || failure.code === 'IDENTITY_IN_USE')) {
        clearOAuth();
        onError({ kind: 'error', message: authErrorMessage(failure), purpose: 'login', emailInUse: failure.code === 'DISCORD_EMAIL_IN_USE' });
        return;
      }
      const fields = fieldErrors(failure);
      setErrors(fields);
      setError(Object.keys(fields).length > 0 ? null : authErrorMessage(failure));
      setPending(false);
    }
  };

  return (
    <AuthCard title="Choose your username" description={`Signing up with Discord as ${signup.discord.username}.`}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <UsernameField value={username} onChange={setUsername} error={errors.username} autoFocus />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-display`} className="text-sm font-medium">
            Display name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id={`${id}-display`}
            value={displayName}
            maxLength={DISPLAY_NAME_MAX * 2}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(errors.display_name ?? displayProblem) || undefined}
            aria-describedby={`${id}-display-hint`}
            className={`${fieldClass} w-full`}
          />
          <p id={`${id}-display-hint`} className={`text-xs ${errors.display_name || displayProblem ? 'text-danger' : 'text-muted'}`}>
            {errors.display_name ?? (displayProblem ? DISPLAY_NAME_REASON_TEXT[displayProblem] : 'Shown next to your username.')}
          </p>
        </div>
        <p className="text-sm text-muted">
          {signup.email.usable && signup.email.address
            ? `We’ll use ${signup.email.address} from Discord.`
            : 'Discord didn’t share a verified email. You can add one later.'}
        </p>
        {hadGuest && <p className="text-xs text-muted">Files you uploaded from this browser will move to your account.</p>}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" disabled={pending} className="w-full">
          {pending ? 'Creating your account…' : 'Create account'}
        </Button>
        <SignUpTerms />
        <TurnstileField mount={turnstile.mount} status={turnstile.status} retry={turnstile.retry} />
      </form>
    </AuthCard>
  );
}
