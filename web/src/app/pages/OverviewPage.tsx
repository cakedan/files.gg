import { useQueries } from '@tanstack/react-query';
import { Clock, FileUp, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';

import { buttonClass } from '../../components/buttonClass';
import { api, ensureGuest, FILE_TYPE_FILTERS, type FileTypeFilter, type MyLimitsResponse, type User } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { queryKeys, useMe, useMyFiles, useMyLimits } from '../../lib/queries';
import { epochMs, formatDay, formatFullDate, formatRelative, RELATIVE_REFRESH_MS } from '../../lib/time';
import { storageTone, type StorageTone } from '../../lib/storageTone';
import { useNow } from '../../lib/useNow';
import { FileThumb } from '../files/FileThumb';
import { pluralize } from '../files/fileLabels';

const DAY = 86_400_000;
/** Temporary files fetched to find the ones expiring this week (the list has no expiry sort). */
const EXPIRING_SCAN = 100;
const EXPIRING_SHOWN = 8;

const TONE_BAR: Record<StorageTone, string> = { ok: 'bg-gg', warn: 'bg-warn', danger: 'bg-danger', full: 'bg-danger' };

/** Milestone 6 §13.3: premium (granted by staff for now), with its expiry if it has one. */
export function PremiumBadge({ premium }: { premium: User['premium'] }) {
  if (!premium.active) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gg/15 px-2 py-0.5 text-xs font-medium text-gg">
      <Sparkles aria-hidden className="size-3.5" />
      Premium{premium.expires_at !== null && ` until ${formatDay(epochMs(premium.expires_at))}`}
    </span>
  );
}

function StorageMeter({ limits }: { limits: MyLimitsResponse }) {
  const { used, limit } = limits.storage;
  if (limit === null) {
    return (
      <p className="text-sm text-muted">
        {formatBytes(used)} uploaded. Anonymous uploads have no storage limit, but are deleted after at most 21 days. Sign in to keep files.
      </p>
    );
  }
  const tone = storageTone(used, limit);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>
          <span className="font-semibold">{formatBytes(used)}</span> <span className="text-muted">of {formatBytes(limit)} used</span>
        </span>
        <span className={tone === 'ok' ? 'text-muted' : tone === 'warn' ? 'text-warn' : 'text-danger'}>{percent}%</span>
      </div>
      <div
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${formatBytes(used)} of ${formatBytes(limit)}`}
        className="h-2.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${percent}%` }} data-tone={tone} />
      </div>
      {tone === 'full' ? (
        <p className="text-sm text-danger" role="alert">
          Your storage is full, so new uploads are blocked. Delete files, or set old ones to expire, to make room.
        </p>
      ) : tone === 'danger' ? (
        <p className="text-sm text-danger">Almost full. Uploads stop once you reach {formatBytes(limit)}.</p>
      ) : tone === 'warn' ? (
        <p className="text-sm text-warn">Over 80% full.</p>
      ) : null}
      <p className="text-xs text-muted">
        Files up to {formatBytes(limits.max_file_size_chunked)} on the website, {formatBytes(limits.max_file_size_single)} from ShareX or curl.
        {limits.premium === false && ' Premium raises storage to 100 GB and files to 5 GB.'}
      </p>
    </div>
  );
}

