/**
 * The Convert page's form logic (milestone-5 §1.2, §10.1, §13.1), pure and tested: the
 * targets and presets for a source, the form state for a target's options, validation,
 * the `options` sent to `POST /conversions`, and the target-size estimate.
 */

import type { ConversionKind, EnumValue, FormatOption, FormatPreset, FormatTarget, FormatsDocument, OptionValue } from '../../lib/conversions';

// ---------------------------------------------------------------------------
// Targets and presets
// ---------------------------------------------------------------------------

export const targetsFor = (formats: FormatsDocument | undefined, kind: ConversionKind | null): FormatTarget[] =>
  (kind && formats?.kinds[kind]?.targets) || [];

/** `jpeg` and `jpg` are one target; everything else is its extension. */
const targetOfExtension = (extension: string) => {
  const ext = extension.toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
};

export interface ResolvedPreset extends FormatPreset {
  /** The real target (`same` resolved to the source's format). */
  resolved: string;
}

/**
 * The presets for a kind, first on the page (§13.1). `"target": "same"` is the source's own
 * format; a preset whose target the source can't get (an HEIC has no `heic` target) is left out.
 */
export function presetsFor(formats: FormatsDocument | undefined, kind: ConversionKind | null, sourceExtension: string | null): ResolvedPreset[] {
  if (!formats || !kind || kind === 'images') return [];
  const targets = new Set(targetsFor(formats, kind).map((target) => target.target));
  const out: ResolvedPreset[] = [];
  for (const preset of formats.presets) {
    if (!preset.kinds.includes(kind)) continue;
    const resolved = preset.target === 'same' ? (sourceExtension ? targetOfExtension(sourceExtension) : '') : preset.target;
    if (targets.has(resolved)) out.push({ ...preset, resolved });
  }
  return out;
}

/** What the target chips have picked: a preset, a target, or nothing yet. */
export type Picked = { type: 'preset'; id: string } | { type: 'target'; target: string } | null;

/** The pick a link asked for (`?preset=` or `?target=`, §13.2), once the formats are known. */
export function pickFromLink(formats: FormatsDocument | undefined, kind: ConversionKind | null, extension: string | null, preset: string | null, target: string | null): Picked {
  if (preset && presetsFor(formats, kind, extension).some((each) => each.id === preset)) return { type: 'preset', id: preset };
  if (target && targetsFor(formats, kind).some((each) => each.target === target)) return { type: 'target', target };
  return null;
}

// ---------------------------------------------------------------------------
// Form state: one entry per option, as the control holds it
// ---------------------------------------------------------------------------

/**
 * - `int`, `number`, `pages`: the text typed (`''` is the default: "none" or "all");
 * - `bool`: a boolean;
 * - `enum`: the value as a string (`''` is "none" when the default is null);
 * - `color`: `#rrggbb`;
 * - `size`: `''` (none), `preset:<name>`, or MB as text.
 */
export type FieldValue = string | boolean;
export type FormState = Record<string, FieldValue>;

export const SIZE_PRESET_PREFIX = 'preset:';
/** §1.2: `discord` is 10 MB. Used when the formats document names no presets. */
export const DEFAULT_SIZE_PRESETS: Record<string, number> = { discord: 10 };

export const sizePresets = (option: FormatOption): Record<string, number> => option.presets ?? DEFAULT_SIZE_PRESETS;

/** The control's value for an option's value (a default, or a preset's). */
export function fieldValue(option: FormatOption, value: OptionValue | undefined): FieldValue {
  if (option.type === 'bool') return value === true;
  if (value === null || value === undefined) return '';
  if (option.type === 'size' && typeof value === 'string') return `${SIZE_PRESET_PREFIX}${value}`;
  return String(value);
}

/** The form for a target: every option at its default, then a preset's values on top. */
export function initialState(options: FormatOption[], preset: Record<string, OptionValue> = {}): FormState {
  const state: FormState = {};
  for (const option of options) state[option.name] = fieldValue(option, option.name in preset ? preset[option.name] : option.default);
  return state;
}

