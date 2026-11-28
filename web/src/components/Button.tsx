import type { ComponentPropsWithRef } from 'react';

import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonClass';

export type { ButtonSize, ButtonVariant } from './buttonClass';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className, size)} {...rest} />;
}

interface LinkButtonProps extends ComponentPropsWithRef<'a'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function LinkButton({ variant = 'secondary', size = 'md', className = '', ...rest }: LinkButtonProps) {
  return <a className={buttonClass(variant, className, size)} {...rest} />;
}
