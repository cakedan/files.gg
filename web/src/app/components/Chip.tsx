import type { ReactNode } from 'react';

/** A toggle chip for filters (`aria-pressed`). */
export function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`h-8.5 rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors ${
        pressed ? 'border-gg/60 bg-gg/10 text-gg' : 'border-line text-muted hover:bg-surface-2 hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}
