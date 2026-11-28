import { LogOut, Settings } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { buttonClass } from '../../components/buttonClass';
import type { User } from '../../lib/api';
import { loginPath } from '../../lib/session';
import { Menu } from '../components/Menu';
import { Avatar } from './Avatar';
import { useSignOut } from './useSignOut';

/** §13.3 sidebar footer: Sign in and Create account, or the initials tile, names and a menu. */
export function AccountMenu({ user, pathname, onNavigate }: { user: User | null; pathname: string; onNavigate?: (() => void) | undefined }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  if (!user) {
    return (
      <div className="flex flex-col gap-2 px-3">
        <Link to={loginPath(pathname)} onClick={onNavigate} className={buttonClass('primary', 'w-full')}>
          Sign in
        </Link>
        <Link to="/register" onClick={onNavigate} className={buttonClass('secondary', 'w-full')}>
          Create account
        </Link>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3">
      <Link to="/settings" onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl p-1.5 hover:bg-surface-2">
        <Avatar user={user} size="sm" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{user.display_name || user.username}</span>
          <span className="truncate text-xs text-muted">@{user.username}</span>
        </span>
      </Link>
      <Menu
        label="Account menu"
        items={[
          {
            label: 'Settings',
            icon: Settings,
            onSelect: () => {
              onNavigate?.();
              navigate('/settings');
            },
          },
          {
            label: 'Sign out',
            icon: LogOut,
            onSelect: () => {
              onNavigate?.();
              void signOut();
            },
          },
        ]}
      />
    </div>
  );
}
