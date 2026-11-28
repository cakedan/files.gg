import { Search } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerAlbumSummary, OwnerFile } from '../../lib/api';
import { sourceKindOf } from '../../lib/convertKinds';
import { formatBytes } from '../../lib/format';
import { useMyAlbums, useMyFiles } from '../../lib/queries';
import { fieldClass } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';
import { useDebounced } from '../components/useDebounced';
import { pluralize } from '../files/fileLabels';
import { FileThumb } from '../files/FileThumb';

const PAGE = 30;

function SearchField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const id = useId();
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input id={id} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Search" className={`${fieldClass} w-full pl-8`} />
    </div>
  );
}

/** §13.1 step 1: pick one file from your library. Files with no targets are shown but can't be picked. */
export function LibraryPicker({ onPick, onClose }: { onPick: (file: OwnerFile) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const files = useMyFiles({ query: query || undefined, limit: PAGE });
  const items = files.data?.items ?? [];
  return (
    <Dialog title="Pick a file" onClose={onClose} size="lg">
      <div className="flex flex-col gap-3">
        <SearchField value={search} onChange={setSearch} label="Search your files" />
        {files.isPending ? (
          <p className="text-sm text-muted" role="status">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">No files found.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {items.map((file) => {
              const convertible = sourceKindOf(file) !== null && (file.safety?.state ?? 'ok') !== 'pending';
              return (
                <li key={file.id}>
                  <button
                    type="button"
                    disabled={!convertible}
                    onClick={() => onPick(file)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <FileThumb file={file} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{file.filename}</span>
                      <span className="block text-xs text-muted">{convertible ? formatBytes(file.size) : 'Can’t be converted'}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** §13.1 step 1: pick an album (its images become one PDF, or everything is converted as a batch). */
export function AlbumPicker({ onPick, onClose }: { onPick: (album: OwnerAlbumSummary) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const albums = useMyAlbums({ query: query || undefined, limit: PAGE });
  const items = albums.data?.items ?? [];
  return (
    <Dialog title="Pick an album" onClose={onClose} size="md" footer={<Button onClick={onClose}>Cancel</Button>}>
      <div className="flex flex-col gap-3">
        <SearchField value={search} onChange={setSearch} label="Search your albums" />
        {albums.isPending ? (
          <p className="text-sm text-muted" role="status">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">No albums found.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {items.map((album) => (
              <li key={album.id}>
                <button type="button" onClick={() => onPick(album)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{album.title || 'Untitled album'}</span>
                    <span className="block text-xs text-muted">{pluralize(album.count, 'file')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
