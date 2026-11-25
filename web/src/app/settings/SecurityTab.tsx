import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Monitor } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '../../components/Button';
import { accountApi, type AccountSession } from '../../lib/accountApi';
import { SESSION_QUERY_KEY, signedOut } from '../../lib/session';
import type { User } from '../../lib/api';
import { startDiscord } from '../../lib/discord';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { PASSWORD_PROBLEM_TEXT, passwordProblem } from '../../lib/passwordStrength';
import { epochMs, formatDay, formatRelative } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { fieldClass } from '../access/fieldUtils';
import { accountKeys, useAccountSessions } from '../account/accountQueries';
import { PasswordInput, StrengthMeter } from '../account/PasswordInput';
import { isReauthCancelled, useReauth } from '../account/useReauth';
import { useAuthConfig } from '../auth/authUtils';
import { ResendButton } from '../account/ResendButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { isSuspended } from './settingsUtils';
import { LockedNote, Panel, Result } from './Panel';

const shownError = (error: unknown) => (error && !isReauthCancelled(error) ? errorMessage(error) : null);

/** Settings → Security (milestone-6 §5.6, §8.2–§8.5, §13.3). */
export default function SecurityTab({ user }: { user: User }) {
  const { run, dialog } = useReauth();
  const suspended = isSuspended(user);
  return (
    <div className="flex flex-col gap-4">
      {suspended && <LockedNote>Your account is suspended. You can still change your password and sign out your sessions.</LockedNote>}
      <EmailPanel user={user} run={run} locked={suspended} />
      <PasswordPanel user={user} run={run} />
      <LoginMethodsPanel user={user} run={run} locked={suspended} />
      <SessionsPanel />
      {dialog}
    </div>
  );
}

type Run = ReturnType<typeof useReauth>['run'];

function EmailPanel({ user, run, locked }: { user: User; run: Run; locked: boolean }) {
  const id = useId();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [editing, setEditing] = useState(!user.email);
  const refresh = () => void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  const change = useMutation({
    mutationFn: (value: string) => run(() => accountApi.changeEmail(value)),
    onSuccess: () => {
      setEmail('');
      setEditing(false);
      refresh();
    },
  });
  const cancel = useMutation({ mutationFn: () => accountApi.cancelPendingEmail(), onSuccess: refresh });
  const fieldError = fieldErrors(change.error).email;

  return (
    <Panel title="Email" description="For signing in and recovering your account. Never shown to anyone else.">
      {user.email ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium break-all">{user.email}</span>
          {user.email_verified ? (
            <span className="inline-flex items-center gap-1 text-xs text-gg">
              <CheckCircle2 aria-hidden className="size-3.5" /> Verified
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-warn">
              <CircleAlert aria-hidden className="size-3.5" /> Not verified
            </span>
          )}
        </p>
      ) : (
        <p className="text-sm text-muted">No email yet. Add one so you can recover your account.</p>
      )}
      {user.email && !user.email_verified && !user.pending_email && !locked && <ResendButton label="Resend verification email" />}
      {user.pending_email && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            Waiting for you to confirm <span className="font-medium break-all">{user.pending_email}</span>. We sent a link there; your current email works until then.
          </span>
          <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending || locked}>
            Cancel
          </Button>
        </div>
      )}
      {!locked && editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) change.mutate(email.trim());
          }}
        >
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            {user.email ? 'New email' : 'Email'}
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(fieldError) || undefined}
            className={`${fieldClass} w-full max-w-sm`}
          />
          {user.email && <p className="text-xs text-muted">We’ll send a link to the new address. Your current email keeps working until you open it.</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={change.isPending || !email.trim()}>
              {change.isPending ? 'Saving…' : user.email ? 'Change email' : 'Add email'}
            </Button>
            {user.email && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
          <Result error={fieldError ?? shownError(change.error)} />
        </form>
      ) : (
        !locked && (
          <div>
            <Button onClick={() => setEditing(true)}>Change email</Button>
          </div>
        )
      )}
      <Result error={shownError(cancel.error)} />
    </Panel>
  );
}

function PasswordPanel({ user, run }: { user: User; run: Run }) {
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: (body: { current_password?: string; new_password: string }) => run(() => accountApi.setPassword(body)),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setDone(true);
    },
  });
  // §8.5: setting a first password (Discord-only) needs a verified email to recover it.
  const blocked = !user.has_password && !user.email_verified;
  const fields = fieldErrors(change.error);

  return (
    <Panel
      title="Password"
      description={user.has_password ? 'Changing it signs out every other device.' : 'You sign in with Discord. Add a password to sign in with your email too.'}
    >
      {blocked ? (
        <LockedNote>Verify your email first, so you can recover your account if you forget the password.</LockedNote>
      ) : (
        <form
          className="flex max-w-sm flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setDone(false);
            const issue = passwordProblem(next, { username: user.username, email: user.email });
            setProblem(issue ? PASSWORD_PROBLEM_TEXT[issue] : null);
            if (issue) return;
            change.mutate(user.has_password ? { current_password: current, new_password: next } : { new_password: next });
          }}
        >
          {user.has_password && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-current`} className="text-sm font-medium">
                Current password
              </label>
              <PasswordInput id={`${id}-current`} autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-new`} className="text-sm font-medium">
              New password
            </label>
            <PasswordInput id={`${id}-new`} autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} aria-describedby={`${id}-hint`} />
            <StrengthMeter password={next} />
            <p id={`${id}-hint`} className={`text-xs ${problem || fields.password ? 'text-danger' : 'text-muted'}`}>
              {problem ?? fields.password ?? 'At least 8 characters. Longer is better.'}
            </p>
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={change.isPending || !next || (user.has_password && !current)}>
              {change.isPending ? 'Saving…' : user.has_password ? 'Change password' : 'Set password'}
            </Button>
          </div>
          {!fields.password && <Result error={change.error && (change.error as { code?: unknown }).code === 'INVALID_CREDENTIALS' ? 'Your current password isn’t right.' : shownError(change.error)} />}
          {done && (
            <p role="status" className="text-sm text-gg">
              Password saved. Other devices were signed out. Your upload keys still work. Revoke them in Integrations if you think one leaked.
            </p>
          )}
        </form>
      )}
    </Panel>
  );
}

