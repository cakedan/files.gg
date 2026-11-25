import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import type { User } from '../../lib/api';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { setSessionUser } from '../../lib/session';
import { epochMs, formatDay } from '../../lib/time';
import { cleanDisplayName, DISPLAY_NAME_MAX, DISPLAY_NAME_REASON_TEXT, displayNameProblem, normalizeUsername, usernameProblem } from '../../lib/usernames';
import { fieldClass } from '../access/fieldUtils';
import { Avatar } from '../account/Avatar';
import { fullName } from '../account/avatarUtils';
import { UsernameField } from '../account/UsernameField';
import { Panel, Result } from './Panel';
import { renameAvailableAt } from './settingsUtils';

/** Settings → Profile (milestone-6 §2.2–§2.4, §8.1, §8.6). */
export default function ProfileTab({ user }: { user: User }) {
  const id = useId();
  const client = useQueryClient();
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const onSaved = (message: string) => (updated: User) => {
    setSessionUser(client, updated);
    setSaved(message);
  };
  const rename = useMutation({ mutationFn: (name: string) => accountApi.setUsername(name), onSuccess: onSaved('Username saved.') });
  const display = useMutation({ mutationFn: (name: string | null) => accountApi.updateMe({ display_name: name }), onSuccess: onSaved('Display name saved.') });
  const privacy = useMutation({ mutationFn: (value: boolean) => accountApi.updateMe({ settings: { show_name_on_albums: value } }), onSuccess: onSaved('Saved.') });

  const availableAt = renameAvailableAt(user);
  const name = normalizeUsername(username);
  const renameReady = name !== user.username && !usernameProblem(name) && availableAt === null;
  const displayProblem = displayNameProblem(displayName);
  const cleaned = cleanDisplayName(displayName);
  const displayChanged = (cleaned || null) !== user.display_name;
  const preview = { id: user.id, username: name && !usernameProblem(name) ? name : user.username, display_name: cleaned || null };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Profile" description="How you appear on files.gg. Pictures aren’t uploaded: your tile is made from your initial.">
        <div className="flex items-center gap-3">
          <Avatar user={preview} size="lg" />
          <p className="min-w-0 text-sm">
            <span className="block truncate font-medium">{fullName(preview)}</span>
            <span className="text-xs text-muted">Member since {formatDay(epochMs(user.created_at))}</span>
          </p>
        </div>

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(null);
            if (renameReady) rename.mutate(name);
          }}
        >
          <UsernameField
            value={username}
            onChange={setUsername}
            current={user.username}
            error={fieldErrors(rename.error).username}
            disabled={availableAt !== null}
            hint="Your files, albums and domains stay yours when you rename. Your old name is kept for you for 30 days."
          />
          {availableAt !== null && <p className="text-xs text-muted">You can change it again on {formatDay(availableAt, { short: true })}.</p>}
          {availableAt === null && user.username_changed_at !== null && <p className="text-xs text-muted">You can change your username once every 30 days.</p>}
          <div>
            <Button type="submit" variant="primary" disabled={!renameReady || rename.isPending}>
              {rename.isPending ? 'Saving…' : 'Save username'}
            </Button>
          </div>
          {rename.isError && !fieldErrors(rename.error).username && <Result error={errorMessage(rename.error)} />}
        </form>

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(null);
            if (!displayProblem && displayChanged) display.mutate(cleaned || null);
          }}
        >
          <label htmlFor={`${id}-display`} className="text-sm font-medium">
            Display name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id={`${id}-display`}
            value={displayName}
            maxLength={DISPLAY_NAME_MAX * 2}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(displayProblem) || undefined}
            aria-describedby={`${id}-display-hint`}
            className={`${fieldClass} w-full max-w-sm`}
          />
          <p id={`${id}-display-hint`} className={`text-xs ${displayProblem ? 'text-danger' : 'text-muted'}`}>
            {displayProblem ? DISPLAY_NAME_REASON_TEXT[displayProblem] : 'Up to 32 characters. Leave it empty to show only your username.'}
          </p>
          <div>
            <Button type="submit" variant="primary" disabled={!displayChanged || Boolean(displayProblem) || display.isPending}>
              {display.isPending ? 'Saving…' : 'Save display name'}
            </Button>
          </div>
          {display.isError && <Result error={errorMessage(display.error)} />}
        </form>
      </Panel>

      <Panel title="Privacy">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={user.settings.show_name_on_albums}
            disabled={privacy.isPending}
            onChange={(event) => {
              setSaved(null);
              privacy.mutate(event.target.checked);
            }}
            className="mt-0.5 accent-gg"
          />
          <span>
            Show my name on albums
            <span className="block text-xs text-muted">Your public album pages say “by {fullName(user)}”. Off by default.</span>
          </span>
        </label>
        {privacy.isError && <Result error={errorMessage(privacy.error)} />}
      </Panel>
      <div aria-live="polite">{saved && <Result success={saved} />}</div>
    </div>
  );
}
