import { Suspense, useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router';

import { Lockup } from '../../components/Brand';
import { SiteFooter } from '../../components/SiteFooter';
import { useSessionSync } from '../../lib/session';
import { Toaster } from '../components/Toaster';

/**
 * The sign-in pages (milestone-6 §6.1): routes of the dashboard entry, outside the
 * dashboard layout, as a plain centred card with the logo.
 */
export function AuthLayout() {
  useSessionSync();
  return (
    <Toaster>
      <div className="flex min-h-dvh flex-col items-center px-4 py-8 sm:justify-center sm:py-12">
        <a href="/" aria-label="files.gg home" className="mb-6 rounded-sm">
          <Lockup className="h-9 w-auto" />
        </a>
        <main className="w-full max-w-sm">
          <Suspense
            fallback={
              <p role="status" className="text-center text-sm text-muted">
                Loading…
              </p>
            }
          >
            <Outlet />
          </Suspense>
        </main>
        <SiteFooter className="mt-8" />
      </div>
    </Toaster>
  );
}

/** The card every auth page renders into. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · files.gg`;
  }, [title]);
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <div className="text-sm text-muted">{description}</div>}
        </header>
        {children}
      </section>
      {footer && <div className="text-center text-sm text-muted">{footer}</div>}
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

/** "or", between the form and Continue with Discord. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
