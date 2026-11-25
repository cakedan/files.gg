import { MailWarning, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import type { User } from '../../lib/api';
import { getSessionItem, setSessionItem } from '../../lib/storage';
import { ResendButton } from './ResendButton';

const DISMISS_KEY = 'filesgg.verify-banner';

/**
 * §13.3: "Verify your email to recover your account and add domains" with **Resend**,
 * dismissible for this browser session; an account with no email (Discord sign-up) is
 * offered to add one.
 */
export function AccountBanner({ user }: { user: User }) {
  const [dismissed, setDismissed] = useState(() => getSessionItem(DISMISS_KEY) === user.id);
  if (dismissed || (user.email && user.email_verified)) return null;
  const dismiss = () => {
    setSessionItem(DISMISS_KEY, user.id);
    setDismissed(true);
  };
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <MailWarning aria-hidden className="size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        {user.email ? 'Verify your email to recover your account and add domains.' : 'Add an email so you can recover your account.'}
      </span>
      {user.email ? (
        <ResendButton label="Resend" />
      ) : (
        <Link to="/settings/security" className="font-medium text-gg hover:underline">
          Add an email
        </Link>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text">
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
