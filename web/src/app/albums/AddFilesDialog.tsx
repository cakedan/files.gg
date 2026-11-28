import { Search } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import { FILE_TYPE_FILTERS, type FileTypeFilter, type OwnerAlbum } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { useAddAlbumItems, useMyFiles } from '../../lib/queries';
import { fieldClass } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';
import { useDebounced } from '../components/useDebounced';
import { useToast } from '../components/toastContext';
import { pluralize } from '../files/fileLabels';
import { FileThumb } from '../files/FileThumb';

const PICKER_PAGE = 40;
const TYPE_LABELS: Record<FileTypeFilter, string> = { image: 'Images', video: 'Videos', audio: 'Audio', text: 'Text', pdf: 'PDFs', other: 'Other' };

/** "Add files": a picker over your library, with search and type filters. */
export function AddFilesDialog({ album, onClose }: { album: OwnerAlbum; onClose: () => void }) {
  const id = useId();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const [type, setType] = useState<FileTypeFilter | null>(null);
  const [page, setPage] = useState(0);
  const files = useMyFiles({ query: query || undefined, type: type ?? undefined, offset: page * PICKER_PAGE, limit: PICKER_PAGE });
  const [picked, setPicked] = useState<string[]>([]);
  const inAlbum = new Set(album.items.map((item) => item.id));
  const add = useAddAlbumItems(album.id);
  const pages = Math.max(1, Math.ceil((files.data?.count ?? 0) / PICKER_PAGE));

  const toggle = (fileId: string) => setPicked((list) => (list.includes(fileId) ? list.filter((x) => x !== fileId) : [...list, fileId]));
  const save = () =>
    add.mutate(picked, {
      onSuccess: () => {
        notify(`Added ${pluralize(picked.length, 'file')} to the album.`);
        onClose();
      },
    });

  return (
    <Dialog
      title="Add files"
      description="Pick files from your library."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted" aria-live="polite">
            {picked.length > 0 ? `${pluralize(picked.length, 'file')} picked` : ''}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={picked.length === 0 || add.isPending}>
            {add.isPending ? 'Adding…' : picked.length > 0 ? `Add ${pluralize(picked.length, 'file')}` : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
          <input
            type="search"
            aria-label="Search your files"
            placeholder="Search by name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            className={`${fieldClass} w-full pl-8`}
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
          {[null, ...FILE_TYPE_FILTERS].map((value) => (
            <button
              key={value ?? 'all'}
              type="button"
              aria-pressed={type === value}
              onClick={() => {
                setType(value);
                setPage(0);
              }}
              className={`h-7 rounded-full border px-2.5 text-xs ${type === value ? 'border-gg/60 bg-gg/10 text-gg' : 'border-line text-muted hover:text-text'}`}
            >
              {value ? TYPE_LABELS[value] : 'All'}
            </button>
          ))}
        </div>

        {files.isPending ? (
          <p role="status" className="py-6 text-center text-sm text-muted">
            Loading files…
          </p>
        ) : files.isError ? (
          <p role="alert" className="py-6 text-center text-sm text-danger">
            {errorMessage(files.error)}
          </p>
        ) : files.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No files match.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Your files">
            {files.data.items.map((file) => {
              const already = inAlbum.has(file.id);
              const checked = already || picked.includes(file.id);
              return (
                <li key={file.id}>
                  <label
                    className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border ${checked ? 'border-gg/70 bg-gg/5' : 'border-line'} ${already ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    <FileThumb file={file} size="lg" />
                    <span className="flex items-start gap-1.5 p-1.5">
                      <input
                        id={`${id}-${file.id}`}
                        type="checkbox"
                        checked={checked}
                        disabled={already}
                        onChange={() => toggle(file.id)}
                        className="mt-0.5 size-4 shrink-0 accent-gg"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium" title={file.filename}>
                          {file.filename}
                        </span>
                        <span className="text-[11px] text-muted">{already ? 'Already in this album' : formatBytes(file.size)}</span>
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" onClick={() => setPage(page - 1)} disabled={page === 0}>
              Previous
            </Button>
            <span className="text-sm text-muted">
              Page {page + 1} of {pages}
            </span>
            <Button variant="ghost" onClick={() => setPage(page + 1)} disabled={page + 1 >= pages}>
              Next
            </Button>
          </div>
        )}
        {add.isError && (
          <p className="text-sm text-danger" role="alert">
            {errorMessage(add.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
