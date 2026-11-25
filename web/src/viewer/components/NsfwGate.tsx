import { EyeOff } from 'lucide-react';
import { useId, useState } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { setAlwaysShowSensitive } from '../../lib/sensitive';

/**
 * The sensitive-content interstitial (milestone-4 §4.6, §11.1), shared by single files
 * and albums (one for the whole album, not one per item). The caller mounts nothing
 * under it until Show, so no media request is made before then.
 */
export function NsfwGate({ kind, onShow }: { kind: 'file' | 'album'; onShow: () => void }) {
  const [always, setAlways] = useState(false);
  const id = useId();
  return (
    <main className="flex min-h-dvh items-center justify-center px-3 py-6">
      <section
        className="viewer-card w-[min(28rem,100vw-1.5rem)] items-center gap-4 px-6 py-8 text-center"
        aria-labelledby={`${id}-title`}
      >
        <EyeOff aria-hidden className="size-10 text-warn" />
        <h1 id={`${id}-title`} className="text-lg font-semibold">
          This {kind} may contain sensitive content
        </h1>
        <p className="text-sm text-muted">It may include adult content (NSFW). Only continue if you're an adult and want to see it.</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
            className="size-4 accent-gg"
          />
          Always show sensitive media
        </label>
        <div className="flex flex-wrap justify-center gap-2">
          <LinkButton href="/">Leave</LinkButton>
          <Button
            variant="primary"
            onClick={() => {
              if (always) setAlwaysShowSensitive(true);
              onShow();
            }}
          >
            Show
          </Button>
        </div>
      </section>
    </main>
  );
}
