import { Link } from 'react-router';

import { Button } from '../../../components/Button';
import { RELATIVE_REFRESH_MS } from '../../../lib/time';
import { useNow } from '../../../lib/useNow';
import { useToast } from '../../components/toastContext';
import { RULE_TEXT } from '../../safety/labels';
import type { Ban } from '../adminApi';
import { useBans, useLiftBan } from '../adminQueries';
import { adminError } from '../format';
import { canLiftBans } from '../permissions';
import { useStaff } from '../staffContext';
import { Failure, Loading, When } from '../components/bits';

function Source({ ban }: { ban: Ban }) {
  if (ban.source.file_id) {
    return (
      <Link to={`/admin/files/${ban.source.file_id}`} className="text-gg hover:underline">
        from a file
      </Link>
    );
  }
  if (ban.source.report_id) return <span>from a report</span>;
  return <span>a fingerprint</span>;
}

/** `/app/admin/bans` (§9.3): active bans, by source (never the hash), and Lift for admins. */
export default function BansPage() {
  const staff = useStaff();
  const notify = useToast();
  const now = useNow(RELATIVE_REFRESH_MS);
  const bans = useBans(true);
  const lift = useLiftBan();
  const items = bans.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Active bans</h2>
      <p className="text-sm text-muted">Bans stop uploads and album creation. They don’t stop reports, unlocks or viewing. Add one from a file’s page.</p>
      {bans.isPending ? (
        <Loading label="Loading bans…" />
      ) : bans.isError ? (
        <Failure error={bans.error} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No active bans.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((ban) => (
            <li key={ban.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">{ban.kind === 'ip' ? 'Network' : 'Device'}</span>
              <Source ban={ban} />
              <span className="text-muted">{RULE_TEXT[ban.rule] ?? ban.rule}</span>
              <span className="text-xs text-muted">
                added <When at={ban.created_at} now={now} />
                {ban.expires_at === null ? ', until lifted' : (
                  <>
                    , ends <When at={ban.expires_at} now={now} />
                  </>
                )}
              </span>
              {canLiftBans(staff) && (
                <Button
                  variant="ghost"
                  className="ml-auto"
                  disabled={lift.isPending}
                  onClick={() => lift.mutate(ban.id, { onSuccess: () => notify('Ban lifted.'), onError: (error) => notify(adminError(error), 'error') })}
                  aria-label={`Lift the ${ban.kind === 'ip' ? 'network' : 'device'} ban added ${new Date(ban.created_at * 1000).toLocaleDateString('en')}`}
                >
                  Lift
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canLiftBans(staff) && <p className="text-xs text-muted">Only admins can lift bans.</p>}
      {bans.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => void bans.fetchNextPage()} disabled={bans.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
