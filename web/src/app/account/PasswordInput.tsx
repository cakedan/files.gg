import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentPropsWithRef } from 'react';

import { passwordScore, STRENGTH_LABELS } from '../../lib/passwordStrength';
import { fieldClass } from '../access/fieldUtils';

const BARS = ['bg-danger', 'bg-danger', 'bg-warn', 'bg-gg', 'bg-gg'] as const;

/** A password field with Show/Hide. */
export function PasswordInput({ className = '', ...rest }: Omit<ComponentPropsWithRef<'input'>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input type={shown ? 'text' : 'password'} className={`${fieldClass} w-full pr-10 ${className}`} spellCheck={false} {...rest} />
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted hover:text-text"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}

/** The strength meter under a new password (§2.6). Minimum 8 characters, no maximum. */
export function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const score = passwordScore(password);
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label="Password strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={STRENGTH_LABELS[score]}
        className="flex h-1.5 flex-1 gap-1"
      >
        {[0, 1, 2, 3].map((bar) => (
          <span key={bar} className={`h-full flex-1 rounded-full ${bar < Math.max(1, score) ? BARS[score] : 'bg-surface-2'}`} />
        ))}
      </div>
      <span className="w-20 text-right text-xs text-muted">{STRENGTH_LABELS[score]}</span>
    </div>
  );
}
