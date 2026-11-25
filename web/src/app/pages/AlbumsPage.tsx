import { Plus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { errorMessage } from '../../lib/errors';
import { useCreateAlbum, useMyAlbums, useSignedIn } from '../../lib/queries';
import { SignInLink } from '../components/SignInLink';
import { RELATIVE_REFRESH_MS, formatRelative } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { fieldClass } from '../access/fieldUtils';
import { AlbumCover } from '../albums/AlbumCover';
import { Dialog } from '../components/Dialog';
import { AccessBadge } from '../files/AccessBadge';
import { pluralize } from '../files/fileLabels';
import { Pagination } from '../files/Pagination';

const PER_PAGE = 24;

function NewAlbumDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const create = useCreateAlbum();
  const navigate = useNavigate();
  const save = () => create.mutate({ title: title.trim(), file_ids: [] }, { onSuccess: (album) => navigate(`/albums/${album.id}`) });
  return (
    <Dialog
      title="New album"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create album'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor={`${id}-title`} className="text-sm font-medium">
          Title
        </label>
        <input id={`${id}-title`} value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} className={fieldClass} placeholder="Untitled album" />
        <p className="text-xs text-muted">You can add files next.</p>
        {create.isError && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(create.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Albums (contract §8): a card grid with the collage or cover, title, count and updated time. */
export default function AlbumsPage() {
  useEffect(() => {
    document.title = 'Albums · files.gg';
  }, []);
  const anonymous = !useSignedIn();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const albums = useMyAlbums({ offset: (page - 1) * PER_PAGE, limit: PER_PAGE });
  const [creating, setCreating] = useState(false);
  const now = useNow(RELATIVE_REFRESH_MS);
  const pages = Math.max(1, Math.ceil((albums.data?.count ?? 0) / PER_PAGE));

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Albums</h1>
          <p className="text-sm text-muted">Group files behind one link, reorder them and add captions.</p>
        </div>
        {!anonymous && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden className="size-4" />
            New album
          </Button>
        )}
      </header>

      {anonymous && (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted">
          Without an account, albums are made from a multi-file upload and can't be edited afterwards. <SignInLink /> to make and edit albums.
        </p>
      )}

      {albums.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Loading albums…
        </p>
      ) : albums.isError ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-danger" role="alert">
            {errorMessage(albums.error)}
          </p>
          <Button onClick={() => void albums.refetch()}>Try again</Button>
        </div>
      ) : albums.data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-12 text-center">
          <p className="text-sm text-muted">No albums yet. Make one here, or pick files on the Files page and choose Add to album.</p>
          {!anonymous && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New album
            </Button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {albums.data.items.map((album) => (
            <li key={album.id}>
              <Link
                to={`/albums/${album.id}`}
                className="group flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-gg/50"
              >
                <AlbumCover album={album} />
                <span className="flex flex-col gap-1 p-3">
                  <span className="truncate font-medium group-hover:text-gg">{album.title || 'Untitled album'}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{pluralize(album.count, 'file')}</span>
                    <span>Updated {formatRelative(album.updated_at * 1000, now)}</span>
                    <AccessBadge visibility={album.visibility} />
                    {album.safety && album.safety.state !== 'ok' && (
                      <span className="rounded bg-warn/15 px-1.5 py-0.5 font-medium text-warn">{album.safety.state === 'hidden' ? 'Hidden' : 'Removed'}</span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Pagination page={page} pages={pages} onPage={(next) => setParams(next > 1 ? { page: String(next) } : {})} />
      {creating && <NewAlbumDialog onClose={() => setCreating(false)} />}
    </section>
  );
}
