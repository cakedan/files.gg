import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi } from '../../lib/accountApi';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { setSessionUser } from '../../lib/session';
import { normalizeUsername, usernameProblem } from '../../lib/usernames';
import { Dialog } from '../components/Dialog';
import { UsernameField } from './UsernameField';

/** §13.3: a blocking dialog on every dashboard page until a new name is saved (after a staff reset). */
export function NeedsUsernameDialog() {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const save = useMutation({
    mutationFn: (name: string) => accountApi.setUsername(name),
    onSuccess: (user) => setSessionUser(client, user),
  });
  const name = normalizeUsername(username);
  const fields = fieldErrors(save.error);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!usernameProblem(name)) save.mutate(name);
  };
  return (
    <Dialog title="Choose a new username" description="Your username was reset by files.gg staff. Choose a new one." onClose={() => undefined} dismissible={false} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UsernameField value={username} onChange={setUsername} error={fields.username} autoFocus />
        {save.isError && !fields.username && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(save.error)}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={save.isPending || !name || Boolean(usernameProblem(name))}>
          {save.isPending ? 'Saving…' : 'Save username'}
        </Button>
      </form>
    </Dialog>
  );
}
