import { lazy } from 'react';

// Each page is its own chunk (PLAN.md §2: "the dashboard, with lazy-loaded routes").
// DashboardLayout wraps the outlet in Suspense.
export const OverviewPage = lazy(() => import('./OverviewPage'));
export const FilesPage = lazy(() => import('./FilesPage'));
export const UploadPage = lazy(() => import('./UploadPage'));
export const ConvertPage = lazy(() => import('./ConvertPage'));
export const AlbumsPage = lazy(() => import('./AlbumsPage'));
export const IntegrationsPage = lazy(() => import('./IntegrationsPage'));
export const SettingsPage = lazy(() => import('./SettingsPage'));
export const ReportsPage = lazy(() => import('./ReportsPage'));
export const NoticesPage = lazy(() => import('./NoticesPage'));
export const NotFoundPage = lazy(() => import('./NotFoundPage'));
