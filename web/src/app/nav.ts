import { Bell, Flag, FolderOpen, Images, LayoutDashboard, Plug, Settings, Upload, Wand2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  /** Relative to the /app basename. */
  path: string;
  label: string;
  icon: LucideIcon;
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
  { path: '/reports', label: 'My reports', icon: Flag },
  { path: '/notices', label: 'Notices', icon: Bell },
];
