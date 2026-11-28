import { Images, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useAddToAlbum, useMyAlbums } from '../../lib/queries';
import { fieldClass } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';
import { useDebounced } from '../components/useDebounced';
import { useToast } from '../components/toastContext';
import { pluralize } from './fileLabels';

const NEW = '__new__';

/** "Add to album…": append to an existing album, or make a new one from the selection. */
export function AddToAlbumDialog({ files, onClose, onDone }: { files: OwnerFile[]; onClose: () => void; onDone?: () => void }) {
  const id = useId();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const albums = useMyAlbums({ query: query || undefined, limit: 50 });
  const [choice, setChoice] = useState<string>(NEW);
  const [title, setTitle] = useState('');
  const mutation = useAddToAlbum();
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);

  const save = () => {
    const ids = files.map((file) => file.id);
    mutation.mutate(choice === NEW ? { ids, newAlbum: { title: title.trim() } } : { ids, albumId: choice }, {
      onSuccess: (album) => {
        notify(`Added ${pluralize(files.length, 'file')} to ${album.title || 'the album'}.`);
        onDone?.();
        setCreated({ id: album.id, title: album.title || 'Untitled album' });
      },
    });
  };

  if (created) {
    return (
      <Dialog
        title="Added to album"
        onClose={onClose}
        size="sm"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="text-sm">
          {pluralize(files.length, 'file')} added to{' '}
          <Link to={`/albums/${created.id}`} className="font-medium text-gg hover:underline" onClick={onClose}>
            {created.title}
          </Link>
          .
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Add to album"
      description={pluralize(files.length, 'file')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : choice === NEW ? 'Create album' : 'Add'}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Album</legend>
        <label className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${choice === NEW ? 'border-gg/60 bg-surface-2' : 'border-line'}`}>
          <input type="radio" name={`${id}-album`} checked={choice === NEW} onChange={() => setChoice(NEW)} className="accent-gg" />
          <Plus aria-hidden className="size-4" />
          New album
        </label>
        {choice === NEW && (
          <div className="flex flex-col gap-1 pl-7">
            <label htmlFor={`${id}-title`} className="text-xs text-muted">
              Title (optional)
            </label>
            <input id={`${id}-title`} value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} className={fieldClass} />
          </div>
        )}

        <div className="mt-2 flex flex-col gap-2">
          <label htmlFor={`${id}-search`} className="text-sm font-medium">
            Or an existing album
          </label>
          <input
            id={`${id}-search`}
            type="search"
            placeholder="Search your albums"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={fieldClass}
          />
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {albums.isPending && <p className="text-sm text-muted">Loading albums…</p>}
            {albums.isError && <p className="text-sm text-danger">{errorMessage(albums.error)}</p>}
            {albums.data?.items.length === 0 && <p className="text-sm text-muted">{query ? 'No albums match.' : 'You have no albums yet.'}</p>}
            {albums.data?.items.map((album) => (
              <label
                key={album.id}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${choice === album.id ? 'border-gg/60 bg-surface-2' : 'border-line'}`}
              >
                <input type="radio" name={`${id}-album`} checked={choice === album.id} onChange={() => setChoice(album.id)} className="accent-gg" />
                <Images aria-hidden className="size-4 text-muted" />
                <span className="min-w-0 flex-1 truncate">{album.title || 'Untitled album'}</span>
                <span className="text-xs text-muted">{pluralize(album.count, 'file')}</span>
              </label>
            ))}
          </div>
        </div>
      </fieldset>
      {mutation.isError && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {errorMessage(mutation.error)}
        </p>
      )}
    </Dialog>
  );
}
