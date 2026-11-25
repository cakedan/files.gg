import { FileUp } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { buttonClass } from '../../components/buttonClass';
import type { OwnerFile } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { EMPTY_SELECTION, pruneSelection, toggleAllOnPage, toggleSelection, type Selection } from '../../lib/files/selection';
import { filesSearchParams, pageCount, parseFilesState, patchFilesState, toApiParams, type FilesUrlState } from '../../lib/files/urlState';
import { useDeleteFiles, useMe, useMyFiles, useMyLimits, useRenameFile, useSetExpiry, useSetNsfw, useSetViewLimit } from '../../lib/queries';
import { SignInLink } from '../components/SignInLink';
import { RELATIVE_REFRESH_MS } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { AccessDialog } from '../access/AccessDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastContext';
import { useIsNarrow } from '../components/useMediaQuery';
import { AddToAlbumDialog } from '../files/AddToAlbumDialog';
import { AskReviewDialog } from '../files/AskReviewDialog';
import { BulkBar } from '../files/BulkBar';
import { ExpiryDialog } from '../files/ExpiryDialog';
import { pluralize } from '../files/fileLabels';
import type { FileHandlers } from '../files/fileMenu';
import { FilesToolbar } from '../files/FilesToolbar';
import { FileCardList, FilesGrid, FilesTable } from '../files/FilesViews';
import { Pagination } from '../files/Pagination';
import { useFileActions } from '../files/useFileActions';
import { usePendingPoll } from '../files/usePendingPoll';
import { ViewLimitDialog } from '../files/ViewLimitDialog';
import { useDomains } from '../account/accountQueries';

const FileDrawer = lazy(() => import('../files/FileDrawer'));

type DialogState =
  | { type: 'delete'; files: OwnerFile[] }
  | { type: 'expiry'; files: OwnerFile[] }
  | { type: 'access'; files: OwnerFile[] }
  | { type: 'album'; files: OwnerFile[] }
  | { type: 'review'; files: OwnerFile[] }
  | { type: 'viewLimit'; files: OwnerFile[] }
  | null;

