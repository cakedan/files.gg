import { LayoutGrid, List, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { FILE_TYPE_FILTERS, type FileSort, type FileTypeFilter, type Visibility } from '../../lib/api';
import type { FilesUrlState } from '../../lib/files/urlState';
import { fieldClass } from '../access/fieldUtils';
import { Chip } from '../components/Chip';
import { useDebounced } from '../components/useDebounced';

const SORTS: Array<{ value: FileSort; label: string }> = [
  { value: '-created', label: 'Newest' },
  { value: 'created', label: 'Oldest' },
  { value: '-size', label: 'Largest' },
  { value: 'size', label: 'Smallest' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: '-name', label: 'Name (Z–A)' },
];

const TYPE_LABELS: Record<FileTypeFilter, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  text: 'Text',
  pdf: 'PDFs',
  other: 'Other',
};

export const SEARCH_DEBOUNCE_MS = 300;

interface FilesToolbarProps {
  state: FilesUrlState;
  onChange: (patch: Partial<FilesUrlState>) => void;
}

/** Debounced search, sort, type chips, access filter, "Temporary", and the table/grid toggle. */
export function FilesToolbar({ state, onChange }: FilesToolbarProps) {
  const id = useId();
  const [search, setSearch] = useState(state.query);
  const debounced = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  // Push the debounced text to the URL; follow the URL when it changes elsewhere (Back).
  const [lastUrlQuery, setLastUrlQuery] = useState(state.query);
  if (lastUrlQuery !== state.query) {
    setLastUrlQuery(state.query);
    if (state.query !== search.trim()) setSearch(state.query);
  }
  useEffect(() => {
    if (debounced !== state.query) onChange({ query: debounced });
    // Only when the debounced text settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
          <input
            type="search"
            aria-label="Search files"
            placeholder="Search by name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${fieldClass} w-full pl-8`}
          />
        </div>
        <label htmlFor={`${id}-sort`} className="sr-only">
          Sort
        </label>
        <select id={`${id}-sort`} value={state.sort} onChange={(event) => onChange({ sort: event.target.value as FileSort })} className={fieldClass}>
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>
              {sort.label}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-access`} className="sr-only">
          Access
        </label>
        <select
          id={`${id}-access`}
          value={state.access ?? ''}
          onChange={(event) => onChange({ access: (event.target.value || null) as Visibility | null })}
          className={fieldClass}
        >
          <option value="">Any access</option>
          <option value="link">Anyone with the link</option>
          <option value="password">Password</option>
          <option value="private">Only me</option>
        </select>
        <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={state.view === 'table'}
            aria-label="Table view"
            title="Table view"
            onClick={() => onChange({ view: 'table' })}
            className="rounded p-1.5 text-muted hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text"
          >
            <List aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            aria-pressed={state.view === 'grid'}
            aria-label="Grid view"
            title="Grid view"
            onClick={() => onChange({ view: 'grid' })}
            className="rounded p-1.5 text-muted hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text"
          >
            <LayoutGrid aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by type">
        <Chip pressed={state.type === null} onClick={() => onChange({ type: null })}>
          All
        </Chip>
        {FILE_TYPE_FILTERS.map((type) => (
          <Chip key={type} pressed={state.type === type} onClick={() => onChange({ type: state.type === type ? null : type })}>
            {TYPE_LABELS[type]}
          </Chip>
        ))}
        <span aria-hidden className="mx-1 w-px shrink-0 bg-line" />
        <Chip pressed={state.temporary} onClick={() => onChange({ temporary: !state.temporary })}>
          Temporary
        </Chip>
      </div>
    </div>
  );
}