const TYPE_LABELS: Record<FileTypeFilter, string> = { image: 'Images', video: 'Videos', audio: 'Audio', text: 'Text', pdf: 'PDFs', other: 'Other' };

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Overview (contract §8): storage meter, counts by type, expiring this week, recent uploads. */
export default function OverviewPage() {
  useEffect(() => {
    document.title = 'Overview · files.gg';
  }, []);
  const now = useNow(RELATIVE_REFRESH_MS);
  const user = useMe().data ?? null;
  const limits = useMyLimits();
  const recent = useMyFiles({ sort_by: '-created', limit: 8 });
  const temporary = useMyFiles({ temporary: true, sort_by: '-created', limit: EXPIRING_SCAN });
  const counts = useQueries({
    queries: FILE_TYPE_FILTERS.map((type) => ({
      queryKey: queryKeys.myFiles({ type, limit: 1 }),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        await ensureGuest();
        return api.myFiles({ type, limit: 1 }, signal);
      },
    })),
  });

  const expiring = (temporary.data?.items ?? [])
    .flatMap((file) => (file.expires_at === null ? [] : [{ file, expiresAt: epochMs(file.expires_at) }]))
    .filter(({ expiresAt }) => expiresAt > now && expiresAt - now <= 7 * DAY)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, EXPIRING_SHOWN);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">
            {recent.data ? `${pluralize(recent.data.total.count, 'file')} · ${formatBytes(recent.data.total.size)}` : 'Storage used, recent uploads and files expiring soon.'}
          </p>
        </div>
        <Link to="/upload" className={buttonClass('primary')}>
          <FileUp aria-hidden className="size-4" />
          Upload
        </Link>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Storage" action={user ? <PremiumBadge premium={user.premium} /> : undefined}>
          {limits.data ? (
            <StorageMeter limits={limits.data} />
          ) : limits.isError ? (
            <p className="text-sm text-danger">{errorMessage(limits.error)}</p>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
        </Card>

        <Card title="By type">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {FILE_TYPE_FILTERS.map((type, index) => {
              const data = counts[index]?.data;
              return (
                <li key={type}>
                  <Link to={`/files?type=${type}`} className="flex flex-col rounded-md bg-surface-2 px-3 py-2 hover:bg-line">
                    <span className="text-xs text-muted">{TYPE_LABELS[type]}</span>
                    <span className="text-lg font-semibold tabular-nums">{data ? data.count.toLocaleString('en') : '–'}</span>
                    <span className="text-xs text-muted">{data ? formatBytes(data.size) : ' '}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card
        title="Expiring in the next 7 days"
        action={
          <Link to="/files?temporary=1" className="text-xs text-gg hover:underline">
            All temporary files
          </Link>
        }
      >
        {temporary.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : expiring.length === 0 ? (
          <p className="text-sm text-muted">Nothing expires this week.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {expiring.map(({ file, expiresAt }) => {
              const soon = expiresAt - now < DAY;
              return (
                <li key={file.id} className="flex items-center gap-3 py-2">
                  <FileThumb file={file} />
                  <a href={file.url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate text-sm hover:text-gg" title={file.filename}>
                    {file.filename}
                  </a>
                  <span className={`flex shrink-0 items-center gap-1 text-xs ${soon ? 'text-warn' : 'text-muted'}`} title={formatFullDate(expiresAt)}>
                    <Clock aria-hidden className="size-3.5" />
                    {formatRelative(expiresAt, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Recent uploads"
        action={
          <Link to="/files" className="text-xs text-gg hover:underline">
            All files
          </Link>
        }
      >
        {recent.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : recent.isError ? (
          <p className="text-sm text-danger">{errorMessage(recent.error)}</p>
        ) : recent.data.items.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing yet.{' '}
            <Link to="/upload" className="text-gg hover:underline">
              Upload a file
            </Link>
            .
          </p>
        ) : (
          <ul className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
            {recent.data.items.map((file) => (
              <li key={file.id} className="w-36 shrink-0">
                <a href={file.url} target="_blank" rel="noopener" className="flex flex-col overflow-hidden rounded-md border border-line hover:border-gg/50">
                  <FileThumb file={file} size="lg" />
                  <span className="truncate px-2 pt-1.5 text-xs font-medium" title={file.filename}>
                    {file.filename}
                  </span>
                  <span className="px-2 pb-1.5 text-[11px] text-muted">{formatRelative(epochMs(file.uploaded_at), now)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {user ? null : (
        <p className="text-xs text-muted">You're not signed in, so this shows the files uploaded from this browser.</p>
      )}
    </section>
  );
}
