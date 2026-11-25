import { Bell, Flag, FolderOpen, Images, LayoutDashboard, Plug, Settings, ShieldAlert, Upload, Wand2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  /** Relative to the /app basename. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Which `GET /users/@me/badges` count it shows (milestone-4 §11.2). */
  badge?: 'reports' | 'notices' | 'admin';
  /** The sidebar section it's listed under; none for the items above the sections. */
  group?: NavGroup;
}

export type NavGroup = 'library' | 'account' | 'safety' | 'staff';

/** The sidebar's sections, in order, each under a small heading. */
export const NAV_GROUPS: readonly { id: NavGroup; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'account', label: 'Account' },
  { id: 'safety', label: 'Safety' },
  { id: 'staff', label: 'Staff' },
];

/** Shown as the sidebar's main button, above everything else. */
export const PRIMARY_NAV_PATH = '/upload';

/**
 * The sidebar: Upload as its main button, Overview, then the sections (your files and what you do with
 * them, your account, and the safety messages files.gg sends you). Admin is added for staff.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/upload', label: 'Upload', icon: Upload },
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/files', label: 'Files', icon: FolderOpen, group: 'library' },
  { path: '/albums', label: 'Albums', icon: Images, group: 'library' },
  { path: '/convert', label: 'Convert', icon: Wand2, group: 'library' },
  { path: '/settings', label: 'Settings', icon: Settings, group: 'account' },
  { path: '/integrations', label: 'Integrations', icon: Plug, group: 'account' },
  { path: '/notices', label: 'Notices', icon: Bell, badge: 'notices', group: 'safety' },
  { path: '/reports', label: 'My reports', icon: Flag, badge: 'reports', group: 'safety' },
];

/**
 * Where a suspended account may go (milestone-6 §11.1): Notices, and Settings for its
 * password, sessions and data export.
 */
export const SUSPENDED_PATHS = ['/notices', '/settings/security', '/settings/data'] as const;

/** Staff only (milestone-4 §11.3): its own section, last. */
export const ADMIN_NAV_ITEM: NavItem = { path: '/admin', label: 'Admin', icon: ShieldAlert, badge: 'admin', group: 'staff' };
