import { Clock3, Globe, Images, KeyRound, Lock, Wand2, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';

import { Lockup } from '../../components/Brand';
import { buttonClass } from '../../components/buttonClass';
import { SiteFooter } from '../../components/SiteFooter';
import { loginPath, useSession, useSessionSync } from '../../lib/session';
import { AppLink } from '../components/AppLink';
import { InDashboardContext } from '../components/inDashboard';
import { Toaster } from '../components/Toaster';
import UploadPage from './UploadPage';

interface Feature {
  icon: LucideIcon;
  title: string;
  text: string;
  /** A dashboard path (`AppLink`) or a public one. */
  link?: { to: string; label: string; app?: boolean };
}

/** What files.gg does, in a sentence each (everything here is built: milestones 2–6). */
const FEATURES: readonly Feature[] = [
  { icon: Lock, title: 'Private or password protected', text: 'Share with anyone who has the link, only people with the password, or nobody but you.' },
  { icon: Clock3, title: 'Expiry and view limits', text: 'Let a link expire after a while, or after a set number of people have opened it.' },
  { icon: Images, title: 'Albums', text: 'Put files behind one link, with a gallery, a slideshow and a download of everything.' },
  { icon: Wand2, title: 'Convert', text: 'Turn a video into MP4, a GIF into a video, a document into a PDF, and more.', link: { to: '/convert', label: 'Convert a file' } },
  { icon: KeyRound, title: 'ShareX and curl', text: 'Create an upload key and send screenshots and files straight from your tools.', link: { to: '/integrations', label: 'Upload keys', app: true } },
  { icon: Globe, title: 'Your own domain', text: 'Premium accounts can share links on their own subdomain, like i.example.com.' },
];

/**
 * files.gg's home page: what it is in a line, the upload box itself (the dashboard's Upload page, embedded,
 * so a drop or a paste anywhere on the page uploads right away), and what else it does.
 */
export default function HomePage() {
  useSessionSync();
  const session = useSession();
  useEffect(() => {
    document.title = 'files.gg: share any file with a link';
  }, []);

  return (
    <InDashboardContext.Provider value={false}>
      <Toaster>
        <div className="flex min-h-dvh flex-col">
          <header className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 pt-6 sm:px-6">
            <a href="/" aria-label="files.gg home" className="mr-auto rounded-sm">
              <Lockup className="h-8 w-auto" />
            </a>
            {session.data ? (
              <a href="/app" className={buttonClass('secondary')}>
                Dashboard
              </a>
            ) : (
              session.isSuccess && (
                <>
                  <AppLink to={loginPath('/')} className={buttonClass('ghost')}>
                    Sign in
                  </AppLink>
                  <AppLink to="/register" className={buttonClass('secondary')}>
                    Create account
                  </AppLink>
                </>
              )
            )}
          </header>

          <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-10 sm:px-6">
            <section aria-labelledby="home-title" className="mx-auto flex max-w-2xl flex-col items-center gap-3 text-center">
              <h1 id="home-title" className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Share any file with a link.
              </h1>
              <p className="text-pretty text-muted">
                Drop a file anywhere on this page, paste it, or choose one. Images, video, audio and PDFs open right in the browser;
                everything else is a click to download.
              </p>
            </section>

            <section aria-label="Upload" className="mx-auto w-full max-w-3xl">
              {session.isPending ? (
                <p role="status" className="text-center text-sm text-muted">
                  Loading…
                </p>
              ) : (
                <UploadPage embedded />
              )}
            </section>

            <section aria-labelledby="home-features" className="flex flex-col gap-4">
              <h2 id="home-features" className="text-center text-lg font-semibold">
                More than a link
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map(({ icon: Icon, title, text, link }) => (
                  <li key={title} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
                    <Icon aria-hidden className="size-5 text-gg" />
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="text-sm text-muted">{text}</p>
                    {link &&
                      (link.app ? (
                        <AppLink to={link.to} className="mt-auto text-sm font-medium text-gg hover:underline">
                          {link.label}
                        </AppLink>
                      ) : (
                        <a href={link.to} className="mt-auto text-sm font-medium text-gg hover:underline">
                          {link.label}
                        </a>
                      ))}
                  </li>
                ))}
              </ul>
            </section>
          </main>

          <SiteFooter className="px-4 pb-6" />
        </div>
      </Toaster>
    </InDashboardContext.Provider>
  );
}
