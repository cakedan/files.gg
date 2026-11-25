import { Menu, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';

import { Lockup } from '../components/Brand';
import { hasToken, type Badges } from '../lib/api';
import { useBadges, useMe } from '../lib/queries';
import { Toaster } from './components/Toaster';
import { ADMIN_NAV_ITEM, NAV_ITEMS, type NavItem } from './nav';
import { NoticesBanner, SuspendedBanner } from './notices/NoticesBanner';
import { CountBadge } from './safety/SafetyBadge';

interface NavState {
  items: readonly NavItem[];
  badges: Badges | undefined;
}

function badgeFor(item: NavItem, badges: Badges | undefined) {
  if (!badges || !item.badge) return null;
  if (item.badge === 'reports') return <CountBadge count={badges.reports_unread} label="unread" />;
  if (item.badge === 'notices') return <CountBadge count={badges.notices_unacknowledged} label="new" />;
  return badges.staff ? <CountBadge count={badges.staff.open} urgent={badges.staff.p0 > 0} label={badges.staff.p0 > 0 ? 'open, with P0 cases' : 'open'} /> : null;
}

function SidebarNav({ nav, onNavigate }: { nav: NavState; onNavigate?: () => void }) {
  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-0.5 px-3">
      {nav.items.map((item) => {
        const { path, label, icon: Icon } = item;
        return (
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
              {badgeFor(item, nav.badges)}
            </>
          )}
        </NavLink>
        );
      })}
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

function MobileDrawer({ open, onClose, nav }: { open: boolean; onClose: () => void; nav: NavState }) {
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
        <SidebarNav nav={nav} onNavigate={onClose} />
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
  const signedIn = hasToken();
  const me = useMe(signedIn);
  const badges = useBadges(signedIn);
  const restrictions = badges.data?.restrictions ?? me.data?.restrictions ?? [];
  // §8.4 / §11.2: a suspended account sees only Notices.
  const suspension = restrictions.find((restriction) => restriction.kind === 'suspended') ?? null;
  const staff = me.data?.staff ?? null;
  const items = suspension ? NAV_ITEMS.filter((item) => item.badge === 'notices') : staff ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
  const nav: NavState = { items, badges: badges.data };
  const unacknowledged = badges.data?.notices_unacknowledged ?? 0;
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
          <SidebarNav nav={nav} />
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
            {suspension ? <SuspendedBanner /> : unacknowledged > 0 && <NoticesBanner count={unacknowledged} />}
            <Suspense fallback={<PageFallback />}>
              {suspension && !pathname.startsWith('/notices') ? <Navigate to="/notices" replace /> : <Outlet />}
            </Suspense>
          </main>
        </div>

        <MobileDrawer open={drawerOpen} onClose={closeDrawer} nav={nav} />
      </div>
    </Toaster>
  );
}
