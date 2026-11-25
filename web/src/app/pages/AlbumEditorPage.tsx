import { ArrowLeft, EyeOff, ExternalLink, ImagePlus, KeyRound, Link2, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Button } from '../../components/Button';
import { api, type AlbumLayout, type OwnerAlbum } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { useAlbum, useDeleteAlbum, useRemoveAlbumItem, useSetCaption, useSignedIn, useUpdateAlbum } from '../../lib/queries';
import { SignInLink } from '../components/SignInLink';
import { AccessDialog } from '../access/AccessDialog';
import { fieldClass } from '../access/fieldUtils';
import { AddFilesDialog } from '../albums/AddFilesDialog';
import { AlbumItemCard } from '../albums/AlbumItemCard';
import { CoverDialog } from '../albums/CoverDialog';
import { SortableGrid } from '../albums/SortableGrid';
import { useAlbumOrder, type OrderStatus } from '../albums/useAlbumOrder';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/toastContext';
import { AccessBadge } from '../files/AccessBadge';
import { FileThumb } from '../files/FileThumb';
import { pluralize } from '../files/fileLabels';

const LAYOUTS: Array<{ value: AlbumLayout; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' },
  { value: 'tracklist', label: 'Tracklist (audio)' },
];

const ORDER_LABELS: Record<OrderStatus, string> = {
  idle: '',
  pending: 'Unsaved order…',
  saving: 'Saving order…',
  saved: 'Order saved',
  error: "Couldn't save the order",
};

type DialogState = 'access' | 'add' | 'cover' | 'delete' | null;

/** The album editor at /app/albums/<id> (contract §8). */
export default function AlbumEditorPage() {
  const { id = '' } = useParams();
  const album = useAlbum(id);

  useEffect(() => {
    document.title = `${album.data?.title || 'Album'} · files.gg`;
  }, [album.data?.title]);

  if (album.isPending) {
    return (
      <p role="status" className="py-10 text-center text-sm text-muted">
        Loading album…
      </p>
    );
  }
  if (album.isError) {
    return (
      <section className="flex flex-col items-start gap-3">
        <BackLink />
        <h1 className="text-2xl font-semibold tracking-tight">Album</h1>
        <p className="text-sm text-danger" role="alert">
          {errorMessage(album.error)}
        </p>
      </section>
    );
  }
  return <Editor album={album.data} />;
}

function BackLink() {
  return (
    <Link to="/albums" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ArrowLeft aria-hidden className="size-4" />
      Albums
    </Link>
  );
}

