import { AlertOctagon, Bell, BellOff, Hourglass } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';

import { CountBadge } from '../safety/SafetyBadge';
import { useAdminSummary } from './adminQueries';
import { isAdmin } from './permissions';
import { useStaff } from './staffContext';
import { useP0Notifications } from './useP0Notifications';
import { buttonClass } from '../../components/buttonClass';

/** The admin pages' tabs (§11.3). The audit log is for admins. */
function AdminNav({ open, admin }: { open: number; admin: boolean }) {
  const tabs = [
    { to: '/admin', label: 'Overview', end: true },
    { to: '/admin/queue', label: 'Queue', count: open },
    { to: '/admin/bugs', label: 'Bugs' },
    { to: '/admin/lookup', label: 'Lookup' },
    { to: '/admin/domains', label: 'Domains' },
    { to: '/admin/bans', label: 'Bans' },
    ...(admin ? [{ to: '/admin/audit', label: 'Audit log' }] : []),
  ];
  return (
    <nav aria-label="Admin" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${isActive ? 'border-gg text-text' : 'border-transparent text-muted hover:text-text'}`
              }
            >
              {tab.label}
              {tab.count !== undefined && <CountBadge count={tab.count} label="open" />}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Every admin page: the tabs, the P0 banner, the stalled-scans banner (admins), the
 * notification toggle, and a live region announcing queue changes (§11.3).
 */
export function AdminLayout() {
  const staff = useStaff();
  const summary = useAdminSummary();
  const data = summary.data;
  const p0 = data?.open.p0 ?? 0;
  const open = data ? data.open.p0 + data.open.p1 + data.open.p2 + data.open.p3 : 0;
  const notifications = useP0Notifications(data?.newest_p0_at);

  // Announce changes to the open count, not the first load.
  const [announcement, setAnnouncement] = useState('');
  const lastOpen = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    if (lastOpen.current !== null && lastOpen.current !== open) {
      setAnnouncement(`Queue updated: ${open} open ${open === 1 ? 'case' : 'cases'}${p0 > 0 ? `, ${p0} P0` : ''}.`);
    }
    lastOpen.current = open;
  }, [data, open, p0]);

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="text-sm text-muted">
            {staff.role === 'admin' ? 'Admin' : 'Moderator'}
            {staff.child_safety ? ', child safety' : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={notifications.enabled}
            onClick={() => void notifications.toggle()}
            className={buttonClass('secondary')}
          >
            {notifications.enabled ? <Bell aria-hidden className="size-4 text-gg" /> : <BellOff aria-hidden className="size-4" />}
            Notify me about new P0 cases
          </button>
          {notifications.message && (
            <p role="status" className="text-xs text-warn">
              {notifications.message}
            </p>
          )}
        </div>
      </header>

      {p0 > 0 && (
        <Link to="/admin/queue?priority=0" className="flex items-center gap-3 rounded-2xl border border-danger/60 bg-danger/15 px-4 py-3 text-sm font-medium hover:bg-danger/20">
          <AlertOctagon aria-hidden className="size-5 shrink-0 text-danger" />
          {p0} child-safety or P0 {p0 === 1 ? 'case is' : 'cases are'} open
        </Link>
      )}
      {isAdmin(staff) && data && data.scans_stalled > 0 && (
        <p role="status" className="flex items-center gap-3 rounded-2xl border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
          <Hourglass aria-hidden className="size-5 shrink-0 text-warn" />
          Scanning is behind: {data.scans_stalled} {data.scans_stalled === 1 ? 'file' : 'files'} waiting over 10 minutes
        </p>
      )}

      <AdminNav open={open} admin={isAdmin(staff)} />

      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>

      <Outlet />
    </section>
  );
}
