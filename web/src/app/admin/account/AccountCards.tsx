import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../../components/Button';
import { epochMs, formatDay, RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { fieldClass } from '../../access/fieldUtils';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import type { AdminUserDetail, Entitlement } from '../adminApi';
import { usePremiumChange, type PremiumChange } from '../adminQueries';
import { ActionPanel } from '../components/ActionPanel';
import { Section, When } from '../components/bits';
import { adminError } from '../format';
import { actionOption, canManagePremium } from '../permissions';
import { useStaff } from '../staffContext';

const DAY = 86400;
const DOMAIN_STATUS: Record<string, string> = {
  pending_dns: 'waiting for DNS',
  pending_cert: 'issuing certificate',
  active: 'active',
  failing: 'failing',
  failed: 'failed',
  paused: 'paused',
  disabled: 'disabled by staff',
};

/**
 * The Milestone 6 cards on `/app/admin/users/:id` (§9.4): Premium (grant, change expiry,
 * revoke; admins only), and read-only login methods, sessions, upload keys, domains and a
 * pending deletion. A lazy part of the admin chunk.
 */
export default function AccountCards({ detail }: { detail: AdminUserDetail }) {
  return (
    <>
      <PremiumCard detail={detail} />
      <AccountFacts detail={detail} />
    </>
  );
}

const activeEntitlement = (detail: AdminUserDetail): Entitlement | null => detail.entitlements?.find((entitlement) => entitlement.active) ?? null;

function PremiumCard({ detail }: { detail: AdminUserDetail }) {
  const staff = useStaff();
  const now = useNow(RELATIVE_REFRESH_MS);
  const [editing, setEditing] = useState<PremiumChange['type'] | null>(null);
  const current = activeEntitlement(detail);
  const history = detail.entitlements ?? [];
  const admin = canManagePremium(staff);
  return (
    <Section
      title="Premium"
      actions={
        admin && !detail.deletion ? (
          current ? (
            <div className="flex gap-2">
              <Button onClick={() => setEditing('change')}>Change expiry</Button>
              <Button variant="danger" onClick={() => setEditing('revoke')}>
                Revoke
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => setEditing('grant')}>
              Grant
            </Button>
          )
        ) : undefined
      }
    >
      <p className="text-sm">
        {current ? (
          <>
            Premium{current.expires_at === null ? ', until revoked' : ` until ${formatDay(epochMs(current.expires_at))}`}
            {current.granted_by && <span className="text-muted"> · granted by {current.granted_by.username}</span>}
          </>
        ) : (
          'Not premium.'
        )}
      </p>
      {!admin && <p className="text-xs text-muted">Only admins can grant or revoke premium.</p>}
      {history.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Premium history">
          {history.map((entitlement) => (
            <li key={entitlement.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{entitlement.active ? 'Active' : entitlement.revoked_at ? 'Revoked' : 'Expired'}</span>
              <span className="text-muted">
                granted <When at={entitlement.granted_at} now={now} />
                {entitlement.granted_by && ` by ${entitlement.granted_by.username}`}
                {entitlement.expires_at !== null && `, ${entitlement.active ? 'expires' : 'ended'} ${formatDay(epochMs(entitlement.expires_at))}`}
                {entitlement.revoked_by && `, revoked by ${entitlement.revoked_by.username}`}
              </span>
              {entitlement.note && <span className="w-full text-xs break-words text-muted">“{entitlement.note}”</span>}
            </li>
          ))}
        </ul>
      )}
      {editing && <PremiumDialog type={editing} userId={detail.user.id} current={current} onClose={() => setEditing(null)} />}
    </Section>
  );
}

const PRESETS = [
  { value: '', label: 'Until revoked' },
  { value: String(30 * DAY), label: '30 days' },
  { value: String(90 * DAY), label: '90 days' },
  { value: String(365 * DAY), label: '1 year' },
] as const;

