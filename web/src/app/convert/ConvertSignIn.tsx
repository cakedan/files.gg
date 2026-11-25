import { useContext, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { loginPath } from '../../lib/session';
import { AppLink } from '../components/AppLink';
import { InDashboardContext } from '../components/inDashboard';

/**
 * "Sign in", back to this Convert page afterwards. From the public page that's the
 * dashboard's Convert page, with the same query (`next` must be a dashboard path).
 */
export function ConvertSignIn({ children, className = 'font-medium text-gg hover:underline' }: { children: ReactNode; className?: string }) {
  const inDashboard = useContext(InDashboardContext);
  const { pathname, search } = useLocation();
  const next = inDashboard ? pathname + search : `/convert${search}`;
  return <AppLink to={loginPath(next)} className={className}>{children}</AppLink>;
}
