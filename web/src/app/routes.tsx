import type { RouteObject } from 'react-router';

import { AdminGate } from './AdminGate';
import { DashboardLayout } from './DashboardLayout';
import {
  AlbumEditorPage,
  AlbumsPage,
  ConvertPage,
  FilesPage,
  IntegrationsPage,
  NotFoundPage,
  NoticePage,
  NoticesPage,
  OverviewPage,
  ReportPage,
  ReportsPage,
  SettingsPage,
  UploadPage,
} from './pages/lazy';

/** The dashboard is served under /app/*; these paths are relative to that basename. */
export const APP_BASENAME = '/app';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <DashboardLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'files', element: <FilesPage /> },
      { path: 'upload', element: <UploadPage /> },
      { path: 'convert', element: <ConvertPage /> },
      { path: 'albums', element: <AlbumsPage /> },
      { path: 'albums/:id', element: <AlbumEditorPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'reports/:id', element: <ReportPage /> },
      { path: 'notices', element: <NoticesPage /> },
      { path: 'notices/:id', element: <NoticePage /> },
      // Staff only; a lazy chunk with its own routes (milestone-4 §11.3).
      { path: 'admin/*', element: <AdminGate /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
