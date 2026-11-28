import type { ReactNode } from 'react';

import { Mark } from '../../components/Brand';
import { PRIVACY_PATH, TERMS_PATH } from '../../components/SiteFooter';
import { hostContext, mainUrl } from '../host/context';

/**
 * The line under a file or album: the small folded-tile mark with "Share your own file" (on
 * files.gg only: a custom domain is the customer's branding, milestone-6 §10), then Terms and
 * Privacy, which always go to files.gg (milestone-5 §19.2), and an optional Report.
 */
export function ViewerFooterNav({ report, className = '' }: { report?: ReactNode; className?: string }) {
  const custom = hostContext().custom;
  return (
    <nav aria-label="files.gg" className={`flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-muted ${className}`.trim()}>
      {!custom && (
        <>
          <a href={mainUrl('/')} className="inline-flex items-center gap-1.5 hover:text-text hover:underline">
            {/* The small mark is the 16–32 px variant (branding/README.md); the link text names it. */}
            <Mark small alt="" className="size-4" />
            Share your own file
          </a>
          <span aria-hidden>·</span>
        </>
      )}
      <a href={mainUrl(TERMS_PATH)} className="hover:text-text hover:underline">
        Terms
      </a>
      <span aria-hidden>·</span>
      <a href={mainUrl(PRIVACY_PATH)} className="hover:text-text hover:underline">
        Privacy
      </a>
      {report && (
        <>
          <span aria-hidden>·</span>
          {report}
        </>
      )}
    </nav>
  );
}
