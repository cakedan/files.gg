import { Wand2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { sourceKindOf, type SourceKind } from '../../lib/convertKinds';
import type { FormatsDocument } from '../../lib/conversions';
import type { PickerContext } from '../../lib/upload/options';
import { pluralize } from '../files/fileLabels';
import { UploadOptions } from '../upload/UploadOptions';
import { ConvertSignIn } from './ConvertSignIn';
import { OptionsForm } from './OptionsForm';
import { batchTargets, formErrors, initialState, requestOptions, targetsFor, type FieldValue, type FormState, type Picked } from './options';
import { useOutputPickers } from './output';
import type { ConvertChoice } from './SingleForm';
import { TargetPicker } from './TargetPicker';

/** The "several images → one PDF" chip (§1.2's last row), next to the batch targets. */
export const COMBINE_PDF = 'images:pdf';

export type BatchChoice = ConvertChoice & { combine: boolean };

/**
 * §13.1 "Batch": a target picker for the kinds selected (one target, with the options every
 * one of those kinds accepts), and "One PDF" for the images, then the new files' access and
 * expiry (§21). `onStart` sends the batch, or the images → PDF conversion.
 */
export function BatchForm({
  formats,
  files,
  anonymous,
  outputContext,
  starting,
  onStart,
  error,
}: {
  formats: FormatsDocument;
  files: OwnerFile[];
  anonymous: boolean;
  /** Sign-in state, limits and the account's upload defaults, for the output pickers. */
  outputContext: PickerContext;
  starting: boolean;
  onStart: (choice: BatchChoice) => void;
  error: ReactNode;
}) {
  const kinds = new Map<SourceKind, number>();
  for (const file of files) {
    const kind = sourceKindOf(file);
    if (kind) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const images = kinds.get('image') ?? 0;
  const targets = batchTargets(formats, [...kinds.keys()]);
  const combine = images >= 2 ? targetsFor(formats, 'images').find((each) => each.target === 'pdf') : undefined;
  const choices = [
    ...(combine ? [{ target: COMBINE_PDF, label: combine.label, allowed: true, note: `Puts the ${pluralize(images, 'image')} into one PDF, in order.` }] : []),
    ...targets.map((each) => {
      const count = each.kinds.reduce((sum, kind) => sum + (kinds.get(kind as SourceKind) ?? 0), 0);
      return { target: each.target, label: each.label, allowed: !anonymous, note: `${count} of ${pluralize(files.length, 'file')} can be converted to ${each.label}.` };
    }),
  ];

  const [picked, setPicked] = useState<Picked>(null);
  const targetName = picked?.type === 'target' ? picked.target : null;
  const options = targetName === COMBINE_PDF ? (combine?.options ?? []) : (targets.find((each) => each.target === targetName)?.options ?? []);
  const [form, setForm] = useState<{ key: string; state: FormState } | null>(null);
  const state = form?.key === targetName ? form.state : initialState(options);
  const errors = formErrors(options, state);
  const locked = Boolean(targetName && targetName !== COMBINE_PDF && anonymous);
  const change = (name: string, value: FieldValue) => setForm({ key: targetName ?? '', state: { ...state, [name]: value } });
  // §5.3 is per source: one PDF is protected when any image is; a batch starts protected when every file is.
  const isProtected = (file: OwnerFile) => file.visibility !== 'link';
  const protectedCount = files.filter(isProtected).length;
  const combining = targetName === COMBINE_PDF;
  const protectedImages = files.some((file) => sourceKindOf(file) === 'image' && isProtected(file));
  const output = useOutputPickers(outputContext, combining ? protectedImages : protectedCount === files.length);
  const mixed = !combining && protectedCount > 0 && protectedCount < files.length;

  if (choices.length === 0) return <p className="text-sm text-muted">None of these files can be converted.</p>;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="batch-target" className="flex flex-col gap-3">
        <h2 id="batch-target" className="text-sm font-semibold">
          Convert {pluralize(files.length, 'file')} to
        </h2>
        <TargetPicker presets={[]} targets={choices} picked={picked} onPick={setPicked} signIn={<ConvertSignIn>Sign in to convert in bulk</ConvertSignIn>} />
      </section>
      {targetName && !locked && options.length > 0 && (
        <section aria-labelledby="batch-options" className="flex flex-col gap-3">
          <h2 id="batch-options" className="text-sm font-semibold">
            Options
          </h2>
          <OptionsForm options={options} state={state} errors={errors} onChange={change} facts={{ size: null, duration: null, hasAudio: true, pages: null }} />
        </section>
      )}
      {targetName && !locked && (
        <section aria-labelledby="batch-output" className="flex flex-col gap-3">
          <h2 id="batch-output" className="text-sm font-semibold">
            {combining ? 'New file' : 'New files'}
          </h2>
          <UploadOptions conversion state={output.state} onChange={output.onChange} context={outputContext} errors={output.errors} />
          {mixed && <p className="text-xs text-muted">Left as they are, these choices apply to the files anyone with the link can open; the others’ new files are only for you.</p>}
        </section>
      )}
      <div className="flex flex-col gap-2">
        <div>
          <Button
            variant="primary"
            disabled={!targetName || locked || Object.keys(errors).length > 0 || Object.keys(output.errors).length > 0 || starting}
            onClick={() =>
              targetName &&
              onStart({ combine: combining, target: combining ? 'pdf' : targetName, options: requestOptions(options, state), output: output.params })
            }
          >
            <Wand2 aria-hidden className="size-4" />
            {starting ? 'Starting…' : 'Convert'}
          </Button>
        </div>
        {error}
      </div>
    </div>
  );
}
