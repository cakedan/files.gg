import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi, type UploadKey } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';
import { fieldClass } from '../access/fieldUtils';
import { accountKeys } from '../account/accountQueries';
import { Dialog } from '../components/Dialog';

/** **Rename** (`PATCH /users/@me/upload-keys/<id> { name }`). */
export function RenameKeyDialog({ uploadKey, onClose }: { uploadKey: UploadKey; onClose: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const [name, setName] = useState(uploadKey.name);
  const rename = useMutation({
    mutationFn: () => accountApi.updateUploadKey(uploadKey.id, { name: name.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: accountKeys.uploadKeys });
      onClose();
    },
  });
  return (
    <Dialog
      title="Rename upload key"
      onClose={onClose}
      initialFocus={input}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={rename.isPending || !name.trim()}>
            {rename.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) rename.mutate();
        }}
        className="flex flex-col gap-1.5"
      >
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          Name
        </label>
        <input ref={input} id={`${id}-name`} value={name} maxLength={64} onChange={(event) => setName(event.target.value)} className={`${fieldClass} w-full`} />
        {rename.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(rename.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
