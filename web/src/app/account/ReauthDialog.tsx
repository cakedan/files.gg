import { useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import { ApiError } from '../../lib/api';
import { startDiscord } from '../../lib/discord';
import { errorMessage } from '../../lib/errors';
import { Dialog } from '../components/Dialog';
import { PasswordInput } from './PasswordInput';
import type { ReauthMethod } from './reauth';

/** The shared re-authentication dialog: the password, or Discord (`purpose: reauth`). */
export function ReauthDialog({ methods, title, onConfirmed, onCancel }: { methods: ReauthMethod[]; title: string; onConfirmed: () => void; onCancel: () => void }) {
  const id = useId();
  const { pathname } = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPassword = methods.includes('password');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await accountApi.reauth(password);
      onConfirmed();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.code === 'INVALID_CREDENTIALS' ? 'That password isn’t right.' : errorMessage(failure));
      setBusy(false);
    }
  };

  const discord = async () => {
    setBusy(true);
    setError(null);
    try {
      await startDiscord('reauth', pathname);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title={title} description="For your security, confirm it’s you before changing this." onClose={onCancel} initialFocus={hasPassword ? input : undefined} size="sm">
      <div className="flex flex-col gap-4">
        {hasPassword && (
          <form id={`${id}-form`} onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-password`} className="text-sm font-medium">
                Password
              </label>
              <PasswordInput ref={input} id={`${id}-password`} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
          </form>
        )}
        {methods.includes('discord') && (
          <Button onClick={() => void discord()} disabled={busy}>
            Continue with Discord
          </Button>
        )}
        {methods.includes('discord') && <p className="text-xs text-muted">Discord brings you back here. Then try again.</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
