import { Menu, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { Lockup } from '../components/Brand';
import { Toaster } from './components/Toaster';
import { NAV_ITEMS } from './nav';

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60 hover:text-text'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Icon aria-hidden className={`size-4 shrink-0 ${isActive ? 'text-gg' : ''}`} />
              <span className="truncate">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarHeader() {
  return (
    <div className="flex h-16 shrink-0 items-center px-6">
      <a href="/" aria-label="files.gg home" className="rounded-sm">
        <Lockup className="h-8 w-auto max-w-full" />
      </a>
    </div>
  );
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface pb-4">
        <div className="flex items-center justify-between pr-3">
          <SidebarHeader />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <SidebarNav onNavigate={onClose} />
      </aside>
    </div>
  );
}

function PageFallback() {
  return (
    <div role="status" aria-live="polite" className="text-sm text-muted">
      Loading…
    </div>
  );
}

export function DashboardLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const [lastPath, setLastPath] = useState(pathname);

  // Close the drawer on navigation (including back/forward).
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setDrawerOpen(false);
  }

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <Toaster>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
          <SidebarHeader />
          <SidebarNav />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-bg/95 px-2 backdrop-blur lg:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
            >
              <Menu aria-hidden className="size-5" />
            </button>
            <a href="/" aria-label="files.gg home" className="rounded-sm">
              <Lockup className="h-8 w-auto" />
            </a>
          </header>

          <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </main>
        </div>

        <MobileDrawer open={drawerOpen} onClose={closeDrawer} />
      </div>
    </Toaster>
  );
}
