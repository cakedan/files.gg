import { useState } from 'react';

import { Button } from '../../components/Button';
import { startDiscord } from '../../lib/discord';
import { OrDivider } from './AuthLayout';
import { authErrorMessage, useAuthConfig } from './authUtils';

/** Discord's own colour mark, drawn inline (no external request). */
function DiscordMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="currentColor">
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  );
}

/**
 * "or", then **Continue with Discord** (§5.2, purpose `login`, which covers sign-up). Both are hidden
 * when Discord is off, so the form never ends with a lone divider.
 */
export function DiscordButton({ next, label = 'Continue with Discord' }: { next: string | null; label?: string }) {
  const config = useAuthConfig();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config.data?.discord) return null;
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      await startDiscord('login', next);
    } catch (failure) {
      setPending(false);
      setError(authErrorMessage(failure));
    }
  };
  return (
    <>
      <OrDivider />
      <div className="flex flex-col gap-2">
        <Button onClick={() => void start()} disabled={pending} className="w-full">
          <DiscordMark />
          {pending ? 'Opening Discord…' : label}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

