import { ShieldCheck } from 'lucide-react';

import type { TurnstileStatus } from '../../components/useTurnstile';

/** The managed Turnstile widget under an auth form (§4.6): invisible unless Cloudflare needs a click. */
export function TurnstileField({ mount, status, retry }: { mount: (element: HTMLDivElement | null) => void; status: TurnstileStatus; retry: () => void }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <div ref={mount} data-testid="turnstile" />
      {status === 'error' ? (
        <p role="alert" className="text-danger">
          Couldn’t verify you’re human.{' '}
          <button type="button" onClick={retry} className="text-gg hover:underline">
            Try again
          </button>
        </p>
      ) : (
        <p className="flex items-center gap-1">
          <ShieldCheck aria-hidden className="size-3.5" /> Protected by Cloudflare Turnstile.
        </p>
      )}
    </div>
  );
}
