import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';

import { accountApi } from '../../lib/accountApi';
import { ApiError } from '../../lib/api';
import { normalizeUsername, USERNAME_MAX, USERNAME_REASON_TEXT, usernameProblem } from '../../lib/usernames';
import { useDebounced } from '../components/useDebounced';

/** §13.2: checked with `/username/check` this long after the last keystroke. */
export const USERNAME_CHECK_DELAY_MS = 400;

interface UsernameFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The server's error for this field, after a submit. */
  error?: string | undefined;
  /** The account's own name: never reported as taken. */
  current?: string | undefined;
  label?: string;
  hint?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * A username input: lowercased as you type, checked against the rules at once and
 * against `GET /users/@me/username/check` after 400 ms, with the reason shown.
 */
export function UsernameField({ value, onChange, error, current, label = 'Username', hint, disabled, autoFocus }: UsernameFieldProps) {
  const id = useId();
  const name = normalizeUsername(value);
  const problem = name ? usernameProblem(name) : null;
  const debounced = useDebounced(name, USERNAME_CHECK_DELAY_MS);
  const checkable = Boolean(debounced) && debounced === name && !problem && debounced !== current;
  const check = useQuery({
    queryKey: ['username-check', debounced],
    queryFn: ({ signal }) => accountApi.checkUsername(debounced, signal),
    enabled: checkable,
    staleTime: 30_000,
    retry: false,
  });
  const result = checkable ? check.data : undefined;
  const local = problem ? USERNAME_REASON_TEXT[problem] : null;
  const remote = result && !result.available ? USERNAME_REASON_TEXT[result.reason ?? 'taken'] : null;
  const message = error ?? local ?? remote;
  const available = !message && result?.available && result.username === name;
  const rateLimited = check.error instanceof ApiError && check.error.code === 'TOO_MANY_ATTEMPTS';

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center rounded-xl border border-line bg-bg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gg">
        <span aria-hidden className="pl-3 text-[15px] text-muted">
          @
        </span>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value.toLowerCase().replace(/\s+/g, ''))}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={USERNAME_MAX + 8}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={Boolean(message) || undefined}
          aria-describedby={`${id}-status`}
          className="h-10.5 min-w-0 flex-1 bg-transparent pr-3 pl-0.5 text-[15px] text-text outline-none disabled:opacity-50"
        />
      </div>
      <p id={`${id}-status`} aria-live="polite" className={`text-xs ${message ? 'text-danger' : available ? 'text-gg' : 'text-muted'}`}>
        {message ?? (available ? `@${name} is available.` : rateLimited ? 'Can’t check right now. You can still try it.' : (hint ?? '2 to 32 letters, numbers, underscores and dots.'))}
      </p>
    </div>
  );
}