function PremiumDialog({ type, userId, current, onClose }: { type: PremiumChange['type']; userId: string; current: Entitlement | null; onClose: () => void }) {
  const id = useId();
  const notify = useToast();
  const change = usePremiumChange(userId);
  const [length, setLength] = useState('');
  const [note, setNote] = useState('');
  const title = type === 'grant' ? 'Grant premium' : type === 'change' ? 'Change the premium expiry' : 'Revoke premium';
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    const expiresAt = length ? Math.floor(Date.now() / 1000) + Number(length) : null;
    const body: PremiumChange =
      type === 'grant'
        ? { type, expires_at: expiresAt, note: note.trim() }
        : type === 'change'
          ? { type, id: current!.id, expires_at: expiresAt, note: note.trim() }
          : { type, id: current!.id, note: note.trim() };
    change.mutate(body, {
      onSuccess: () => {
        notify(type === 'grant' ? 'Premium granted.' : type === 'change' ? 'Expiry changed.' : 'Premium revoked.');
        onClose();
      },
    });
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} variant={type === 'revoke' ? 'danger' : 'primary'} disabled={change.isPending || !note.trim()}>
            {change.isPending ? 'Saving…' : title}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="flex flex-col gap-3">
        {type !== 'revoke' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-length`} className="text-sm font-medium">
              {type === 'grant' ? 'For' : 'New expiry, from now'}
            </label>
            <select id={`${id}-length`} value={length} onChange={(event) => setLength(event.target.value)} className={fieldClass}>
              {PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">
            Note for staff
          </label>
          <textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} required className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 text-[15px]" />
          <p className="text-xs text-muted">Required. It goes in the audit log. The account gets an email.</p>
        </div>
        {change.isError && (
          <p role="alert" className="text-sm text-danger">
            {adminError(change.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function AccountFacts({ detail }: { detail: AdminUserDetail }) {
  const now = useNow(RELATIVE_REFRESH_MS);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const keys = (detail.upload_keys ?? []).filter((key) => key.state === 'active');
  return (
    <>
      {detail.deletion && (
        <Section title="Pending deletion">
          <p className="text-sm">
            Requested <When at={detail.deletion.requested_at} now={now} />. Deleted for good on {formatDay(epochMs(detail.deletion.scheduled_for))} unless the owner keeps
            the account. Its content is offline meanwhile.
          </p>
        </Section>
      )}
      <Section title="Login methods">
        <ul className="flex flex-col gap-1 text-sm">
          <li>{detail.user.email ? `Email ${detail.user.email}${detail.user.email_verified ?? detail.user.verified ? ' (verified)' : ' (not verified)'}` : 'No email'}</li>
          {(detail.identities ?? []).map((identity) => (
            <li key={identity.provider_user_id}>
              Discord {identity.username ? `@${identity.username}` : ''} <span className="text-muted">({identity.provider_user_id}), linked {formatDay(epochMs(identity.created_at))}</span>
            </li>
          ))}
        </ul>
        {detail.sessions && <p className="text-sm text-muted">{detail.sessions.active === 1 ? '1 active session' : `${detail.sessions.active} active sessions`}. Sign out everywhere is in Actions.</p>}
      </Section>
      <Section title="Upload keys">
        {keys.length === 0 ? (
          <p className="text-sm text-muted">No active keys.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {key.name} <code className="font-mono text-xs text-muted">{key.prefix}…</code>
                  <span className="block text-xs text-muted">
                    {key.last_used_at ? (
                      <>
                        last used <When at={key.last_used_at} now={now} />
                      </>
                    ) : (
                      'never used'
                    )}
                  </span>
                </span>
                <Button variant="ghost" onClick={() => setRevokingKey(revokingKey === key.id ? null : key.id)} aria-expanded={revokingKey === key.id}>
                  Revoke
                </Button>
                {revokingKey === key.id && (
                  <div className="w-full">
                    <ActionPanel
                      title={`Revoke ${key.name}`}
                      target={{ type: 'user', id: detail.user.id }}
                      details={{ key_id: key.id }}
                      options={[{ ...actionOption('revoke_upload_keys'), label: 'Revoke this key' }]}
                      onDone={() => setRevokingKey(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Domains">
        {(detail.domains ?? []).length === 0 ? (
          <p className="text-sm text-muted">No domains.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {(detail.domains ?? []).map((domain) => (
              <li key={domain.id}>
                <Link to={`/admin/domains/${domain.id}`} className="font-mono text-gg hover:underline">
                  {domain.hostname}
                </Link>{' '}
                <span className="text-muted">
                  {DOMAIN_STATUS[domain.status] ?? domain.status}
                  {domain.is_default && ', default'}
                  {domain.scope === 'any' && ', shows anyone’s files'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
