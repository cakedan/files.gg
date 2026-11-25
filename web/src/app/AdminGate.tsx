import { lazy } from 'react';

import { hasToken } from '../lib/api';
import { useMe } from '../lib/queries';
import { NotFoundPage } from './pages/lazy';

/** The admin pages are their own lazy chunk (milestone-4 §11.3), downloaded by staff only. */
const AdminApp = lazy(() => import('./admin/AdminApp'));

/**
 * `/app/admin/*`: `NotFoundPage` unless `GET /users/@me` has `staff`. The API enforces
 * access regardless (§9.1), so this only keeps the chunk away from everyone else.
 */
export function AdminGate() {
  const signedIn = hasToken();
  const me = useMe(signedIn);
  if (signedIn && me.isPending) {
    return (
      <p role="status" className="text-sm text-muted">
        Loading…
      </p>
    );
  }
  if (!me.data?.staff) return <NotFoundPage />;
  return <AdminApp staff={me.data.staff} />;
}