const PAGES = /^\s*\d+\s*(-\s*\d+\s*)?(,\s*\d+\s*(-\s*\d+\s*)?)*$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** `1-3,7` → `[[1, 3], [7, 7]]`, or null when it isn't a list of increasing ranges from 1. */
export function parsePages(text: string): Array<[number, number]> | null {
  if (!PAGES.test(text)) return null;
  const ranges: Array<[number, number]> = [];
  for (const part of text.split(',')) {
    const [from, to = from] = part.split('-').map((each) => Number(each.trim())) as [number, number?];
    if (from < 1 || to! < from) return null;
    ranges.push([from, to!]);
  }
  return ranges;
}

/** How many pages a `pages` value picks, given the document's count. */
export function pageCount(text: string, total: number | null): number | null {
  if (!text.trim()) return total;
  const ranges = parsePages(text);
  if (!ranges) return null;
  const picked = new Set<number>();
  for (const [from, to] of ranges) for (let page = from; page <= Math.min(to, total ?? to); page++) picked.add(page);
  return picked.size;
}

const describeRange = (option: FormatOption) =>
  option.min !== undefined && option.max !== undefined ? ` (${option.min}–${option.max})` : option.min !== undefined ? ` (at least ${option.min})` : '';

/** Validates one control. Returns a message, or null. */
export function fieldError(option: FormatOption, value: FieldValue, context: { pages?: number | null } = {}): string | null {
  switch (option.type) {
    case 'bool':
      return null;
    case 'enum': {
      if (value === '') return option.default === null ? null : 'Pick one.';
      return (option.values ?? []).some((choice) => String(choice) === value) ? null : 'Pick one.';
    }
    case 'color':
      return COLOR.test(String(value)) ? null : 'Enter a colour like #ffffff.';
    case 'pages': {
      const text = String(value);
      if (!text.trim()) return null;
      const ranges = parsePages(text);
      if (!ranges) return 'Enter pages like 1-3,7.';
      if (context.pages && ranges.some(([from]) => from > context.pages!)) return `This PDF has ${context.pages} ${context.pages === 1 ? 'page' : 'pages'}.`;
      return null;
    }
    case 'size': {
      const text = String(value);
      if (text === '' || text.startsWith(SIZE_PRESET_PREFIX)) return null;
      return numberError(option, text, false);
    }
    case 'int':
    case 'number': {
      const text = String(value).trim();
      if (text === '') return option.default === null || option.default === undefined ? null : 'Enter a value.';
      return numberError(option, text, option.type === 'int');
    }
  }
  return null;
}

function numberError(option: FormatOption, text: string, integer: boolean): string | null {
  const n = Number(text);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return integer ? `Enter a whole number${describeRange(option)}.` : `Enter a number${describeRange(option)}.`;
  if ((option.min !== undefined && n < option.min) || (option.max !== undefined && n > option.max)) return `Enter a value${describeRange(option)}.`;
  return null;
}

/** Errors for the whole form, plus §1.2's rule that `trim_end` comes after `trim_start`. */
export function formErrors(options: FormatOption[], state: FormState, context: { pages?: number | null } = {}): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const option of options) {
    const error = fieldError(option, state[option.name] ?? fieldValue(option, option.default), context);
    if (error) errors[option.name] = error;
  }
  const start = state.trim_start;
  const end = state.trim_end;
  if (!errors.trim_start && !errors.trim_end && typeof end === 'string' && end.trim() !== '' && Number(end) <= Number(typeof start === 'string' && start.trim() ? start : 0)) {
    errors.trim_end = 'The end must be after the start.';
  }
  return errors;
}

/** The value an option's control stands for (`null` is "none"). */
export function optionValue(option: FormatOption, value: FieldValue): OptionValue {
  switch (option.type) {
    case 'bool':
      return value === true;
    case 'enum': {
      if (value === '') return null;
      return (option.values ?? []).find((choice) => String(choice) === value) ?? null;
    }
    case 'color':
      return String(value).toLowerCase();
    case 'pages':
      return String(value).trim() ? String(value).replace(/\s+/g, '') : null;
    case 'size': {
      const text = String(value);
      if (text === '') return null;
      if (text.startsWith(SIZE_PRESET_PREFIX)) return text.slice(SIZE_PRESET_PREFIX.length);
      return Number(text);
    }
    case 'int':
    case 'number': {
      const text = String(value).trim();
      return text === '' ? null : Number(text);
    }
  }
  return null;
}

