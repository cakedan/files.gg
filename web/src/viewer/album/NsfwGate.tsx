import { EyeOff } from 'lucide-react';

import { Button, LinkButton } from '../../components/Button';

/** One interstitial for the whole album (PLAN.md: not one per item). */
export function NsfwGate({ onContinue }: { onContinue: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-3 py-6">
      <section className="viewer-card w-[min(28rem,100vw-1.5rem)] items-center gap-4 px-6 py-8 text-center">
        <EyeOff aria-hidden className="size-10 text-warn" />
        <h1 className="text-lg font-semibold">This album is marked NSFW</h1>
        <p className="text-sm text-muted">It may contain adult content. Only continue if you're old enough and want to see it.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <LinkButton href="/">Leave</LinkButton>
          <Button variant="primary" onClick={onContinue}>
            Show album
          </Button>
        </div>
      </section>
    </main>
  );
}
