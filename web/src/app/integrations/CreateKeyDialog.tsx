import { useMutation } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { accountApi, type CreatedUploadKey, type UploadKeyScope } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';
import { useMyAlbums, useMyLimits } from '../../lib/queries';
import { NO_SHAREX_DEFAULTS, sharexArguments, type SharexDefaults } from '../../lib/sharex';
import { ADULT_REGION_TEXT, parseViewLimit, VIEW_LIMIT_HINT, VIEW_LIMIT_MAX, VIEW_LIMIT_MIN } from '../../lib/upload/options';
import type { ViewLimitAction } from '../../lib/api';
import { useSession } from '../../lib/session';
import { fieldClass } from '../access/fieldUtils';
import { useDomains } from '../account/accountQueries';
import { AppLink } from '../components/AppLink';
import { Dialog } from '../components/Dialog';

const DAY = 86400;
/** §7.3: never, 30, 90 or 365 days. */
const KEY_EXPIRIES = [
  { value: null, label: 'Never' },
  { value: 30 * DAY, label: '30 days' },
  { value: 90 * DAY, label: '90 days' },
  { value: 365 * DAY, label: '1 year' },
] as const;

const UPLOAD_EXPIRIES = [
  { value: null, label: 'Account default' },
  { value: 3600, label: '1 hour' },
  { value: DAY, label: '1 day' },
  { value: 7 * DAY, label: '7 days' },
  { value: 30 * DAY, label: '30 days' },
] as const;

export interface CreateKeyResult {
  created: CreatedUploadKey;
  /** The `.sxcu` `Arguments` picked here (never sent to the API). */
  args: Record<string, string>;
}

