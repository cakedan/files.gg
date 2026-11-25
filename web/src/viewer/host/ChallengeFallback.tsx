import { ExternalLink } from 'lucide-react';

import { LinkButton } from '../../components/Button';
import { fallbackUrl, type FallbackTarget } from './fallback';

/**
 * Shown on a custom domain when the challenge frame failed or never answered: the
 * check can't run here, so the visitor continues on files.gg instead of waiting.
 */
export function ChallengeFallback({ target }: { target: FallbackTarget }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-line px-3 py-3 text-center" data-testid="challenge-fallback">
      <p className="text-sm text-muted">The human check couldn't run on this domain.</p>
      <LinkButton href={fallbackUrl(target)} variant="primary">
        <ExternalLink aria-hidden className="size-4" />
        Open on files.gg to continue
      </LinkButton>
    </div>
  );
}
