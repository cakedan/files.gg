import { Check, Link2, X } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { useCopyState } from './useCopyState';

const LABELS = {
  idle: null,
  copied: 'Copied!',
  failed: 'Copy failed',
} as const;

interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  text: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * A square icon button: the label becomes its accessible name and tooltip, the icon shows the
   * state (link, tick, cross), and "Copied!" / "Copy failed" is still announced.
   */
  iconOnly?: boolean;
  /** Extra classes for the icon, e.g. a green link icon on a grey button (dropped on failure). */
  iconClassName?: string;
  copy?: (text: string) => Promise<boolean>;
}

export function CopyButton({ text, label = 'Copy link', variant = 'primary', iconOnly = false, iconClassName = '', copy, ...rest }: CopyButtonProps) {
  const { state, copy: trigger } = useCopyState(copy);
  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Link2;
  const status = LABELS[state];
  return (
    <Button
      type="button"
      variant={state === 'failed' ? 'danger' : variant}
      onClick={() => void trigger(text)}
      {...(iconOnly ? { size: 'icon' as const, 'aria-label': label, title: status ?? label } : {})}
      {...rest}
    >
      <Icon aria-hidden className={`${iconOnly ? 'size-5' : 'size-4'} ${state === 'failed' ? '' : iconClassName}`.trim()} />
      {iconOnly ? (
        <span aria-live="polite" className="sr-only">
          {status ?? ''}
        </span>
      ) : (
        <span aria-live="polite">{status ?? label}</span>
      )}
    </Button>
  );
}
