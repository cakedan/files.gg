import { lazy } from 'react';

// The public pages outside /app (milestone-5 §19.1, milestone-7 §7), each its own lazy chunk.
export const ChangelogPage = lazy(() => import('./ChangelogPage'));
export const TermsPage = lazy(() => import('./TermsPage'));
export const PrivacyPage = lazy(() => import('./PrivacyPage'));
export const LinkWarningsPage = lazy(() => import('./LinkWarningsPage'));