/** PLAN.md Phase 3 "Files" and milestone-3 contract §8. */
export default function FilesPage() {
  useEffect(() => {
    document.title = 'Files · files.gg';
  }, []);

  const user = useMe().data;
  const anonymous = !user;
  // §13.4: "Open on i.example.com" uses the default domain while it's serving (premium only).
  const domains = useDomains(Boolean(user?.premium.active));
  const linkDomain = domains.data?.items.find((domain) => domain.is_default && domain.serving) ?? null;
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseFilesState(params), [params]);
  const apiParams = useMemo(() => toApiParams(state), [state]);
  const files = useMyFiles(apiParams);
  const limits = useMyLimits();
  const items = useMemo(() => files.data?.items ?? [], [files.data]);
  const order = useMemo(() => items.map((file) => file.id), [items]);
  const now = useNow(RELATIVE_REFRESH_MS);
  const narrow = useIsNarrow();
  const notify = useToast();
  const navigate = useNavigate();

  const update = useCallback(
    (patch: Partial<FilesUrlState>) => setParams(filesSearchParams(patchFilesState(state, patch)), { replace: patch.query !== undefined }),
    [setParams, state],
  );

  // Selection is per result set: a new page, search or filter starts empty.
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const listKey = JSON.stringify(apiParams);
  const [selectionFor, setSelectionFor] = useState(listKey);
  if (selectionFor !== listKey) {
    setSelectionFor(listKey);
    setSelection(EMPTY_SELECTION);
  }
  const pruned = pruneSelection(selection, order);
  if (pruned !== selection) setSelection(pruned);
  const selectedFiles = items.filter((file) => selection.ids.has(file.id));

  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const drawerFile = items.find((file) => file.id === drawerId) ?? null;
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const actions = useFileActions();
  const remove = useDeleteFiles();
  const rename = useRenameFile();
  const expiry = useSetExpiry();
  const sensitive = useSetNsfw();
  const viewLimit = useSetViewLimit();
  usePendingPoll(items);

  const handlers: FileHandlers = useMemo(
    () => ({
      copyLink: (file) => void actions.copyLink(file),
      copyDirectLink: (file) => void actions.copyDirectLink(file),
      openOnDomain: linkDomain ? { hostname: linkDomain.hostname, open: (file) => void actions.openOnDomain(file, linkDomain.id) } : undefined,
      open: actions.open,
      openAsOwner: (file) => void actions.openAsOwner(file),
      rename: (file) => {
        setDrawerId(null);
        setRenamingId(file.id);
      },
      setExpiry: (list) => setDialog({ type: 'expiry', files: list }),
      keepForever: anonymous
        ? undefined
        : (list) =>
            expiry.mutate(
              { ids: list.map((file) => file.id), expiresIn: null },
              {
                onSuccess: () => notify(`${pluralize(list.length, 'file')} kept forever.`),
                onError: (error) => notify(errorMessage(error), 'error'),
              },
            ),
      changeAccess: (list) => setDialog({ type: 'access', files: list }),
      addToAlbum: (list) => setDialog({ type: 'album', files: list }),
      remove: (list) => setDialog({ type: 'delete', files: list }),
      // Milestone 4 §4.5: only signed-in owners can mark (anonymous files can't hold adult content).
      setSensitive: anonymous
        ? undefined
        : (list, nsfw) =>
            sensitive.mutate(
              { ids: list.map((file) => file.id), nsfw },
              {
                onSuccess: ({ items: changed, skipped }) => {
                  const done = nsfw ? `Marked ${pluralize(changed.length, 'file')} as sensitive.` : `Unmarked ${pluralize(changed.length, 'file')}.`;
                  const kept = skipped.length > 0 ? ` ${pluralize(skipped.length, 'file')} marked by files.gg ${skipped.length === 1 ? 'stays' : 'stay'} marked.` : '';
                  notify(done + kept);
                },
                onError: (error) => notify(errorMessage(error), 'error'),
              },
            ),
      askReview: anonymous ? undefined : (file) => setDialog({ type: 'review', files: [file] }),
      // Milestone 6 §19.3: anonymous uploaders set a view limit only at upload.
      editViewLimit: anonymous ? undefined : (file) => setDialog({ type: 'viewLimit', files: [file] }),
      // Milestone 5 §13.2: one file opens the Convert page on it, several start a batch.
      convert: (list) => {
        if (list.length === 0) return;
        navigate(list.length === 1 ? `/convert?source=${encodeURIComponent(list[0]!.vanity)}` : '/convert', { state: { files: list } });
      },
      removeViewLimit: anonymous
        ? undefined
        : (file) =>
            viewLimit.mutate(
              { id: file.id, limit: null },
              { onSuccess: () => notify('View limit removed.'), onError: (error) => notify(errorMessage(error), 'error') },
            ),
    }),
    [actions, anonymous, expiry, notify, sensitive, viewLimit, linkDomain, navigate],
  );

  const confirmDelete = (list: OwnerFile[]) => {
    const ids = list.map((file) => file.id);
    setDialog(null);
    if (drawerId && ids.includes(drawerId)) setDrawerId(null);
    remove.mutate(ids, {
      onSuccess: (deleted) => notify(`Deleted ${pluralize(deleted.length, 'file')}.`),
      onError: (error) => notify(`Couldn't delete: ${errorMessage(error)}`, 'error'),
    });
  };

  const data = files.data;
  const pages = data ? pageCount(data.count) : 1;
  // Deleting the last items of the last page: step back to a page that exists.
  useEffect(() => {
    if (data && state.page > pages && !files.isPlaceholderData) update({ page: pages });
  }, [data, pages, state.page, files.isPlaceholderData, update]);

  const filtered = Boolean(state.query || state.type || state.access || state.temporary);
  const viewProps = {
    files: items,
    selection,
    onToggle: (id: string, shift: boolean) => setSelection((current) => toggleSelection(current, order, id, shift)),
    onToggleAll: () => setSelection((current) => toggleAllOnPage(current, order)),
    onOpen: (file: OwnerFile) => setDrawerId(file.id),
    renamingId,
    onRename: (file: OwnerFile, name: string) => {
      setRenamingId(null);
      rename.mutate(
        { id: file.id, name },
        {
          onSuccess: (updated) => notify(`Renamed to ${updated.filename}.`),
          onError: (error) => notify(`Couldn't rename: ${errorMessage(error)}`, 'error'),
        },
      );
    },
    onRenameCancel: () => setRenamingId(null),
    handlers,
    now,
  };

  return (
    <section className={`flex flex-col gap-5 ${selectedFiles.length > 0 ? 'pb-28 sm:pb-0' : ''}`}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
          <p className="text-sm text-muted" aria-live="polite">
            {data
              ? filtered
                ? `${pluralize(data.count, 'file')} match · ${formatBytes(data.size)} (of ${pluralize(data.total.count, 'file')}, ${formatBytes(data.total.size)})`
                : `${pluralize(data.total.count, 'file')} · ${formatBytes(data.total.size)} used`
              : ' '}
          </p>
        </div>
        <Link to="/upload" className={buttonClass('primary')}>
          <FileUp aria-hidden className="size-4" />
          Upload
        </Link>
      </header>

      {anonymous && (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted">
          You're not signed in, so these are the files uploaded from this browser. <SignInLink /> to keep them.
        </p>
      )}

      <FilesToolbar state={state} onChange={update} />

      {files.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Loading files…
        </p>
      ) : files.isError ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-danger" role="alert">
            {errorMessage(files.error)}
          </p>
          <Button onClick={() => void files.refetch()}>Try again</Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-12 text-center">
          {filtered ? (
            <>
              <p className="text-sm text-muted">No files match these filters.</p>
              <Button onClick={() => update({ query: '', type: null, access: null, temporary: false })}>Clear filters</Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">You haven't uploaded anything yet.</p>
              <Link to="/upload" className={buttonClass('primary')}>
                Upload files
              </Link>
            </>
          )}
        </div>
      ) : state.view === 'grid' ? (
        <FilesGrid {...viewProps} />
      ) : narrow ? (
        <FileCardList {...viewProps} />
      ) : (
        <FilesTable {...viewProps} />
      )}

      <Pagination page={state.page} pages={pages} onPage={(page) => update({ page })} />

      {selectedFiles.length > 0 && <BulkBar files={selectedFiles} handlers={handlers} onClear={() => setSelection(EMPTY_SELECTION)} />}

      {drawerFile && (
        <Suspense fallback={null}>
          <FileDrawer file={drawerFile} handlers={handlers} onClose={() => setDrawerId(null)} />
        </Suspense>
      )}

      {dialog?.type === 'delete' && (
        <ConfirmDialog
          title={dialog.files.length === 1 ? `Delete ${dialog.files[0]!.filename}?` : `Delete ${pluralize(dialog.files.length, 'file')}?`}
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(dialog.files)}
          onClose={() => setDialog(null)}
        >
          <p>
            {dialog.files.length === 1 ? 'Its link stops working' : 'Their links stop working'} and {dialog.files.length === 1 ? "it's" : "they're"} removed from
            every album. This can't be undone.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.type === 'expiry' && (
        <ExpiryDialog files={dialog.files} context={{ anonymous, limits: limits.data ?? null }} onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'access' && (
        <AccessDialog
          target={dialog.files.length === 1 ? { kind: 'file', file: dialog.files[0]! } : { kind: 'files', files: dialog.files }}
          anonymous={anonymous}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'review' && (
        <AskReviewDialog
          file={dialog.files[0]!}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            notify('Review requested. A moderator will check it.');
          }}
        />
      )}
      {dialog?.type === 'viewLimit' && <ViewLimitDialog file={dialog.files[0]!} onClose={() => setDialog(null)} />}
      {dialog?.type === 'album' && (
        <AddToAlbumDialog files={dialog.files} onClose={() => setDialog(null)} onDone={() => setSelection(EMPTY_SELECTION)} />
      )}
    </section>
  );
}