/** **Create key** (§13.3): name, album scope, link domain, expiry, and the ShareX defaults. */
export function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (result: CreateKeyResult) => void }) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const user = useSession().data;
  const limits = useMyLimits();
  const premium = Boolean(user?.premium.active);
  const domains = useDomains(premium);
  const albums = useMyAlbums({ limit: 100 });
  const [name, setName] = useState('');
  const [albumsScope, setAlbumsScope] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [defaults, setDefaults] = useState<SharexDefaults>(NO_SHAREX_DEFAULTS);
  // Milestone 6 §19.3: the view limit as typed ('' is off), and its action.
  const [viewLimitText, setViewLimitText] = useState('');
  const [viewLimitAction, setViewLimitAction] = useState<ViewLimitAction>('expire');
  const [submitted, setSubmitted] = useState(false);
  const parsedViewLimit = parseViewLimit(viewLimitText);
  const viewLimitError = 'error' in parsedViewLimit ? parsedViewLimit.error : null;
  const picked: SharexDefaults = {
    ...defaults,
    viewLimit: 'value' in parsedViewLimit ? parsedViewLimit.value : null,
    viewLimitAction,
  };
  const create = useMutation({
    mutationFn: () => {
      const scopes: UploadKeyScope[] = albumsScope ? ['files:upload', 'albums:append'] : ['files:upload'];
      const args = sharexArguments(picked, albumsScope);
      // The API takes the same defaults (optional) for its own `sharex` and `curl`; the
      // browser still builds the `.sxcu` itself (§7.7).
      const sharex = {
        ...(args.expires_in ? { expires_in: Number(args.expires_in) } : {}),
        ...(args.visibility ? { visibility: args.visibility } : {}),
        ...(args.generate_password ? { generate_password: true } : {}),
        ...(args.nsfw ? { nsfw: true } : {}),
        ...(args.album ? { album: args.album } : {}),
        ...(args.view_limit ? { view_limit: Number(args.view_limit), view_limit_action: args.view_limit_action as ViewLimitAction } : {}),
      };
      return accountApi.createUploadKey({
        name: name.trim() || 'Upload key',
        scopes,
        domain_id: domainId || null,
        expires_in: expiresIn,
        ...(Object.keys(sharex).length > 0 ? { sharex } : {}),
      });
    },
    onSuccess: (created) => onCreated({ created, args: sharexArguments(picked, albumsScope) }),
  });
  const set = <K extends keyof SharexDefaults>(key: K, value: SharexDefaults[K]) => setDefaults((current) => ({ ...current, [key]: value }));
  const nsfwAllowed = limits.data?.nsfw_allowed !== false;
  // Milestone 7 §11.4: from a blocked country, a line instead of the checkbox.
  const regionBlocked = limits.data?.adult_region_blocked === true;
  const usableDomains = (domains.data?.items ?? []).filter((domain) => domain.status !== 'disabled' && domain.status !== 'failed');

  return (
    <Dialog
      title="Create an upload key"
      description="You’ll see the key once, right after this."
      onClose={onClose}
      initialFocus={nameRef}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (viewLimitError) return;
          create.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            Name
          </label>
          <input ref={nameRef} id={`${id}-name`} value={name} maxLength={64} placeholder="Laptop ShareX" onChange={(event) => setName(event.target.value)} className={`${fieldClass} w-full`} />
        </div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={albumsScope} onChange={(event) => setAlbumsScope(event.target.checked)} className="mt-0.5 accent-gg" />
          <span>
            Also allow adding to albums
            <span className="block text-xs text-muted">Uploads can go straight into one of your albums. Keys can never make or change albums.</span>
          </span>
        </label>
        {premium && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-domain`} className="text-sm font-medium">
              Link domain
            </label>
            <select id={`${id}-domain`} value={domainId} onChange={(event) => setDomainId(event.target.value)} className={fieldClass}>
              <option value="">Default</option>
              {usableDomains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.hostname}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">Links use this domain while it’s working, else your default.</p>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-expiry`} className="text-sm font-medium">
            Key expires
          </label>
          <select id={`${id}-expiry`} value={String(expiresIn)} onChange={(event) => setExpiresIn(event.target.value === 'null' ? null : Number(event.target.value))} className={fieldClass}>
            {KEY_EXPIRIES.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-medium">ShareX defaults</legend>
          <p className="text-xs text-muted">
            These go only into the ShareX config and the curl example; you can change them there later. What’s left at the account default follows{' '}
            <AppLink to="/settings/uploads" className="text-gg hover:underline">
              your upload defaults
            </AppLink>
            .
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-file-expiry`} className="text-sm">
              Files expire after
            </label>
            <select
              id={`${id}-file-expiry`}
              value={String(defaults.expiresIn)}
              onChange={(event) => set('expiresIn', event.target.value === 'null' ? null : Number(event.target.value))}
              className={fieldClass}
            >
              {UPLOAD_EXPIRIES.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-access`} className="text-sm">
              Who can open them
            </label>
            <select
              id={`${id}-access`}
              value={defaults.visibility ?? ''}
              onChange={(event) => {
                const visibility = (event.target.value || null) as SharexDefaults['visibility'];
                // "Password" means a generated one per upload (`generate_password`): ShareX can't ask for one.
                setDefaults((current) => ({ ...current, visibility, generatePassword: visibility === 'password' }));
              }}
              className={fieldClass}
            >
              <option value="">Account default</option>
              <option value="link">Anyone with the link</option>
              <option value="password">Password (a new one for each upload)</option>
              <option value="private">Only me</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-view-limit`} className="text-sm">
              View limit
            </label>
            <input
              id={`${id}-view-limit`}
              type="number"
              inputMode="numeric"
              min={VIEW_LIMIT_MIN}
              max={VIEW_LIMIT_MAX}
              step={1}
              placeholder="Off"
              value={viewLimitText}
              onChange={(event) => setViewLimitText(event.target.value)}
              aria-invalid={submitted && viewLimitError ? true : undefined}
              aria-describedby={`${id}-view-limit-hint`}
              className={fieldClass}
            />
            {submitted && viewLimitError ? (
              <p id={`${id}-view-limit-hint`} role="alert" className="text-xs text-danger">
                {viewLimitError}
              </p>
            ) : (
              <p id={`${id}-view-limit-hint`} className="text-xs text-muted">
                {viewLimitText.trim() ? VIEW_LIMIT_HINT : 'Off. Enter a number to stop each link after that many viewers.'}
              </p>
            )}
          </div>
          {viewLimitText.trim() !== '' && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-view-limit-action`} className="text-sm">
                When the limit is reached
              </label>
              <select
                id={`${id}-view-limit-action`}
                value={viewLimitAction}
                onChange={(event) => setViewLimitAction(event.target.value as ViewLimitAction)}
                className={fieldClass}
              >
                <option value="expire">Expire the file</option>
                <option value="private">Make it private</option>
              </select>
            </div>
          )}
          {regionBlocked ? (
            <p className="text-xs text-muted">{ADULT_REGION_TEXT}</p>
          ) : nsfwAllowed ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={defaults.nsfw} onChange={(event) => set('nsfw', event.target.checked)} className="accent-gg" />
              Mark uploads as sensitive (else the account default)
            </label>
          ) : null}
          {albumsScope && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-album`} className="text-sm">
                Add to album
              </label>
              <select id={`${id}-album`} value={defaults.album ?? ''} onChange={(event) => set('album', event.target.value || null)} className={fieldClass}>
                <option value="">None</option>
                {(albums.data?.items ?? []).map((album) => (
                  <option key={album.id} value={album.vanity}>
                    {album.title || 'Untitled album'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
        {create.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(create.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
