import { FileQuestion, RefreshCw, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { Mark } from '../../components/Brand';
import { Button, LinkButton } from '../../components/Button';
import { mainUrl } from '../host/context';

export function StateCard({ children }: { children: ReactNode }) {
  return (
    <section className="viewer-card w-[min(28rem,100vw-1.5rem)] items-center gap-4 px-6 py-8 text-center">
      {children}
    </section>
  );
}

export function MissingCard() {
  return (
    <StateCard>
      <div className="relative">
        <Mark className="size-14 opacity-90" />
        <FileQuestion aria-hidden className="absolute -right-2 -bottom-2 size-6 rounded-full bg-surface p-0.5 text-muted" />
      </div>
      {/* The shell can't tell missing, expired and private apart. Never say "removed": a pending-deletion
          owner's files land here too, and that word reads as moderation. */}
      <h1 className="text-lg font-semibold">This link isn't available.</h1>
      <p className="text-sm text-muted">It may have expired or be private. Check the link, or ask whoever shared it.</p>
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
