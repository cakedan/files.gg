import { Lockup } from '../../components/Brand';
import { buttonClass } from '../../components/buttonClass';
import { SiteFooter } from '../../components/SiteFooter';
import { useSession, useSessionSync } from '../../lib/session';
import { Toaster } from '../components/Toaster';
import { ConvertSignIn } from '../convert/ConvertSignIn';
import { InDashboardContext } from '../components/inDashboard';
import { ConvertView } from '../convert/ConvertView';

/** `/app/convert` (milestone-5 §13.1), with the history. */
export default function ConvertPage() {
  return <ConvertView />;
}

/** The public `files.gg/convert`: the same page, without the history, under a small header. */
export function PublicConvertPage() {
  useSessionSync();
  const session = useSession();
  return (
    <InDashboardContext.Provider value={false}>
      <Toaster>
        <div className="flex min-h-dvh flex-col">
          <header className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 pt-6 sm:px-6">
            <a href="/" aria-label="files.gg home" className="mr-auto rounded-sm">
              <Lockup className="h-8 w-auto" />
            </a>
            {session.data ? (
              <a href="/app" className={buttonClass('secondary')}>
                Dashboard
              </a>
            ) : (
              session.isSuccess && <ConvertSignIn className={buttonClass('secondary')}>Sign in</ConvertSignIn>
            )}
          </header>
          <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
            {session.isPending ? (
              <p role="status" className="text-sm text-muted">
                Loading…
              </p>
            ) : (
              <ConvertView publicPage />
            )}
          </main>
          <SiteFooter className="px-4 pb-6" />
        </div>
      </Toaster>
    </InDashboardContext.Provider>
  );
}
