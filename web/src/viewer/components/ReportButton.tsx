import { Flag } from 'lucide-react';
import { lazy, Suspense, useState, type MouseEvent } from 'react';

import { LinkButton, type ButtonVariant } from '../../components/Button';
import { reportPath, type ReportableTarget } from './reportPath';

/** The report form is its own chunk: it loads on the first click, not with the page. */
const ReportDialog = lazy(() => import('../report/ReportDialog'));

/**
 * "Report" (milestone-4 §7.2, §11.1). A real link to `/report/<vanity>` (or
 * `/report/a/<vanity>`, milestone-6 §20.2), so it works in a new tab; a plain click opens
 * the dialog here.
 */
export function ReportButton({
  target,
  variant = 'ghost',
  compact = false,
}: {
  target: ReportableTarget;
  variant?: ButtonVariant;
  /** Icon only (the album lightbox toolbar). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(true);
  };
  return (
    <>
      <LinkButton
        href={reportPath(target)}
        onClick={onClick}
        variant={variant}
        aria-haspopup="dialog"
        aria-label={compact ? 'Report' : undefined}
        title={compact ? 'Report this file' : undefined}
        className={compact ? 'px-2' : ''}
      >
        <Flag aria-hidden className="size-4" />
        {!compact && 'Report'}
      </LinkButton>
      {open && (
        <Suspense fallback={null}>
          <ReportDialog target={target} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
