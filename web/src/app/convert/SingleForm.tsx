import { Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '../../components/Button';
import type { ConversionKind, ConversionOutputParams, FormatOption, FormatsDocument, OptionValue } from '../../lib/conversions';
import type { PickerContext } from '../../lib/upload/options';
import { UploadOptions } from '../upload/UploadOptions';
import { ConvertSignIn } from './ConvertSignIn';
import { OptionsForm, type SourceFacts } from './OptionsForm';
import { formErrors, initialState, presetsFor, requestOptions, targetsFor, type FieldValue, type FormState, type Picked } from './options';
import { useOutputPickers } from './output';
import { TargetPicker } from './TargetPicker';

export interface ConvertChoice {
  target: string;
  options: Record<string, OptionValue>;
  /** The new file's access, expiry and view limit; empty while untouched (milestone-5 §21). */
  output: ConversionOutputParams;
}

/**
 * §13.1 steps 2 to 4 for one source: the target chips (presets first), the options form
 * generated from the formats document, the new file's access and expiry (§21), and Convert.
 */
export function SingleForm({
  formats,
  kind,
  extension,
  facts,
  anonymous,
  outputContext,
  protectedSource,
  initialPick,
  starting,
  onConvert,
  error,
}: {
  formats: FormatsDocument;
  kind: ConversionKind;
  extension: string | null;
  facts: SourceFacts;
  anonymous: boolean;
  /** Sign-in state, limits and the account's upload defaults, for the output pickers. */
  outputContext: PickerContext;
  /** The source isn't `link`, so its output starts protected (§5.3). */
  protectedSource: boolean;
  initialPick: Picked;
  starting: boolean;
  onConvert: (choice: ConvertChoice) => void;
  error: ReactNode;
}) {
  const presets = presetsFor(formats, kind, extension);
  const targets = targetsFor(formats, kind);
  const [picked, setPicked] = useState<Picked>(initialPick);
  const preset = picked?.type === 'preset' ? presets.find((each) => each.id === picked.id) : undefined;
  const targetName = preset?.resolved ?? (picked?.type === 'target' ? picked.target : null);
  const target = targets.find((each) => each.target === targetName) ?? null;
  const options: FormatOption[] = target?.options ?? [];
  const pickKey = picked ? `${picked.type}:${picked.type === 'preset' ? picked.id : picked.target}` : '';
  const [form, setForm] = useState<{ key: string; state: FormState } | null>(null);
  const state = form?.key === pickKey ? form.state : initialState(options, preset?.options);
  const errors = formErrors(options, state, { pages: facts.pages });
  const locked = Boolean(target && anonymous && !target.anonymous);
  const output = useOutputPickers(outputContext, protectedSource);
  const invalid = Object.keys(errors).length > 0 || Object.keys(output.errors).length > 0;

  const change = (name: string, value: FieldValue) => setForm({ key: pickKey, state: { ...state, [name]: value } });

  if (targets.length === 0) return <p className="text-sm text-muted">This file can’t be converted.</p>;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="convert-target" className="flex flex-col gap-3">
        <h2 id="convert-target" className="text-sm font-semibold">
          Convert to
        </h2>
        <TargetPicker
          presets={presets}
          targets={targets.map((each) => ({ target: each.target, label: each.label, allowed: !anonymous || each.anonymous }))}
          picked={picked}
          onPick={setPicked}
          signIn={<ConvertSignIn>Sign in</ConvertSignIn>}
        />
      </section>

      {target && !locked && (
        <section aria-labelledby="convert-options" className="flex flex-col gap-3">
          <h2 id="convert-options" className="text-sm font-semibold">
            Options
          </h2>
          <OptionsForm options={options} state={state} errors={errors} onChange={change} facts={facts} />
        </section>
      )}

      {target && !locked && (
        <section aria-labelledby="convert-output" className="flex flex-col gap-3">
          <h2 id="convert-output" className="text-sm font-semibold">
            New file
          </h2>
          <UploadOptions conversion state={output.state} onChange={output.onChange} context={outputContext} errors={output.errors} />
        </section>
      )}

      <div className="flex flex-col gap-2">
        <div>
          <Button variant="primary" disabled={!target || locked || invalid || starting} onClick={() => target && onConvert({ target: target.target, options: requestOptions(options, state), output: output.params })}>
            <Wand2 aria-hidden className="size-4" />
            {starting ? 'Starting…' : target ? `Convert to ${target.label}` : 'Pick a format'}
          </Button>
        </div>
        {error}
      </div>
    </div>
  );
}
