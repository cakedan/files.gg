export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * `md` is the standard 42px control (DESIGN.md, Components → Buttons). `sm` is for dense rows and
 * banners; `icon` is a square `md` for icon-only buttons. Pick a size instead of overriding height or
 * padding with `extra`: two utilities for the same property don't reliably override each other.
 */
export type ButtonSize = 'md' | 'sm' | 'icon';

const BASE =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50';

const SIZES: Record<ButtonSize, string> = {
  md: 'h-10.5 px-4 text-[15px]',
  sm: 'h-8 px-2.5 text-sm',
  icon: 'size-10.5 text-[15px]',
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-gg text-gg-ink hover:bg-gg-end',
  secondary: 'bg-surface-2 text-text hover:bg-line',
  danger: 'bg-danger-fill text-white hover:bg-danger-fill-hover',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
};

export function buttonClass(variant: ButtonVariant = 'secondary', extra = '', size: ButtonSize = 'md'): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${extra}`.trim();
}
