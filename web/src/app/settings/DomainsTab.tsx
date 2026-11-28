import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Globe, RefreshCw, Star } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { accountApi, type Domain, type DomainOnlyPreview, type DomainStatus } from '../../lib/accountApi';
import type { User } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { queryKeys } from '../../lib/queries';
import { epochMs, formatDay, formatRelative } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { fieldClass } from '../access/fieldUtils';
import { accountKeys, PENDING_DOMAIN, useDomains } from '../account/accountQueries';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { isSuspended } from './settingsUtils';
import { RULE_TEXT } from '../safety/labels';
import { DOMAIN_STATUS_LABELS, domainOnlyWarning, domainStatusText } from './domainText';
import { LockedNote, Panel, Result } from './Panel';

const STATUS_TONE: Record<DomainStatus, string> = {
  pending_dns: 'bg-surface-2 text-muted',
  pending_cert: 'bg-surface-2 text-muted',
  active: 'bg-gg/15 text-gg',
  failing: 'bg-warn/15 text-warn',
  failed: 'bg-danger/15 text-danger',
  paused: 'bg-warn/15 text-warn',
  disabled: 'bg-danger/15 text-danger',
};

function StatusChip({ status }: { status: DomainStatus }) {
  const Icon = status === 'active' ? CheckCircle2 : CircleDashed;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      <Icon aria-hidden className="size-3.5" />
      {DOMAIN_STATUS_LABELS[status]}
    </span>
  );
}

/** Settings → Domains (milestone-6 §10, §13.4). Premium only; a short explanation otherwise. */
export default function DomainsTab({ user }: { user: User }) {
  if (isSuspended(user)) return <LockedNote>Suspended accounts can’t manage custom domains.</LockedNote>;
  if (!user.premium.active) {
    return (
      <Panel title="Custom domains" description="Share links on your own domain, like i.example.com/abc123.">
        <ul className="list-disc pl-5 text-sm text-muted">
          <li>Up to 5 subdomains, each with its own certificate.</li>
          <li>Choose whether a domain shows only your files, and whether your files show only on your domain.</li>
          <li>Premium also raises storage to 100 GB and files to 5 GB.</li>
        </ul>
        <p className="text-sm">Custom domains need premium. Premium is granted by files.gg staff for now.</p>
      </Panel>
    );
  }
  return <PremiumDomains user={user} />;
}

function PremiumDomains({ user }: { user: User }) {
  const domains = useDomains();
  const [setup, setSetup] = useState<string | null>(null);
  if (domains.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (domains.isError) return <Result error={errorMessage(domains.error)} />;
  const { items, limit, domain_only } = domains.data;
  const live = items.filter((domain) => domain.status !== 'disabled');
  return (
    <div className="flex flex-col gap-4">
      <AddDomain user={user} full={live.length >= limit} limit={limit} onAdded={setSetup} />
      {items.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Your domains">
          {items.map((domain) => (
            <li key={domain.id}>
              <DomainCard domain={domain} expanded={setup === domain.id} />
            </li>
          ))}
        </ul>
      )}
      <DomainOnly state={domain_only} serving={items.some((domain) => domain.serving)} />
    </div>
  );
}

