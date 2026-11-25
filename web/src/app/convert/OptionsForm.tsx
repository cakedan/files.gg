import { useId } from 'react';

import type { FormatOption } from '../../lib/conversions';
import { formatBytes } from '../../lib/format';
import { Field } from '../access/AccessFields';
import { fieldClass } from '../access/fieldUtils';
import { enumChoices, minimumTargetMb, SIZE_PRESET_PREFIX, sizePresets, targetSizeMb, type FieldValue, type FormState } from './options';

const PRESET_LABELS: Record<string, string> = { discord: 'Discord' };
/** Decimal, as `formatBytes` and the API's `target_size` use it. */
const MB = 1_000_000;

/** What the form knows about the source, for hints and the size estimate (§13.1 step 3). */
export interface SourceFacts {
  size: number | null;
  /** Milliseconds. */
  duration: number | null;
  hasAudio: boolean;
  pages: number | null;
}

function placeholderFor(option: FormatOption): string {
  if (option.type === 'pages') return 'All pages';
  if (option.default === null) return option.name.startsWith('trim') ? (option.name === 'trim_end' ? 'End' : '0') : 'Original';
  return String(option.default);
}

function hintFor(option: FormatOption): string | undefined {
  if (option.help) return option.help;
  if ((option.type === 'int' || option.type === 'number') && option.min !== undefined && option.max !== undefined) return `${option.min}–${option.max}`;
  if (option.type === 'pages') return 'Like 1-3,7';
  if (option.name.startsWith('trim_')) return 'Seconds';
  return undefined;
}

/** §1.2 `target_size`: none, a named size, or MB. */
function SizeControl({ option, value, onChange, id, facts, mute }: { option: FormatOption; value: string; onChange: (value: string) => void; id: string; facts: SourceFacts; mute: boolean }) {
  const presets = sizePresets(option);
  const custom = value !== '' && !value.startsWith(SIZE_PRESET_PREFIX);
  const mode = custom ? 'custom' : value;
  const mb = targetSizeMb(option, value);
  const minimum = facts.duration ? minimumTargetMb(facts.duration, facts.hasAudio && !mute) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <select
          id={id}
          value={mode}
          onChange={(event) => onChange(event.target.value === 'custom' ? String(option.min ?? 8) : event.target.value)}
          className={`${fieldClass} min-w-0 flex-1`}
        >
          <option value="">No size limit</option>
          {Object.entries(presets).map(([name, size]) => (
            <option key={name} value={`${SIZE_PRESET_PREFIX}${name}`}>
              {PRESET_LABELS[name] ?? name} ({size} MB)
            </option>
          ))}
          <option value="custom">Custom size</option>
        </select>
        {custom && (
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              aria-label={`${option.label} in MB`}
              min={option.min}
              max={option.max}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              className={`${fieldClass} w-24`}
            />
            <span className="text-sm text-muted">MB</span>
          </span>
        )}
      </div>
      {mb !== null && (
        <p className="text-xs text-muted" data-testid="size-estimate">
          {facts.size
            ? mb * MB >= facts.size
              ? `${formatBytes(facts.size)} now: already under ${formatBytes(mb * MB)}, so it stays about the same size.`
              : `${formatBytes(facts.size)} now, about ${formatBytes(mb * MB)} after.`
            : `About ${formatBytes(mb * MB)} after.`}
          {minimum !== null && mb < minimum && <span className="text-warn"> That may be too small for this video: try at least {minimum} MB.</span>}
        </p>
      )}
    </div>
  );
}

/** One control per option, by `type` (§10.1). */
function Control({ option, value, onChange, id, facts, state }: { option: FormatOption; value: FieldValue; onChange: (value: FieldValue) => void; id: string; facts: SourceFacts; state: FormState }) {
  switch (option.type) {
    case 'bool':
      return (
        <label htmlFor={id} className="flex min-h-9 items-center gap-2 text-sm">
          <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-gg" />
          {option.label}
        </label>
      );
    case 'enum':
      return (
        <select id={id} value={String(value)} onChange={(event) => onChange(event.target.value)} className={fieldClass}>
          {enumChoices(option).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      );
    case 'color':
      return (
        <span className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${option.label} picker`}
            value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#ffffff'}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-bg p-1"
          />
          <input id={id} type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} spellCheck={false} className={`${fieldClass} w-28 font-mono`} />
        </span>
      );
    case 'size':
      return <SizeControl option={option} value={String(value)} onChange={onChange} id={id} facts={facts} mute={state.mute === true} />;
    case 'pages':
      return <input id={id} type="text" inputMode="numeric" value={String(value)} placeholder={placeholderFor(option)} onChange={(event) => onChange(event.target.value)} className={fieldClass} />;
    case 'int':
    case 'number':
      return (
        <input
          id={id}
          type="number"
          inputMode={option.type === 'int' ? 'numeric' : 'decimal'}
          step={option.type === 'int' ? 1 : 'any'}
          min={option.min}
          max={option.max}
          value={String(value)}
          placeholder={placeholderFor(option)}
          onChange={(event) => onChange(event.target.value)}
          className={fieldClass}
        />
      );
  }
}

/** The options form, generated from the target's option list (§13.1 step 3). */
export function OptionsForm({
  options,
  state,
  errors,
  onChange,
  facts,
}: {
  options: FormatOption[];
  state: FormState;
  errors: Record<string, string>;
  onChange: (name: string, value: FieldValue) => void;
  facts: SourceFacts;
}) {
  const id = useId();
  if (options.length === 0) return <p className="text-sm text-muted">This conversion has no options.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {options.map((option) => {
        const controlId = `${id}-${option.name}`;
        const value = state[option.name] ?? '';
        const control = <Control option={option} value={value} onChange={(next) => onChange(option.name, next)} id={controlId} facts={facts} state={state} />;
        if (option.type === 'bool') {
          return (
            <div key={option.name} className="flex flex-col gap-1">
              {control}
              {option.help && <p className="text-xs text-muted">{option.help}</p>}
            </div>
          );
        }
        return (
          <Field key={option.name} label={option.label} htmlFor={controlId} error={errors[option.name]} hint={hintFor(option)}>
            {control}
          </Field>
        );
      })}
    </div>
  );
}
