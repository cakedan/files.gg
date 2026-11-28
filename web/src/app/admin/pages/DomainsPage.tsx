import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../../components/Button';
import type { DomainStatus } from '../../../lib/accountApi';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { fieldClass } from '../../access/fieldUtils';
import { DOMAIN_STATUS_LABELS } from '../../settings/domainText';
import { useAdminDomains } from '../adminQueries';
import { Failure, Loading, When } from '../components/bits';

const STATUSES = Object.keys(DOMAIN_STATUS_LABELS) as DomainStatus[];

const STATUS_TONES: Partial<Record<DomainStatus, string>> = {
  active: 'text-gg',
  failing: 'text-warn',
  paused: 'text-warn',
  failed: 'text-danger',
  disabled: 'text-danger',
};

/**
 * `/app/admin/domains` (milestone-6 §10.12, §13): every custom domain, newest first,
 * filtered by status and hostname (both in the URL), with links to the domain and its owner.
 */
export default function DomainsPage() {
  const id = useId();
  const now = useNow(RELATIVE_REFRESH_MS);
  const [params, setParams] = useSearchParams();
  const wanted = params.get('status');
  const status = STATUSES.find((each) => each === wanted);
  const q = params.get('q')?.trim() || undefined;
  const [search, setSearch] = useState(q ?? '');
  const domains = useAdminDomains({ q, status });
  const items = domains.data?.pages.flatMap((page) => page.items) ?? [];

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    set('q', search.trim() || null);
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Custom domains</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-status`} className="text-xs text-muted">
            Status
          </label>
          <select id={`${id}-status`} value={status ?? ''} onChange={(event) => set('status', event.target.value || null)} className={fieldClass}>
            <option value="">Any</option>
            {STATUSES.map((each) => (
              <option key={each} value={each}>
                {DOMAIN_STATUS_LABELS[each]}
              </option>
            ))}
          </select>
        </div>
        <form onSubmit={onSearch} className="flex items-end gap-2" role="search">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-q`} className="text-xs text-muted">
              Hostname
            </label>
            <input id={`${id}-q`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="i.example.com" className={fieldClass} />
          </div>
          <Button type="submit">Search</Button>
        </form>
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {domains.data ? `${items.length}${domains.hasNextPage ? ' or more' : ''} ${items.length === 1 ? 'domain' : 'domains'}` : ''}
      </p>

      {domains.isPending ? (
        <Loading label="Loading domains…" />
      ) : domains.isError ? (
        <Failure error={domains.error} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{status || q ? 'No domains match these filters.' : 'No custom domains yet.'}</p>
      ) : (
        <ul aria-label="Domains" className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
          {items.map((domain) => (
            <li key={domain.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <Link to={`/admin/domains/${domain.id}`} className="font-mono text-gg hover:underline">
                {domain.hostname}
              </Link>
              <span className={`text-xs font-medium ${STATUS_TONES[domain.status] ?? 'text-muted'}`}>{DOMAIN_STATUS_LABELS[domain.status]}</span>
              {domain.status === 'active' && !domain.serving && <span className="text-xs text-warn">Not serving</span>}
              {domain.is_default && <span className="text-xs text-muted">Default</span>}
              {domain.scope === 'own' && <span className="text-xs text-muted">Only the owner’s files</span>}
              <span className="text-xs text-muted">
                {domain.owner ? (
                  <Link to={`/admin/users/${domain.owner.id}`} className="hover:text-gg hover:underline">
                    @{domain.owner.username ?? domain.owner.id}
                  </Link>
                ) : (
                  'No owner'
                )}
                , added <When at={domain.created_at} now={now} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {domains.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void domains.fetchNextPage()} disabled={domains.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