function Editor({ album }: { album: OwnerAlbum }) {
  const id = useId();
  const notify = useToast();
  const navigate = useNavigate();
  const readOnly = !useSignedIn();
  const update = useUpdateAlbum(album.id);
  const caption = useSetCaption(album.id);
  const removeItem = useRemoveAlbumItem(album.id);
  const deleteAlbum = useDeleteAlbum();
  const fail = (prefix: string) => (error: unknown) => notify(`${prefix}: ${errorMessage(error)}`, 'error');
  const { reorder, status } = useAlbumOrder(album.id, fail("Couldn't save the order"));
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);

  const save = (body: Parameters<typeof update.mutate>[0], message?: string) =>
    update.mutate(body, { onSuccess: () => message && notify(message), onError: fail("Couldn't save") });

  const totalSize = album.items.reduce((sum, item) => sum + item.size, 0);
  const hidden = album.items.filter((item) => !item.shown).length;
  const checking = album.items.filter((item) => item.safety?.state === 'pending').length;
  const moderated = album.safety && album.safety.state !== 'ok' ? album.safety : null;
  const cover = album.items.find((item) => item.id === album.cover_file_id);

  const openAlbum = async () => {
    if (album.visibility === 'link') {
      window.open(album.url, '_blank', 'noopener');
      return;
    }
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const pass = await api.albumPass(album.id);
      if (tab) tab.location.href = pass.url;
      else window.location.assign(pass.url);
    } catch (error) {
      tab?.close();
      notify(errorMessage(error), 'error');
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <BackLink />

      <header className="flex flex-col gap-3">
        <TitleField key={album.title} value={album.title} readOnly={readOnly} onSave={(title) => save({ title }, 'Title saved.')} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span>
            {pluralize(album.items.length, 'file')} · {formatBytes(totalSize)}
          </span>
          {hidden > 0 && <span className="text-warn">{pluralize(hidden, 'file')} hidden on the album page</span>}
          {checking > 0 && <span>{pluralize(checking, 'file')} still being checked</span>}
          {album.nsfw && (
            <span className="inline-flex items-center gap-1">
              <EyeOff aria-hidden className="size-3.5" />
              Sensitive
            </span>
          )}
          <AccessBadge visibility={album.visibility} />
          <span aria-live="polite" className={status === 'error' ? 'text-danger' : ''}>
            {ORDER_LABELS[status]}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={async () => notify((await copyText(album.url)) ? 'Link copied.' : "Couldn't copy the link.")}
          >
            <Link2 aria-hidden className="size-4" />
            Copy link
          </Button>
          <Button onClick={() => void openAlbum()}>
            {album.visibility === 'link' ? <ExternalLink aria-hidden className="size-4" /> : <KeyRound aria-hidden className="size-4" />}
            {album.visibility === 'link' ? 'Open' : 'Open as owner'}
          </Button>
          {!readOnly && (
            <>
              <Button onClick={() => setDialog('access')}>
                <Lock aria-hidden className="size-4" />
                Change access…
              </Button>
              <Button variant="danger" onClick={() => setDialog('delete')}>
                <Trash2 aria-hidden className="size-4" />
                Delete album
              </Button>
            </>
          )}
        </div>
        {readOnly && (
          <p className="text-sm text-muted">
            <SignInLink /> to edit albums.
          </p>
        )}
        {moderated && (
          <p role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              {moderated.state === 'hidden'
                ? 'This album is hidden by the files.gg team. Visitors see that it’s unavailable.'
                : 'This album was removed by the files.gg team. Visitors see that it was removed.'}
            </span>
            {moderated.notice_id && (
              <Link to={`/notices/${moderated.notice_id}`} className="font-medium text-gg hover:underline">
                See the notice
              </Link>
            )}
          </p>
        )}
      </header>

      <section aria-label="Album settings" className="grid gap-4 rounded-lg border border-line bg-surface p-4 md:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-4">
          <DescriptionField key={album.description} id={`${id}-description`} value={album.description} readOnly={readOnly} onSave={(description) => save({ description }, 'Description saved.')} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-layout`} className="text-sm font-medium">
              Layout
            </label>
            <select
              id={`${id}-layout`}
              value={album.layout}
              disabled={readOnly}
              onChange={(event) => save({ layout: event.target.value as AlbumLayout }, 'Layout saved.')}
              className={`${fieldClass} max-w-xs`}
            >
              {LAYOUTS.map((layout) => (
                <option key={layout.value} value={layout.value}>
                  {layout.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">Automatic shows a grid, or a tracklist when every file is audio.</p>
          </div>
          <SensitiveSwitch
            marked={Boolean(album.nsfw_marked)}
            fromItems={Boolean(album.nsfw) && !album.nsfw_marked}
            disabled={readOnly}
            onChange={(nsfw) => save({ nsfw }, nsfw ? 'Album marked as sensitive.' : 'Album unmarked.')}
          />
        </div>
        <div className="flex w-full max-w-56 flex-col gap-1.5 md:w-56">
          <span className="text-sm font-medium">Cover</span>
          {cover ? <FileThumb file={cover} size="lg" className="rounded-md" /> : <span className="flex aspect-[4/3] items-center justify-center rounded-md bg-well text-sm text-muted">Automatic</span>}
          {!readOnly && (
            <Button onClick={() => setDialog('cover')} disabled={album.items.length === 0}>
              <ImagePlus aria-hidden className="size-4" />
              Change cover
            </Button>
          )}
        </div>
      </section>

      <section aria-labelledby={`${id}-items`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${id}-items`} className="text-lg font-semibold">
            Files
          </h2>
          {!readOnly && (
            <Button variant="primary" onClick={() => setDialog('add')}>
              <Plus aria-hidden className="size-4" />
              Add files
            </Button>
          )}
        </div>
        {!readOnly && album.items.length > 1 && (
          <p className="text-xs text-muted">Drag the handle to reorder, or focus it and use space and the arrow keys. The order saves by itself.</p>
        )}
        {album.items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-12 text-center">
            <p className="text-sm text-muted">This album is empty. Empty albums are deleted after 7 days.</p>
          </div>
        ) : (
          <SortableGrid
            items={album.items}
            nameOf={(item) => item.filename}
            onReorder={reorder}
            disabled={readOnly}
            renderItem={(item, handle) => (
              <AlbumItemCard
                item={item}
                album={album}
                index={album.items.indexOf(item)}
                handle={handle}
                readOnly={readOnly}
                onCaption={(text) => caption.mutate({ fileId: item.id, caption: text }, { onSuccess: () => notify('Caption saved.'), onError: fail("Couldn't save the caption") })}
                onRemove={() =>
                  removeItem.mutate(item.id, { onSuccess: () => notify(`Removed ${item.filename} from the album.`), onError: fail("Couldn't remove it") })
                }
              />
            )}
          />
        )}
      </section>

      {dialog === 'access' && <AccessDialog target={{ kind: 'album', album }} anonymous={readOnly} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddFilesDialog album={album} onClose={() => setDialog(null)} />}
      {dialog === 'cover' && <CoverDialog album={album} onSave={(fileId) => save({ cover_file_id: fileId }, 'Cover saved.')} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${album.title || 'this album'}?`}
          confirmLabel={deleteFiles ? 'Delete album and files' : 'Delete album'}
          pendingLabel="Deleting…"
          pending={deleteAlbum.isPending}
          error={deleteAlbum.isError ? errorMessage(deleteAlbum.error) : null}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            deleteAlbum.mutate(
              { id: album.id, deleteFiles },
              {
                onSuccess: () => {
                  notify(deleteFiles ? `Deleted the album and ${pluralize(album.items.length, 'file')}.` : 'Album deleted. Its files are still in your library.');
                  navigate('/albums');
                },
              },
            )
          }
        >
          <p>The album link stops working. This can't be undone.</p>
          <label className="flex items-center gap-2 text-text">
            <input type="checkbox" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} className="accent-gg" />
            Also delete the files ({pluralize(album.items.length, 'file')})
          </label>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** "Mark album as sensitive" (milestone-4 §4.5, §11.2): the album's own mark. */
function SensitiveSwitch({ marked, fromItems, disabled, onChange }: { marked: boolean; fromItems: boolean; disabled: boolean; onChange: (nsfw: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={marked}
          disabled={disabled}
          onClick={() => onChange(!marked)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${marked ? 'border-gg bg-gg' : 'border-line bg-surface-2'}`}
        >
          <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${marked ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
        <label htmlFor={id} className="text-sm font-medium">
          Mark album as sensitive
        </label>
      </div>
      <p className="text-xs text-muted">
        {fromItems
          ? 'Some files in it are marked as sensitive, so visitors see a warning first either way.'
          : 'Visitors see a warning before the album opens. Only signed-in users can mark albums.'}
      </p>
    </div>
  );
}

function TitleField({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const title = draft.trim();
    if (title !== value) onSave(title);
  };
  return (
    <h1 className="text-2xl font-semibold tracking-tight">
      <input
        aria-label="Album title"
        value={draft}
        readOnly={readOnly}
        maxLength={100}
        placeholder="Untitled album"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setDraft(value);
        }}
        className="w-full rounded-md border border-transparent bg-transparent px-1 -mx-1 hover:border-line focus:border-gg/60 focus:bg-bg focus:outline-none read-only:hover:border-transparent placeholder:text-muted"
      />
    </h1>
  );
}

function DescriptionField({ id, value, readOnly, onSave }: { id: string; value: string; readOnly: boolean; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Description
      </label>
      <textarea
        id={id}
        value={draft}
        readOnly={readOnly}
        maxLength={2000}
        rows={3}
        placeholder="Plain text. Links become clickable."
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== value && onSave(draft)}
        className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-sm placeholder:text-muted/70"
      />
    </div>
  );
}
