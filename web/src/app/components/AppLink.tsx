import { useContext, type ReactNode } from 'react';
import { Link } from 'react-router';

import { InDashboardContext } from './inDashboard';

/** The dashboard's basename (routes.tsx `APP_BASENAME`). */
const DASHBOARD = '/app';

/** A link to a dashboard path: a router link inside the dashboard, a plain `/app/…` link on a public page. */
export function AppLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const inDashboard = useContext(InDashboardContext);
  if (inDashboard) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={`${DASHBOARD}${to === '/' ? '' : to}`} className={className}>
      {children}
    </a>
  );
}
