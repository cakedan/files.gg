import { Check, Link2, X } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { Button, type ButtonVariant } from './Button';
import { useCopyState } from './useCopyState';

const LABELS = {
  idle: null,
  copied: 'Copied!',
  failed: 'Copy Failed',
} as const;

interface CopyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> {
  text: string;
  label?: string;
  variant?: ButtonVariant;
  copy?: (text: string) => Promise<boolean>;
}

export function CopyButton({ text, label = 'Copy link', variant = 'primary', copy, ...rest }: CopyButtonProps) {
  const { state, copy: trigger } = useCopyState(copy);
  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Link2;
  return (
    <Button
      type="button"
      variant={state === 'failed' ? 'danger' : variant}
      onClick={() => void trigger(text)}
      {...rest}
    >
      <Icon aria-hidden className="size-4" />
      <span aria-live="polite">{LABELS[state] ?? label}</span>
    </Button>
  );
}
