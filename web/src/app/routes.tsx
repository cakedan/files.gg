import { Navigate, type RouteObject } from 'react-router';

import { AdminGate } from './AdminGate';
import { AuthLayout } from './auth/AuthLayout';
import { DiscordPage, ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyPage } from './auth/lazy';
import { DashboardLayout } from './DashboardLayout';
import { ChangelogPage, LinkWarningsPage, PrivacyPage, TermsPage } from './legal/lazy';
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
  HomePage,
  PublicConvertPage,
  ReportPage,
  ReportsPage,
  SettingsPage,
  UploadPage,
} from './pages/lazy';
import { PublicLayout } from './PublicLayout';

/** The dashboard is served under /app/*; these paths are relative to that basename. */
export const APP_BASENAME = '/app';

/** `/app` and `/app/*` use the dashboard's router (`routes`); every other path the public one (`publicRoutes`). */
export const isDashboardPath = (pathname: string) => pathname === APP_BASENAME || pathname.startsWith(`${APP_BASENAME}/`);

/**
 * The public pages this entry serves outside /app, without a basename (milestone-5 §19.1, milestone-7
 * §7): the Worker sends exactly these paths here, and `/legal` to `/legal/terms` (302).
 */
export const publicRoutes: RouteObject[] = [
  {
    element: <PublicLayout />,
    children: [
      // The home page: what files.gg is, the upload box and what else it does.
      { path: '/', element: <HomePage /> },
      // Milestone 5 §13.1: the Convert page without the history.
      { path: '/convert', element: <PublicConvertPage /> },
      { path: '/changelog', element: <ChangelogPage /> },
      { path: '/legal', element: <Navigate to="/legal/terms" replace /> },
      { path: '/legal/terms', element: <TermsPage /> },
      { path: '/legal/privacy', element: <PrivacyPage /> },
      // Milestone 7 §7: what a Web Risk link warning means, one anchor per threat type.
      { path: '/help/link-warnings', element: <LinkWarningsPage /> },
    ],
  },
];

export const routes: RouteObject[] = [
  {
    // Sign-in pages (milestone-6 §6.1): outside the dashboard layout, each a lazy chunk.
    element: <AuthLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'verify', element: <VerifyPage /> },
      { path: 'forgot', element: <ForgotPage /> },
      { path: 'reset', element: <ResetPage /> },
      { path: 'auth/discord', element: <DiscordPage /> },
    ],
  },
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
      // Profile, Uploads, Security, Domains and Data (milestone-6 §13.3, milestone-5 §21), tabs in the URL.
      { path: 'settings/*', element: <SettingsPage /> },
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
