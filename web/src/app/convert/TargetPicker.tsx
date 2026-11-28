import { Lock, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Picked, ResolvedPreset } from './options';

export interface TargetChoice {
  target: string;
  label: string;
  /** False when the caller can't use it (anonymous `document → pdf`, §7.1). */
  allowed: boolean;
  /** A line under the chips when picked (batch: "3 of 5 files"). */
  note?: string | undefined;
}

function ChoiceChip({ pressed, onClick, children, locked = false }: { pressed: boolean; onClick: () => void; children: ReactNode; locked?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex h-8.5 items-center gap-1.5 rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors ${
        pressed ? 'border-gg/60 bg-gg/10 text-gg' : locked ? 'border-dashed border-line text-muted hover:bg-surface-2' : 'border-line text-text hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * §13.1 step 2: the presets first, then every target as a chip. A target the caller
 * can't use shows a lock and "Sign in" (`signIn` renders that link).
 */
export function TargetPicker({
  presets,
  targets,
  picked,
  onPick,
  signIn,
}: {
  presets: ResolvedPreset[];
  targets: TargetChoice[];
  picked: Picked;
  onPick: (picked: Picked) => void;
  signIn: ReactNode;
}) {
  const pickedChoice = picked?.type === 'target' ? targets.find((each) => each.target === picked.target) : undefined;
  const lockedPicked = pickedChoice?.allowed === false;
  return (
    <div className="flex flex-col gap-3">
      {presets.length > 0 && (
        <div role="group" aria-label="Common goals" className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <ChoiceChip key={preset.id} pressed={picked?.type === 'preset' && picked.id === preset.id} onClick={() => onPick({ type: 'preset', id: preset.id })}>
              <Sparkles aria-hidden className="size-3.5 text-gg" />
              {preset.label}
            </ChoiceChip>
          ))}
        </div>
      )}
      <div role="group" aria-label="Formats" className="flex flex-wrap gap-2">
        {targets.map((choice) => (
          <ChoiceChip
            key={choice.target}
            pressed={picked?.type === 'target' && picked.target === choice.target}
            locked={!choice.allowed}
            onClick={() => onPick({ type: 'target', target: choice.target })}
          >
            {!choice.allowed && <Lock aria-label="Needs an account" className="size-3.5" />}
            {choice.label}
            {!choice.allowed && <span className="text-xs text-gg">Sign in</span>}
          </ChoiceChip>
        ))}
      </div>
      {pickedChoice?.note && <p className="text-xs text-muted">{pickedChoice.note}</p>}
      {lockedPicked && (
        <p className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm" role="status">
          <Lock aria-hidden className="size-4 text-muted" />
          This needs an account. {signIn}
        </p>
      )}
    </div>
  );
}
