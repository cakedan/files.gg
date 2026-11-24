export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BASE =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-gg text-gg-ink hover:bg-gg-end',
  secondary: 'bg-surface-2 text-text hover:bg-line',
  danger: 'bg-danger text-white hover:bg-danger/85',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
};

export function buttonClass(variant: ButtonVariant = 'secondary', extra = ''): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}
