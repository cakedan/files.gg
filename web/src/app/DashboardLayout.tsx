import { Menu, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { Lockup } from '../components/Brand';
import { SiteFooter } from '../components/SiteFooter';
import { onAuthEvent, type Badges, type User } from '../lib/api';
import { useChangelogUnread } from '../lib/changelog';
import { useBadges } from '../lib/queries';
import { loginPath, SESSION_QUERY_KEY, signedOut, useSession, useSessionSync } from '../lib/session';
import { AccountBanner } from './account/AccountBanner';
import { AccountMenu } from './account/AccountMenu';
import { NeedsUsernameDialog } from './account/NeedsUsernameDialog';
import { PendingDeletionScreen } from './account/PendingDeletionScreen';
import { Toaster } from './components/Toaster';
import { useToast } from './components/toastContext';
import { ADMIN_NAV_ITEM, NAV_GROUPS, NAV_ITEMS, PRIMARY_NAV_PATH, SUSPENDED_PATHS, type NavItem } from './nav';
import { NoticesBanner, SuspendedBanner } from './notices/NoticesBanner';
import { CountBadge } from './safety/SafetyBadge';

interface NavState {
  items: readonly NavItem[];
  badges: Badges | undefined;
  user: User | null;
  pathname: string;
}

function badgeFor(item: NavItem, badges: Badges | undefined) {
  if (!badges || !item.badge) return null;
  if (item.badge === 'reports') return <CountBadge count={badges.reports_unread} label="unread" />;
  if (item.badge === 'notices') return <CountBadge count={badges.notices_unacknowledged} label="new" />;
  return badges.staff ? <CountBadge count={badges.staff.open} urgent={badges.staff.p0 > 0} label={badges.staff.p0 > 0 ? 'open, with P0 cases' : 'open'} /> : null;
}

function SidebarLink({ item, nav, onNavigate }: { item: NavItem; nav: NavState; onNavigate?: () => void }) {
  const { path, label, icon: Icon } = item;
  return (
    <NavLink
      to={path}
      end={path === '/'}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${
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
}

/** Upload, the sidebar's main action, as a full-width button above the sections. */
function SidebarPrimary({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const { path, label, icon: Icon } = item;
  return (
    <NavLink
      to={path}
      onClick={onNavigate}
      className={({ isActive }) =>
        `mb-2 flex h-10.5 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-medium text-gg-ink transition-colors ${
          isActive ? 'bg-gg ring-2 ring-gg/40 ring-offset-2 ring-offset-surface' : 'bg-gg hover:bg-gg-end'
        }`
      }
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>{label}</span>
    </NavLink>
  );
}

function SidebarNav({ nav, onNavigate }: { nav: NavState; onNavigate?: () => void }) {
  const primary = nav.items.find((item) => item.path === PRIMARY_NAV_PATH);
  const top = nav.items.filter((item) => !item.group && item !== primary);
  // the sidebar is drawn twice (the desktop column and the mobile drawer), so heading ids are per instance
  const uid = useId();
  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-0.5 px-3">
      {primary && <SidebarPrimary item={primary} onNavigate={onNavigate} />}
      {top.map((item) => (
        <SidebarLink key={item.path} item={item} nav={nav} onNavigate={onNavigate} />
      ))}
      {NAV_GROUPS.map((group) => {
        const items = nav.items.filter((item) => item.group === group.id);
        if (items.length === 0) return null;
        return (
          <section key={group.id} aria-labelledby={`${uid}-${group.id}`} className="mt-4 flex flex-col gap-0.5">
            <h2 id={`${uid}-${group.id}`} className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted/80 uppercase">
              {group.label}
            </h2>
            {items.map((item) => (
              <SidebarLink key={item.path} item={item} nav={nav} onNavigate={onNavigate} />
            ))}
          </section>
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

function SidebarFooter({ nav, onNavigate }: { nav: NavState; onNavigate?: () => void }) {
  // milestone-5 §19.2: the site's links, with a dot on Changelog until this browser has seen the newest entry.
  const changelogUnread = useChangelogUnread();
  return (
    <div className="mt-auto border-t border-line pt-3">
      <AccountMenu user={nav.user} pathname={nav.pathname} onNavigate={onNavigate} />
      <SiteFooter changelogDot={changelogUnread} className="px-3 pt-3" />
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
            className="rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-text"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <SidebarNav nav={nav} onNavigate={onClose} />
        <SidebarFooter nav={nav} onNavigate={onClose} />
      </aside>
    </div>
  );
}

/**
 * Session failures seen by any request (milestone-6 §13.1): a `401` signs this tab out
 * with "You were signed out." and **Sign in**; `403 ACCOUNT_PENDING_DELETION` refetches
 * the session, which then shows the Keep my account screen; `403 CSRF` is a generic error.
 */
function SessionEvents() {
  const client = useQueryClient();
  const notify = useToast();
  const { pathname, search } = useLocation();
  const here = useRef(pathname + search);
  useEffect(() => {
    here.current = pathname + search;
  }, [pathname, search]);
  useEffect(
    () =>
      onAuthEvent((event) => {
        if (event.type === 'unauthorized') {
          signedOut(client);
          notify('You were signed out.', 'info', { label: 'Sign in', to: loginPath(here.current) });
        } else if (event.type === 'pending-deletion') {
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        } else {
          notify('Something went wrong. Reload the page and try again.', 'error');
        }
      }),
    [client, notify],
  );
  return null;
}

/** A toast handed over by a navigation (sign-in, Discord link, sign-out), shown once. */
function RouteToast() {
  const location = useLocation();
  const navigate = useNavigate();
  const notify = useToast();
  const toast = (location.state as { toast?: unknown } | null)?.toast;
  // StrictMode runs effects twice in development: one toast per navigation.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (typeof toast !== 'string' || shown.current === location.key) return;
    shown.current = location.key;
    notify(toast);
    const { toast: _shown, ...rest } = (location.state ?? {}) as Record<string, unknown>;
    navigate(location.pathname + location.search, { replace: true, state: Object.keys(rest).length > 0 ? rest : null });
  }, [toast, notify, navigate, location.key, location.pathname, location.search, location.state]);
  return null;
}

function PageFallback() {
  return (
    <div role="status" aria-live="polite" className="text-sm text-muted">
      Loading…
    </div>
  );
}

export function DashboardLayout() {
  useSessionSync();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const session = useSession();
  const user = session.data ?? null;
  // A pending deletion locks everything but the session and exports (§8.8): no badges.
  const badges = useBadges(!user?.deletion);
  const restrictions = badges.data?.restrictions ?? user?.restrictions ?? [];
  // milestone-4 §8.4 and milestone-6 §11.1: a suspended account sees Notices, and in
  // Settings only its password, sessions and data export.
  const suspension = restrictions.find((restriction) => restriction.kind === 'suspended') ?? null;
  const staff = user?.staff ?? null;
  const items = suspension
    ? NAV_ITEMS.filter((item) => item.badge === 'notices' || item.path === '/settings').map((item) => (item.path === '/settings' ? { ...item, path: '/settings/security' } : item))
    : staff
      ? [...NAV_ITEMS, ADMIN_NAV_ITEM]
      : NAV_ITEMS;
  const nav: NavState = { items, badges: badges.data, user, pathname };
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
          <SidebarFooter nav={nav} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-bg/95 px-2 backdrop-blur lg:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              className="rounded-xl p-2 text-muted hover:bg-surface-2 hover:text-text"
            >
              <Menu aria-hidden className="size-5" />
            </button>
            <a href="/" aria-label="files.gg home" className="rounded-sm">
              <Lockup className="h-8 w-auto" />
            </a>
          </header>

          <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
            <SessionEvents />
            <RouteToast />
            {session.isPending ? (
              // Pages assume the session is known (anonymous or signed in) when they render.
              <PageFallback />
            ) : user?.deletion ? (
              // §8.8, §13.3: a pending deletion shows only the Keep my account screen.
              <PendingDeletionScreen user={{ ...user, deletion: user.deletion }} />
            ) : (
              <>
                {session.isError && (
                  <p role="alert" className="mb-6 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
                    Couldn’t check whether you’re signed in, so this shows files uploaded from this browser.{' '}
                    <button type="button" onClick={() => void session.refetch()} className="font-medium text-gg hover:underline">
                      Try again
                    </button>
                  </p>
                )}
                {suspension ? <SuspendedBanner /> : unacknowledged > 0 && <NoticesBanner count={unacknowledged} />}
                {user && !suspension && <AccountBanner user={user} />}
                {user?.needs_username && !suspension && <NeedsUsernameDialog />}
                <Suspense fallback={<PageFallback />}>
                  {suspension && !SUSPENDED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ? <Navigate to="/notices" replace /> : <Outlet />}
                </Suspense>
              </>
            )}
          </main>
        </div>

        <MobileDrawer open={drawerOpen} onClose={closeDrawer} nav={nav} />
      </div>
    </Toaster>
  );
}
