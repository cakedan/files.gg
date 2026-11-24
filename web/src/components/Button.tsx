import type { ComponentPropsWithRef } from 'react';

import { buttonClass, type ButtonVariant } from './buttonClass';

export type { ButtonVariant } from './buttonClass';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'secondary', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}

interface LinkButtonProps extends ComponentPropsWithRef<'a'> {
  variant?: ButtonVariant;
}

export function LinkButton({ variant = 'secondary', className = '', ...rest }: LinkButtonProps) {
  return <a className={buttonClass(variant, className)} {...rest} />;
}
