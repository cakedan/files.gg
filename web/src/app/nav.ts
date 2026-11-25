import { Bell, Flag, FolderOpen, Images, LayoutDashboard, Plug, Settings, ShieldAlert, Upload, Wand2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  /** Relative to the /app basename. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Which `GET /users/@me/badges` count it shows (milestone-4 §11.2). */
  badge?: 'reports' | 'notices' | 'admin';
}

/** Sidebar sections (PLAN.md Phase 3), with Convert and Albums after Upload. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/files', label: 'Files', icon: FolderOpen },
  { path: '/upload', label: 'Upload', icon: Upload },
  { path: '/convert', label: 'Convert', icon: Wand2 },
  { path: '/albums', label: 'Albums', icon: Images },
  { path: '/integrations', label: 'Integrations', icon: Plug },
  { path: '/settings', label: 'Settings', icon: Settings },
  { path: '/reports', label: 'My reports', icon: Flag, badge: 'reports' },
  { path: '/notices', label: 'Notices', icon: Bell, badge: 'notices' },
];

/** Staff only (milestone-4 §11.3): added after the sections above. */
export const ADMIN_NAV_ITEM: NavItem = { path: '/admin', label: 'Admin', icon: ShieldAlert, badge: 'admin' };
