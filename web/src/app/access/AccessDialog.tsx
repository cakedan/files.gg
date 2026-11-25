import { KeyRound, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import type { OwnerAlbum, OwnerFile } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  breaksPasswordLinks,
  canKeepPassword,
  fileLifeSeconds,
  initialAccessForm,
  linkWithPassword,
  resolveAccessForm,
  type AccessFormState,
} from '../../lib/files/accessForm';
import { useSetAccess, type AccessTarget } from '../../lib/queries';
import { accessChoices, passwordExpiryChoices, unlockTtlChoices } from '../../lib/upload/options';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/toastContext';
import { PasswordFields, VisibilityField } from './AccessFields';

export type AccessDialogTarget =
  | { kind: 'file'; file: OwnerFile }
  | { kind: 'files'; files: OwnerFile[] }
  | { kind: 'album'; album: OwnerAlbum };

interface AccessDialogProps {
  target: AccessDialogTarget;
  anonymous: boolean;
  onClose: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Change access…" for one file, a selection or an album (contract §6, PLAN.md
 * Phase 3): the three levels; a password (typed or generated, shown once); "Stay
 * unlocked for" and "Password works until"; and "Show name on lock screen".
 */
export function AccessDialog({ target, anonymous, onClose }: AccessDialogProps) {
  const id = useId();
  const notify = useToast();
  const mutation = useSetAccess();

  const { currents, subject, apiTarget, links } = useMemo(() => {
    if (target.kind === 'album') {
      const { album } = target;
      return {
        currents: [album],
        subject: album.title || 'Untitled album',
        apiTarget: { kind: 'album', ids: [album.id] } satisfies AccessTarget,
        links: [album.url],
      };
    }
    const files = target.kind === 'file' ? [target.file] : target.files;
    return {
      currents: files,
      subject: target.kind === 'file' ? target.file.filename : plural(files.length, 'file', 'files'),
      apiTarget: { kind: target.kind, ids: files.map((file) => file.id) } satisfies AccessTarget,
      links: files.map((file) => file.url),
    };
  }, [target]);

  const [state, setState] = useState<AccessFormState>(() => initialAccessForm(currents));
  const [submitted, setSubmitted] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const bulk = target.kind === 'files';
  const { body, errors } = resolveAccessForm(state, { anonymous, currents, bulk });
  const shownErrors = submitted ? errors : {};
  const life = fileLifeSeconds(currents);
  const keep = canKeepPassword(currents);
  const isAlbum = target.kind === 'album';

  const save = () => {
    setSubmitted(true);
    if (!body) return;
    mutation.mutate(
      { target: apiTarget, body },
      {
        onSuccess: (result) => {
          if (result.password) {
            setGenerated(result.password);
            return;
          }
          notify(isAlbum ? 'Album access updated.' : `Access updated for ${subject}.`);
          onClose();
        },
      },
    );
  };

  if (generated) {
    const withPassword = links.map((link) => linkWithPassword(link, generated));
    return (
      <Dialog
        title="Password set"
        description={bulk ? `One password now opens all ${subject}.` : `The new password for ${subject}.`}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
            <KeyRound aria-hidden className="size-4 shrink-0 text-warn" />
            <span>
              Password: <code className="font-mono font-semibold break-all">{generated}</code>
            </span>
            <p className="w-full text-xs text-muted">Shown once. files.gg can't show it again, only reset it.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={generated} label="Copy password" variant="secondary" />
            <CopyButton
              text={withPassword.join('\n')}
              label={withPassword.length > 1 ? 'Copy links with password' : 'Copy link with password'}
              variant="primary"
            />
          </div>
        </div>
      </Dialog>
    );
  }

  const patch = (next: Partial<AccessFormState>) => setState((current) => ({ ...current, ...next }));

  return (
    <Dialog
      title="Change access"
      description={subject}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <VisibilityField
          name={`${id}-visibility`}
          value={state.visibility}
          choices={accessChoices({ anonymous })}
          onChange={(visibility) => patch({ visibility })}
          error={shownErrors.visibility}
        />

        {state.visibility === 'password' && (
          <>
            <PasswordFields
              idPrefix={id}
              state={state}
              onChange={patch}
              onTimingChange={() => patch({ timingTouched: true })}
              errors={shownErrors}
              unlockChoices={unlockTtlChoices(life)}
              passwordExpiryChoices={passwordExpiryChoices({ anonymous }, life)}
              generateHint={bulk ? `One passphrase for all ${subject}, shown once after saving.` : 'A passphrase is made for you and shown once after saving.'}
              passwordHint={keep ? 'Leave it empty to keep the current password.' : '6–128 characters.'}
              placeholder={keep ? 'Keep the current password' : ''}
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={state.showName} onChange={(event) => patch({ showName: event.target.checked })} className="accent-gg" />
              {isAlbum ? 'Show the title on the lock screen' : 'Show the name on the lock screen'}
            </label>
            {bulk && state.passwordExpiry === 'never' && currents.some((c) => c.password_expires_at !== null) && (
              <p className="text-xs text-muted">Files whose password already stops working at a set time keep that time.</p>
            )}
          </>
        )}

        {breaksPasswordLinks(state, currents) && (
          <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            Changing this breaks existing password links. Anyone who unlocked {isAlbum ? 'the album' : bulk ? 'these files' : 'the file'} will need the new
            password.
          </p>
        )}

        {mutation.isError && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
