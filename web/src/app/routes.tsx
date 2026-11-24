import type { RouteObject } from 'react-router';

import { DashboardLayout } from './DashboardLayout';
import {
  AlbumsPage,
  ConvertPage,
  FilesPage,
  IntegrationsPage,
  NotFoundPage,
  NoticesPage,
  OverviewPage,
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
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'notices', element: <NoticesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