function LoginMethodsPanel({ user, run, locked }: { user: User; run: Run; locked: boolean }) {
  const client = useQueryClient();
  const config = useAuthConfig();
  const [confirming, setConfirming] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const discord = user.identities.find((identity) => identity.provider === 'discord') ?? null;
  const unlink = useMutation({
    mutationFn: () => run(() => accountApi.unlinkDiscord()),
    onSuccess: () => {
      setConfirming(false);
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
  // §5.6: Discord can't be removed unless a password and a verified email remain.
  const lastMethod = !(user.has_password && user.email_verified);
  const lastReason = 'Add a password and verify your email first, so you can still sign in.';

  const link = async () => {
    setLinkError(null);
    try {
      await startDiscord('link', '/settings/security');
    } catch (failure) {
      setLinkError(errorMessage(failure));
    }
  };

  return (
    <Panel title="Login methods" description="Connected accounts you can sign in with.">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
        {discord?.avatar_url ? (
          <img src={discord.avatar_url} alt="" width={32} height={32} className="size-8 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full bg-[#5865f2] text-xs font-bold text-white">
            D
          </span>
        )}
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Discord</p>
          <p className="truncate text-xs text-muted">
            {discord ? `${discord.display_name ? `${discord.display_name} · ` : ''}@${discord.username ?? 'unknown'} · linked ${formatDay(epochMs(discord.created_at))}` : 'Not linked'}
          </p>
        </div>
        {discord ? (
          <span title={lastMethod ? lastReason : undefined}>
            <Button onClick={() => setConfirming(true)} disabled={lastMethod || locked} aria-describedby={lastMethod ? 'unlink-reason' : undefined}>
              Unlink
            </Button>
          </span>
        ) : (
          config.data?.discord !== false && (
            <Button onClick={() => void link()} disabled={locked}>
              Link
            </Button>
          )
        )}
      </div>
      {discord && lastMethod && (
        <p id="unlink-reason" className="text-xs text-muted">
          {lastReason}
        </p>
      )}
      {discord && <p className="text-xs text-muted">To remove files.gg from your Discord account too, open Discord → User Settings → Authorized Apps.</p>}
      <Result error={linkError ?? shownError(unlink.error)} />
      {confirming && (
        <ConfirmDialog
          title="Unlink Discord?"
          confirmLabel="Unlink"
          pending={unlink.isPending}
          pendingLabel="Unlinking…"
          error={shownError(unlink.error)}
          onConfirm={() => unlink.mutate()}
          onClose={() => setConfirming(false)}
        >
          <p>You won’t be able to sign in with Discord until you link it again.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}

function SessionsPanel() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const sessions = useAccountSessions();
  const [everywhere, setEverywhere] = useState(false);
  const leave = () => {
    signedOut(client);
    navigate('/login', { replace: true });
  };
  const revoke = useMutation({
    mutationFn: (session: AccountSession) => accountApi.revokeSession(session.id),
    onSuccess: (_data, session) => (session.current ? leave() : void client.invalidateQueries({ queryKey: accountKeys.sessions })),
  });
  const revokeAll = useMutation({ mutationFn: () => accountApi.revokeAllSessions(), onSuccess: leave });

  return (
    <Panel title="Sessions" description="Where you’re signed in. Sessions end 30 days after their last use.">
      {sessions.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : sessions.isError ? (
        <Result error={errorMessage(sessions.error)} />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Sessions">
          {sessions.data.items.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Monitor aria-hidden className="size-5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">
                  {session.device}
                  {session.current && <span className="ml-2 rounded bg-gg/15 px-1.5 py-0.5 text-xs font-medium text-gg">This device</span>}
                </p>
                <p className="text-xs text-muted">
                  {[session.country, `last used ${formatRelative(epochMs(session.last_used_at), now)}`, `signed in ${formatDay(epochMs(session.created_at))}`].filter(Boolean).join(' · ')}
                </p>
              </div>
              <Button variant="ghost" onClick={() => revoke.mutate(session)} disabled={revoke.isPending} aria-label={`Sign out ${session.device}${session.current ? ' (this device)' : ''}`}>
                Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Result error={shownError(revoke.error) ?? shownError(revokeAll.error)} />
      <div>
        <Button variant="danger" onClick={() => setEverywhere(true)}>
          Sign out everywhere
        </Button>
      </div>
      {everywhere && (
        <ConfirmDialog
          title="Sign out everywhere?"
          confirmLabel="Sign out everywhere"
          pending={revokeAll.isPending}
          pendingLabel="Signing out…"
          error={shownError(revokeAll.error)}
          onConfirm={() => revokeAll.mutate()}
          onClose={() => setEverywhere(false)}
        >
          <p>Every device signed in to your account is signed out, including this one. Upload keys keep working.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}
