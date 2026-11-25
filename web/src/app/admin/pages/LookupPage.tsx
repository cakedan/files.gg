import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../../../components/Button';
import { fieldClass } from '../../access/fieldUtils';
import { useLookup } from '../adminQueries';
import { Failure, Loading, Section, TargetState } from '../components/bits';

/** `/app/admin/lookup` (§9.6): a vanity, any files.gg or CDN URL, a user id, an exact email or a username. */
export default function LookupPage() {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const result = useLookup(q);
  useEffect(() => {
    document.getElementById(`${id}-q`)?.focus();
  }, [id]);
  const data = result.data;
  const total = data ? data.files.length + data.albums.length + data.users.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Lookup</h2>
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setParams(draft.trim() ? { q: draft.trim() } : {});
        }}
      >
        <div className="flex min-w-60 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-q`} className="text-sm font-medium">
            Vanity, link, user id, email or username
          </label>
          <input id={`${id}-q`} value={draft} onChange={(event) => setDraft(event.target.value)} className={fieldClass} />
        </div>
        <Button type="submit" variant="primary">
          <Search aria-hidden className="size-4" />
          Look up
        </Button>
      </form>
      <p className="sr-only" aria-live="polite" role="status">
        {data ? `${total} ${total === 1 ? 'result' : 'results'}` : ''}
      </p>
      {!q ? null : result.isPending ? (
        <Loading label="Looking up…" />
      ) : result.isError ? (
        <Failure error={result.error} />
      ) : total === 0 ? (
        <p className="text-sm text-muted">Nothing found.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Section title={`Files (${data!.files.length})`}>
            <ul className="flex flex-col gap-1 text-sm">
              {data!.files.map((file) => (
                <li key={file.id} className="flex items-center gap-2">
                  <Link to={`/admin/files/${file.id}`} className="min-w-0 truncate text-gg hover:underline">
                    {file.filename}
                  </Link>
                  <TargetState state={file.deleted ? 'deleted' : (file.safety?.state ?? 'ok')} />
                </li>
              ))}
            </ul>
          </Section>
          <Section title={`Albums (${data!.albums.length})`}>
            <ul className="flex flex-col gap-1 text-sm">
              {data!.albums.map((album) => (
                <li key={album.id}>
                  <Link to={`/admin/albums/${album.id}`} className="text-gg hover:underline">
                    {album.title || album.vanity}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
          <Section title={`Accounts (${data!.users.length})`}>
            <ul className="flex flex-col gap-1 text-sm">
              {data!.users.map((user) => (
                <li key={user.id} className="flex flex-wrap gap-x-2">
                  <Link to={`/admin/users/${user.id}`} className="text-gg hover:underline">
                    {user.username}
                  </Link>
                  <span className="text-xs text-muted">{user.id}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </div>
  );
}
