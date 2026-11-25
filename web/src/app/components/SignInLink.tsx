import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { loginPath } from '../../lib/session';

/** "Sign in", back to this page afterwards (`/app/login?next=<this page>`, milestone-6 §13.3). */
export function SignInLink({ children = 'Sign in', className = 'text-gg hover:underline' }: { children?: ReactNode; className?: string }) {
  const { pathname, search } = useLocation();
  return (
    <Link to={loginPath(pathname + search)} className={className}>
      {children}
    </Link>
  );
}
