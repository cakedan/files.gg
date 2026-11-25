import { lazy, Suspense, useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router';

import { useSession } from '../../lib/session';
import NotFoundPage from './NotFoundPage';
import { SignInLink } from '../components/SignInLink';
import ProfileTab from '../settings/ProfileTab';
import { isSuspended } from '../settings/settingsUtils';
import SecurityTab from '../settings/SecurityTab';
import UploadsTab from '../settings/UploadsTab';

// Domains and Data are their own chunks: most visits are to Profile and Security.
const DomainsTab = lazy(() => import('../settings/DomainsTab'));
const DataTab = lazy(() => import('../settings/DataTab'));

const TABS = [
  { to: '/settings', label: 'Profile', end: true },
  { to: '/settings/uploads', label: 'Uploads' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/domains', label: 'Domains' },
  { to: '/settings/data', label: 'Data' },
] as const;

/** `/app/settings/*` (milestone-6 §13.3, milestone-5 §21): Profile, Uploads, Security, Domains and Data, tabs in the URL. */
export default function SettingsPage() {
  useEffect(() => {
    document.title = 'Settings · files.gg';
  }, []);
  const user = useSession().data ?? null;

  if (!user) {
    return (
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted">
          <SignInLink /> to change your profile, login methods and account.
        </p>
      </section>
    );
  }
  const suspended = isSuspended(user);
  const tabs = suspended ? TABS.filter((tab) => tab.to === '/settings/security' || tab.to === '/settings/data') : TABS;

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted">Your profile, upload defaults, login methods, domains and data.</p>
      </header>
      <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={'end' in tab}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${isActive ? 'border-gg text-text' : 'border-transparent text-muted hover:text-text'}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-muted">
            Loading…
          </p>
        }
      >
        <Routes>
          <Route index element={<ProfileTab user={user} />} />
          <Route path="uploads" element={<UploadsTab user={user} />} />
          <Route path="security" element={<SecurityTab user={user} />} />
          <Route path="domains" element={<DomainsTab user={user} />} />
          <Route path="data" element={<DataTab user={user} />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </section>
  );
}
