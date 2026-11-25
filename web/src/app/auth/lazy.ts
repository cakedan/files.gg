import { lazy } from 'react';

// The sign-in pages (milestone-6 §6.1), each its own lazy chunk.
export const LoginPage = lazy(() => import('./LoginPage'));
export const RegisterPage = lazy(() => import('./RegisterPage'));
export const VerifyPage = lazy(() => import('./VerifyPage'));
export const ForgotPage = lazy(() => import('./ForgotPage'));
export const ResetPage = lazy(() => import('./ResetPage'));
export const DiscordPage = lazy(() => import('./DiscordPage'));