/**
 * `options` for `POST /conversions`: only what differs from the defaults, since the API
 * fills every default itself (§6) and never drops an option silently (§1.2).
 */
export function requestOptions(options: FormatOption[], state: FormState): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  for (const option of options) {
    const value = optionValue(option, state[option.name] ?? fieldValue(option, option.default));
    const fallback = option.default ?? null;
    if (value === fallback || (value === null && fallback === null)) continue;
    out[option.name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batch: options every selected kind accepts for a target
// ---------------------------------------------------------------------------

export interface BatchTarget {
  target: string;
  label: string;
  /** Kinds (of those selected) that have this target. */
  kinds: ConversionKind[];
  anonymous: boolean;
  /**
   * Options with the same name and type in every kind that has this target, so one
   * `options` object is valid for every item (§1.2: an option that doesn't apply is refused).
   */
  options: FormatOption[];
}

export function batchTargets(formats: FormatsDocument | undefined, kinds: ConversionKind[]): BatchTarget[] {
  const byTarget = new Map<string, BatchTarget>();
  for (const kind of kinds) {
    for (const target of targetsFor(formats, kind)) {
      const existing = byTarget.get(target.target);
      if (!existing) {
        byTarget.set(target.target, { target: target.target, label: target.label, kinds: [kind], anonymous: target.anonymous, options: target.options });
        continue;
      }
      existing.kinds.push(kind);
      existing.anonymous &&= target.anonymous;
      existing.options = existing.options.filter((option) => target.options.some((other) => other.name === option.name && other.type === option.type));
    }
  }
  return [...byTarget.values()];
}

// ---------------------------------------------------------------------------
// The target-size estimate (§1.2 `target_size`, §13.1 step 3)
// ---------------------------------------------------------------------------

/** §1.2: below this the API answers `TARGET_SIZE_TOO_SMALL`. */
export const MIN_VIDEO_KBPS = 100;
/** The audio bitrate the estimate assumes for AAC/Opus. */
export const ESTIMATE_AUDIO_KBPS = 128;

/** The smallest workable `target_size` in MB for a video of `durationMs`, rounded up. */
export function minimumTargetMb(durationMs: number, hasAudio: boolean): number {
  const seconds = durationMs / 1000;
  const kbps = MIN_VIDEO_KBPS + (hasAudio ? ESTIMATE_AUDIO_KBPS : 0);
  const bytes = (kbps * 1000 * seconds) / 8 / 0.97;
  return Math.max(1, Math.ceil(bytes / 1_000_000));
}

/** The size a target-size option asks for, in MB, or null for none. */
export function targetSizeMb(option: FormatOption, value: FieldValue): number | null {
  const resolved = optionValue(option, value);
  if (typeof resolved === 'number') return resolved;
  if (typeof resolved === 'string') return sizePresets(option)[resolved] ?? null;
  return null;
}

export type EnumChoice = { value: string; label: string };

/** An enum's choices, with "Original" first when the default is none. */
export function enumChoices(option: FormatOption): EnumChoice[] {
  const choices: EnumChoice[] = (option.values ?? []).map((value: EnumValue) => ({ value: String(value), label: enumLabel(option, value) }));
  return option.default === null ? [{ value: '', label: 'Original' }, ...choices] : choices;
}

const ENUM_WORDS: Record<string, string> = { fit: 'Fit each image', a4: 'A4', letter: 'Letter' };

function enumLabel(option: FormatOption, value: EnumValue): string {
  if (typeof value === 'number') {
    if (option.name === 'max_height') return `${value}p`;
    if (option.name === 'bitrate') return `${value} kbps`;
    return String(value);
  }
  return ENUM_WORDS[value] ?? value;
}