function AddDomain({ user, full, limit, onAdded }: { user: User; full: boolean; limit: number; onAdded: (id: string) => void }) {
  const id = useId();
  const client = useQueryClient();
  const [hostname, setHostname] = useState('');
  const add = useMutation({
    mutationFn: (value: string) => accountApi.addDomain(value),
    onSuccess: (domain) => {
      setHostname('');
      onAdded(domain.id);
      void client.invalidateQueries({ queryKey: accountKeys.domains });
      void client.invalidateQueries({ queryKey: queryKeys.myLimits });
    },
  });
  const blocked = !user.email_verified ? 'Verify your email to add domains.' : full ? `You have the most domains allowed (${limit}). Remove one to add another.` : null;
  return (
    <Panel title="Add a domain" description="Use a subdomain you control, like i.example.com. Root domains aren’t supported yet.">
      {blocked ? (
        <LockedNote>{blocked}</LockedNote>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (hostname.trim()) add.mutate(hostname.trim());
          }}
        >
          <label htmlFor={`${id}-host`} className="text-sm font-medium">
            Hostname
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${id}-host`}
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder="i.example.com"
              autoCapitalize="none"
              spellCheck={false}
              className={`${fieldClass} w-full max-w-xs`}
            />
            <Button type="submit" variant="primary" disabled={add.isPending || !hostname.trim()}>
              {add.isPending ? 'Adding…' : 'Add domain'}
            </Button>
          </div>
          <Result error={add.isError ? errorMessage(add.error) : null} />
        </form>
      )}
    </Panel>
  );
}

function Records({ domain }: { domain: Domain }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Add these two records at your DNS provider:</p>
      <ul className="flex flex-col gap-2" aria-label={`DNS records for ${domain.hostname}`}>
        {domain.records.map((record) => (
          <li key={record.type} className="flex flex-col gap-1.5 rounded-xl border border-line bg-bg p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold">{record.type}</span>
              <span className={`text-xs ${record.ok ? 'text-gg' : 'text-muted'}`}>{record.ok ? 'Found' : 'Not seen yet'}</span>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
              <span className="text-xs text-muted">Name</span>
              <code className="min-w-0 font-mono text-xs break-all">{record.name}</code>
              <CopyButton text={record.name} label="Copy" variant="secondary" aria-label={`Copy the ${record.type} name`} />
              <span className="text-xs text-muted">{record.type === 'CNAME' ? 'Target' : 'Value'}</span>
              <code className="min-w-0 font-mono text-xs break-all">{record.value}</code>
              <CopyButton text={record.value} label="Copy" variant="secondary" aria-label={`Copy the ${record.type} ${record.type === 'CNAME' ? 'target' : 'value'}`} />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">If your DNS is on Cloudflare, set the CNAME to DNS only (grey cloud), not proxied.</p>
    </div>
  );
}

function DomainCard({ domain, expanded }: { domain: Domain; expanded: boolean }) {
  const client = useQueryClient();
  const now = useNow(60_000);
  const [confirm, setConfirm] = useState<'scope' | 'remove' | null>(null);
  const [showRecords, setShowRecords] = useState(false);
  const settle = (updated?: Domain | void) => {
    if (updated) {
      client.setQueryData<{ items: Domain[] }>(accountKeys.domains, (data) => (data ? { ...data, items: data.items.map((each) => (each.id === updated.id ? updated : each)) } : data));
    }
    void client.invalidateQueries({ queryKey: accountKeys.domains });
  };
  const check = useMutation({ mutationFn: () => accountApi.checkDomain(domain.id), onSuccess: settle });
  const retry = useMutation({ mutationFn: () => accountApi.retryDomain(domain.id), onSuccess: settle });
  const makeDefault = useMutation({ mutationFn: () => accountApi.updateDomain(domain.id, { default: true }), onSuccess: settle });
  const scope = useMutation({
    mutationFn: (value: 'own' | 'any') => accountApi.updateDomain(domain.id, value === 'any' ? { scope: 'any', confirm: true } : { scope: 'own' }),
    onSuccess: (updated) => {
      setConfirm(null);
      settle(updated);
    },
  });
  const remove = useMutation({
    mutationFn: () => accountApi.removeDomain(domain.id),
    onSuccess: () => {
      setConfirm(null);
      settle();
      void client.invalidateQueries({ queryKey: queryKeys.myLimits });
    },
  });
  const pending = PENDING_DOMAIN.has(domain.status);
  const disabled = domain.status === 'disabled';
  const certSlow = domain.status === 'pending_cert' && now - epochMs(domain.created_at) > 3600_000;
  const error = [check, retry, makeDefault, scope, remove].find((mutation) => mutation.isError)?.error;
  const recordsShown = pending || domain.status === 'failing' || domain.status === 'failed' || expanded || showRecords;

  return (
    <article aria-label={domain.hostname} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
      <header className="flex flex-wrap items-center gap-2">
        <Globe aria-hidden className="size-4 text-muted" />
        <h3 className="min-w-0 font-mono text-sm font-semibold break-all">{domain.hostname}</h3>
        <StatusChip status={domain.status} />
        {domain.is_default && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
            <Star aria-hidden className="size-3" /> Default
          </span>
        )}
      </header>
      <p className="text-sm text-muted" aria-live="polite">
        {domainStatusText(domain, now)}
        {domain.last_checked_at !== null && ` Checked ${formatRelative(epochMs(domain.last_checked_at), now)}.`}
        {pending && domain.pending_until !== null && ` We’ll keep checking until ${formatDay(epochMs(domain.pending_until))}.`}
      </p>
      {disabled && (
        <p className="text-sm">
          Reason: {RULE_TEXT[domain.disabled_reason ?? ''] ?? domain.disabled_reason ?? 'Breaking the Terms of Service'}.{' '}
          <Link to="/notices" className="text-gg hover:underline">
            Appeal in Notices
          </Link>
        </p>
      )}
      {certSlow && <p className="text-xs text-muted">If your domain has CAA records, they must allow the certificate authority Cloudflare uses.</p>}
      {recordsShown && !disabled ? (
        <Records domain={domain} />
      ) : (
        !disabled && (
          <div>
            <button type="button" onClick={() => setShowRecords(true)} className="text-xs text-gg hover:underline">
              Show DNS records
            </button>
          </div>
        )
      )}
      {!disabled && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            role="switch"
            checked={domain.scope === 'own'}
            disabled={scope.isPending}
            onChange={(event) => (event.target.checked ? scope.mutate('own') : setConfirm('scope'))}
            className="mt-0.5 accent-gg"
          />
          <span>
            Only my files
            <span className="block text-xs text-muted">
              {domain.scope === 'own' ? 'Other people’s links open as missing on this domain.' : 'Anyone’s public and password files open on this domain.'}
            </span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {(pending || domain.status === 'failing') && (
          <Button onClick={() => check.mutate()} disabled={check.isPending}>
            <RefreshCw aria-hidden className="size-4" />
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
        )}
        {domain.status === 'failed' && (
          <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Retrying…' : 'Retry'}
          </Button>
        )}
        {(domain.status === 'active' || domain.status === 'failing') && !domain.is_default && (
          <Button onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending}>
            Set as default
          </Button>
        )}
        <Button variant="ghost" onClick={() => setConfirm('remove')} disabled={disabled} title={disabled ? 'files.gg disabled this domain, so it can’t be removed.' : undefined}>
          Remove
        </Button>
      </div>
      <Result error={error && !confirm ? errorMessage(error) : null} />
      {confirm === 'scope' && (
        <ConfirmDialog
          title="Show other people’s files?"
          confirmLabel="Show everyone’s files"
          pending={scope.isPending}
          error={scope.isError ? errorMessage(scope.error) : null}
          onConfirm={() => scope.mutate('any')}
          onClose={() => setConfirm(null)}
        >
          <p>Other people’s files will be viewable on your domain. Reports about them still go to their uploaders.</p>
        </ConfirmDialog>
      )}
      {confirm === 'remove' && (
        <ConfirmDialog
          title={`Remove ${domain.hostname}?`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          pending={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirm(null)}
        >
          <p>Links on this domain stop working. Your files stay on files.gg.</p>
        </ConfirmDialog>
      )}
    </article>
  );
}

/** "Only show my files on my domain" (§10.6): on needs a serving domain and the counts first. */
function DomainOnly({ state, serving }: { state: { enabled: boolean; effective: boolean; paused: boolean }; serving: boolean }) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<DomainOnlyPreview | null>(null);
  const loadPreview = useMutation({ mutationFn: () => accountApi.domainOnlyPreview(), onSuccess: setPreview });
  const save = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) => accountApi.setDomainOnly(enabled, enabled ? true : undefined),
    onSuccess: () => {
      setPreview(null);
      void client.invalidateQueries({ queryKey: accountKeys.domains });
      void client.invalidateQueries({ queryKey: queryKeys.myFilesAll });
    },
  });
  const files = preview?.affected_files ?? 0;
  const albums = preview?.affected_albums ?? 0;
  return (
    <Panel title="Only show my files on my domain" description="Your files.gg links stop working, so your files open only on your domains.">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={state.enabled}
          disabled={(!state.enabled && !serving) || save.isPending || loadPreview.isPending}
          onChange={(event) => (event.target.checked ? loadPreview.mutate() : save.mutate({ enabled: false }))}
          className="mt-0.5 accent-gg"
        />
        <span>
          Only show my files on my domain
          <span className="block text-xs text-muted">
            {!state.enabled && !serving ? 'You need a working domain first.' : state.paused ? 'Paused because no domain is working. Your files are showing on files.gg again.' : state.effective ? 'On. Your files.gg links show as missing.' : 'Off.'}
          </span>
        </span>
      </label>
      <Result error={loadPreview.isError ? errorMessage(loadPreview.error) : save.isError && !preview ? errorMessage(save.error) : null} />
      {preview && (
        <ConfirmDialog
          title="Only show your files on your domain?"
          confirmLabel="Turn on"
          pending={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onConfirm={() => save.mutate({ enabled: true })}
          onClose={() => setPreview(null)}
        >
          <p>{domainOnlyWarning(files, albums)}</p>
          <p>Links on your domain keep working. You can turn this off at any time.</p>
        </ConfirmDialog>
      )}
    </Panel>
  );
}
