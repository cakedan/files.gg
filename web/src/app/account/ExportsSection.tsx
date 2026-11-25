import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';

import { Button, LinkButton } from '../../components/Button';
import { accountApi, exportDownloadPath, type DataExport } from '../../lib/accountApi';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { epochMs, formatDay } from '../../lib/time';
import { accountKeys, useExports } from './accountQueries';

const STATUS: Record<DataExport['status'], string> = {
  queued: 'Waiting to start',
  running: 'Being made',
  ready: 'Ready',
  failed: 'Failed. Request a new one.',
  expired: 'Expired',
};

/**
 * Data export (milestone-6 §8.7): **Request export**, then the list with **Download**.
 * JSON files in a ZIP, no file bytes; one a day, kept 7 days. Works during a deletion's
 * grace period and while suspended.
 */
export function ExportsSection() {
  const client = useQueryClient();
  const exports = useExports();
  const request = useMutation({
    mutationFn: () => accountApi.requestExport(),
    onSettled: () => void client.invalidateQueries({ queryKey: accountKeys.exports }),
  });
  const items = exports.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Your account, sessions, upload keys, domains, file and album details, reports and notices, as JSON files in a ZIP. It doesn’t include the files
        themselves; albums have Download all for that. One export a day, kept for 7 days.
      </p>
      <div>
        <Button onClick={() => request.mutate()} disabled={request.isPending}>
          {request.isPending ? 'Requesting…' : 'Request export'}
        </Button>
      </div>
      {request.isError && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(request.error)}
        </p>
      )}
      {exports.isError && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(exports.error)}
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line" aria-label="Exports">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                Requested {formatDay(epochMs(item.created_at))}
                <span className="block text-xs text-muted">
                  {STATUS[item.status]}
                  {item.status === 'ready' && item.size !== null && ` · ${formatBytes(item.size)}`}
                  {item.status === 'ready' && item.expires_at !== null && ` · available until ${formatDay(epochMs(item.expires_at))}`}
                </span>
              </span>
              {item.status === 'ready' && (
                <LinkButton href={exportDownloadPath(item.id)} download>
                  <Download aria-hidden className="size-4" />
                  Download
                </LinkButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
