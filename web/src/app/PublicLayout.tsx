import { Suspense } from 'react';
import { Outlet } from 'react-router';

/**
 * The dashboard entry's public pages, outside /app (milestone-5 §11, §19.1): readable signed out,
 * each a lazy chunk with its own layout.
 */
export function PublicLayout() {
  return (
    <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
      <Outlet />
    </Suspense>
  );
}
