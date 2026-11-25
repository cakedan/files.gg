import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes } from 'react-router';

import type { StaffInfo } from '../../lib/api';
import NotFoundPage from '../pages/NotFoundPage';
import { AdminLayout } from './AdminLayout';
import AlbumPage from './pages/AlbumPage';
import AuditPage from './pages/AuditPage';
import BansPage from './pages/BansPage';
import CasePage from './pages/CasePage';
import DomainPage from './pages/DomainPage';
import FilePage from './pages/FilePage';
import LookupPage from './pages/LookupPage';
import OverviewPage from './pages/OverviewPage';
import QueuePage from './pages/QueuePage';
import UserPage from './pages/UserPage';
import { StaffContext } from './staffContext';
import { Loading } from './components/bits';

/** `/app/admin/domains` (milestone-6 §10.12): rarely opened, so a lazy chunk inside the admin chunk. */
const DomainsPage = lazy(() => import('./pages/DomainsPage'));

/**
 * The admin pages at `/app/admin/*` (milestone-4 §11.3), one lazy chunk loaded only for
 * staff (AdminGate). Routes are relative to `/admin`.
 */
export default function AdminApp({ staff }: { staff: StaffInfo }) {
  useEffect(() => {
    document.title = 'Admin · files.gg';
  }, []);
  return (
    <StaffContext.Provider value={staff}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="queue" element={<QueuePage />} />
          <Route path="bugs" element={<QueuePage bugs />} />
          <Route path="cases/:id" element={<CasePage />} />
          <Route path="files/:id" element={<FilePage />} />
          <Route path="albums/:id" element={<AlbumPage />} />
          <Route path="users/:id" element={<UserPage />} />
          <Route
            path="domains"
            element={
              <Suspense fallback={<Loading label="Loading domains…" />}>
                <DomainsPage />
              </Suspense>
            }
          />
          <Route path="domains/:id" element={<DomainPage />} />
          <Route path="lookup" element={<LookupPage />} />
          <Route path="bans" element={<BansPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </StaffContext.Provider>
  );
}
