import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import type { UploadDefaults, User, Visibility } from '../../lib/api';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { useMyLimits } from '../../lib/queries';
import { setSessionUser } from '../../lib/session';
import { accessChoices, canMarkNsfw, expiryChoices, type Choice, type PickerContext } from '../../lib/upload/options';
import { Field, VisibilityField } from '../access/AccessFields';
import { fieldClass } from '../access/fieldUtils';
import { Panel, Result } from './Panel';

const HOUR = 3600;
const DAY = 24 * HOUR;
const FIELD = 'settings.upload_defaults';

/** "3 days", "5 hours": a stored expiry that isn't one of the presets. */
function durationLabel(seconds: number): string {
  if (seconds % DAY === 0) return `${seconds / DAY} ${seconds === DAY ? 'day' : 'days'}`;
  const hours = Math.round(seconds / HOUR);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Never (when allowed) and the Upload page's presets, plus the saved value when it's none of them. */
function defaultExpiryChoices(context: PickerContext, saved: number | null): Array<Choice<number | null>> {
  const choices: Array<Choice<number | null>> = expiryChoices(context).flatMap((choice) =>
    choice.value === 'custom' ? [] : [{ value: choice.value === 'never' ? null : choice.value, label: choice.label }],
  );
  if (!choices.some((choice) => choice.value === saved) && saved !== null) choices.push({ value: saved, label: durationLabel(saved) });
  return choices;
}

const ACCESS_LABELS: Record<Visibility, string> = {
  link: 'Anyone with the link',
  password: 'Password: a new one generated for each file',
  private: 'Only me',
};

/**
 * Settings → Uploads (milestone-5 §21): the expiry, access and adult-content mark that upload keys
 * (ShareX, curl) and conversions get when they don't say, and where the Upload and Convert pages start.
 */
export default function UploadsTab({ user }: { user: User }) {
  const id = useId();
  const client = useQueryClient();
  const limits = useMyLimits();
  const saved = user.settings.upload_defaults;
  const [draft, setDraft] = useState<UploadDefaults>(saved);
  const [message, setMessage] = useState<string | null>(null);
  const context: PickerContext = { anonymous: false, limits: limits.data ?? null };
  const save = useMutation({
    mutationFn: (values: UploadDefaults) => accountApi.updateMe({ settings: { upload_defaults: values } }),
    onSuccess: (updated) => {
      setSessionUser(client, updated);
      setDraft(updated.settings.upload_defaults);
      setMessage('Upload defaults saved.');
    },
  });
  const errors = fieldErrors(save.error);
  const changed = draft.expires_in !== saved.expires_in || draft.visibility !== saved.visibility || draft.nsfw !== saved.nsfw;
  const nsfwAllowed = canMarkNsfw(context);
  const change = (patch: Partial<UploadDefaults>) => {
    setMessage(null);
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Upload defaults"
        description="Uploads from your upload keys (ShareX, curl) and your conversions get these unless they say otherwise. The Upload and Convert pages start from them."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed) save.mutate(draft);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Expires" htmlFor={`${id}-expiry`} error={errors[`${FIELD}.expires_in`]}>
              <select
                id={`${id}-expiry`}
                value={String(draft.expires_in)}
                onChange={(event) => change({ expires_in: event.target.value === 'null' ? null : Number(event.target.value) })}
                className={fieldClass}
              >
                {defaultExpiryChoices(context, draft.expires_in).map((choice) => (
                  <option key={String(choice.value)} value={String(choice.value)}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>
            <VisibilityField
              name={`${id}-access`}
              value={draft.visibility}
              choices={accessChoices(context).map((choice) => ({ ...choice, label: ACCESS_LABELS[choice.value] }))}
              onChange={(visibility) => change({ visibility })}
              error={errors[`${FIELD}.visibility`]}
            />
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={draft.nsfw}
              disabled={!nsfwAllowed && !draft.nsfw}
              onChange={(event) => change({ nsfw: event.target.checked })}
              className="mt-0.5 accent-gg"
            />
            <span>
              Mark uploads as adult content
              <span className="block text-xs text-muted">
                {nsfwAllowed
                  ? 'Visitors see a warning before they open. Conversions follow the file they came from instead.'
                  : 'Your account can’t mark uploads as adult content right now.'}
              </span>
            </span>
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save defaults'}
            </Button>
          </div>
          {save.isError && !Object.keys(errors).some((field) => field.startsWith(FIELD)) && <Result error={errorMessage(save.error)} />}
        </form>
      </Panel>
      <div aria-live="polite">{message && <Result success={message} />}</div>
    </div>
  );
}
