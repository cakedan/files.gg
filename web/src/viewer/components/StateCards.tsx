import { FileQuestion, RefreshCw, Upload, Wand2, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { Lockup, Mark } from '../../components/Brand';
import { Button, LinkButton } from '../../components/Button';
import { hostContext, mainUrl } from '../host/context';
import { ReportButton } from './ReportButton';

export function StateCard({ children }: { children: ReactNode }) {
  return (
    <section className="viewer-card w-[min(28rem,100vw-1.5rem)] items-center gap-4 px-6 py-8 text-center">
      {children}
    </section>
  );
}

export function HomeCard() {
  return (
    <StateCard>
      <h1 className="sr-only">files.gg</h1>
      <Lockup className="h-12 w-auto max-w-full" />
      <p className="text-muted">Simple, fast file hosting. Upload a file and share the link.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <LinkButton href="/app/upload" variant="primary">
          <Upload aria-hidden className="size-4" />
          Upload a file
        </LinkButton>
        <LinkButton href="/app">Dashboard</LinkButton>
      </div>
    </StateCard>
  );
}

/**
 * A custom domain's `/` (milestone-6 §10.8, §13.4): "Files hosted with files.gg" and
 * Report (the domain itself, §10.12). No sign-in, upload or dashboard links.
 */
export function DomainHomeCard() {
  const { host } = hostContext();
  return (
    <StateCard>
      <Mark className="size-14 opacity-90" />
      <h1 className="text-lg font-semibold">Files hosted with files.gg</h1>
      <p className="max-w-full font-mono text-sm break-all text-muted">{host}</p>
      <ReportButton target={{ type: 'domain', hostname: host }} variant="secondary" />
    </StateCard>
  );
}

export function MissingCard() {
  return (
    <StateCard>
      <div className="relative">
        <Mark className="size-14 opacity-90" />
        <FileQuestion aria-hidden className="absolute -right-2 -bottom-2 size-6 rounded-full bg-surface p-0.5 text-muted" />
      </div>
      <h1 className="text-lg font-semibold">This file doesn't exist or has expired.</h1>
      <p className="text-sm text-muted">Check the link, or ask whoever shared it to upload it again.</p>
      <LinkButton href={mainUrl('/')}>Go to files.gg</LinkButton>
    </StateCard>
  );
}

export function UnavailableCard({ onRetry = () => window.location.reload() }: { onRetry?: () => void }) {
  return (
    <StateCard>
      <WifiOff aria-hidden className="size-10 text-warn" />
      <h1 className="text-lg font-semibold">files.gg is having trouble right now.</h1>
      <p className="text-sm text-muted">We couldn't reach our servers to load this file. It hasn't been deleted.</p>
      <Button variant="primary" onClick={onRetry}>
        <RefreshCw aria-hidden className="size-4" />
        Retry
      </Button>
    </StateCard>
  );
}

/** Public /convert: placeholder until the "File conversion" milestone. */
export function ConvertCard() {
  return (
    <StateCard>
      <Wand2 aria-hidden className="size-10 text-gg" />
      <h1 className="text-lg font-semibold">Convert</h1>
      <p className="text-sm text-muted">Converting files between formats is coming in a later milestone.</p>
      <LinkButton href={mainUrl('/')}>Go to files.gg</LinkButton>
    </StateCard>
  );
}
