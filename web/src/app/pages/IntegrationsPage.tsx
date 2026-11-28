import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi, type UploadKey } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { useMyLimits } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { epochMs, formatDay, formatRelative } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { accountKeys, useUploadKeys } from '../account/accountQueries';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SignInLink } from '../components/SignInLink';
import { CreateKeyDialog, type CreateKeyResult } from '../integrations/CreateKeyDialog';
import { KeyResult } from '../integrations/KeyResult';
import { RenameKeyDialog } from '../integrations/RenameKeyDialog';

export const UPLOAD_KEYS_MAX = 20;

const STATE_LABELS: Record<UploadKey['state'], string> = { active: 'Active', revoked: 'Revoked', expired: 'Expired' };

/** `/app/integrations` (milestone-6 §7, §13.3): upload keys for ShareX, scripts and apps. */
export default function IntegrationsPage() {
  useEffect(() => {
    document.title = 'Integrations · files.gg';
  }, []);
  const user = useSession().data ?? null;
  if (!user) {
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-muted">
          <SignInLink /> to make upload keys for ShareX, curl and your own scripts. Anonymous uploads from tools aren’t allowed.
        </p>
      </section>
    );
  }
  const restricted = user.restrictions.some((restriction) => restriction.kind === 'uploads');
  return <Keys restricted={restricted} />;
}

function Keys({ restricted }: { restricted: boolean }) {
  const client = useQueryClient();
  const now = useNow(60_000);
  const keys = useUploadKeys();
  const limits = useMyLimits();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateKeyResult | null>(null);
  const [revoking, setRevoking] = useState<UploadKey | null>(null);
  const [renaming, setRenaming] = useState<UploadKey | null>(null);
  const revoke = useMutation({
    mutationFn: (key: UploadKey) => accountApi.revokeUploadKey(key.id),
    onSuccess: () => {
      setRevoking(null);
      void client.invalidateQueries({ queryKey: accountKeys.uploadKeys });
    },
  });

  const items = keys.data?.items ?? [];
  const limit = keys.data?.limit ?? limits.data?.upload_keys?.limit ?? UPLOAD_KEYS_MAX;
  const active = items.filter((key) => key.state === 'active').length;
  const full = active >= limit;

  const onCreated = (result: CreateKeyResult) => {
    setCreating(false);
    setCreated(result);
    void client.invalidateQueries({ queryKey: accountKeys.uploadKeys });
  };

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="text-sm text-muted">Upload keys let ShareX, curl and your own scripts upload to your account. They can’t read, change or delete anything.</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="primary" onClick={() => setCreating(true)} disabled={full} aria-describedby={full ? 'key-limit' : undefined}>
            <Plus aria-hidden className="size-4" />
            Create key
          </Button>
          {full && (
            <p id="key-limit" className="text-xs text-muted">
              You have {limit} active keys, the most allowed. Revoke one to make another.
            </p>
          )}
        </div>
      </header>

      {restricted && (
        <p role="status" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          Uploads are restricted on your account, so keys can’t upload until the restriction ends.
        </p>
      )}
      {limits.data && (
        <p className="text-sm text-muted">
          Tools send each file in one request, up to {formatBytes(limits.data.max_file_size_single)}
          {limits.data.max_file_size_chunked > limits.data.max_file_size_single && ` (the website takes up to ${formatBytes(limits.data.max_file_size_chunked)})`}. Each key can
          upload 600 files an hour.
        </p>
      )}

      {created && <KeyResult result={created} onClose={() => setCreated(null)} />}

      {keys.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : keys.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(keys.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">No upload keys yet. Create one to set up ShareX or curl.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Upload keys">
          {items.map((key) => (
            <li key={key.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${key.state === 'active' ? '' : 'opacity-70'}`}>
              <KeyRound aria-hidden className="size-5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-all">{key.name}</span>
                  <code className="font-mono text-xs text-muted">{key.prefix}…</code>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${key.state === 'active' ? 'bg-gg/15 text-gg' : 'bg-surface-2 text-muted'}`}>{STATE_LABELS[key.state]}</span>
                </p>
                <p className="text-xs text-muted">
                  {[
                    key.scopes.includes('albums:append') ? 'Uploads, adds to albums' : 'Uploads',
                    key.domain ? `links on ${key.domain.hostname}` : null,
                    `created ${formatDay(epochMs(key.created_at))}`,
                    key.last_used_at ? `last used ${formatRelative(epochMs(key.last_used_at), now)}` : 'never used',
                    key.state === 'revoked' && key.revoked_at
                      ? `revoked ${formatDay(epochMs(key.revoked_at))}`
                      : key.expires_at
                        ? `${key.state === 'expired' ? 'expired' : 'expires'} ${formatDay(epochMs(key.expires_at))}`
                        : 'never expires',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {key.state === 'active' && (
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setRenaming(key)} aria-label={`Rename ${key.name}`}>
                    Rename
                  </Button>
                  <Button variant="ghost" onClick={() => setRevoking(key)} aria-label={`Revoke ${key.name}`}>
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreated={onCreated} />}
      {renaming && <RenameKeyDialog uploadKey={renaming} onClose={() => setRenaming(null)} />}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          pending={revoke.isPending}
          error={revoke.isError ? errorMessage(revoke.error) : null}
          onConfirm={() => revoke.mutate(revoking)}
          onClose={() => setRevoking(null)}
        >
          <p>Tools using this key stop uploading at once. Files already uploaded stay.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

