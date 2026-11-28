import { Flag } from 'lucide-react';
import { lazy, Suspense, useState, type MouseEvent } from 'react';

import { LinkButton, type ButtonVariant } from '../../components/Button';
import { mainUrl } from '../host/context';
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
  plain = false,
}: {
  target: ReportableTarget;
  variant?: ButtonVariant;
  /** A square icon button (the album header and lightbox toolbar). */
  compact?: boolean;
  /**
   * A text link (the file footer's "Terms · Privacy · Report", milestone-5 §19.2), to
   * files.gg's report page: absolute on a custom domain.
   */
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(true);
  };
  const dialog = open && (
    <Suspense fallback={null}>
      <ReportDialog target={target} onClose={() => setOpen(false)} />
    </Suspense>
  );
  if (plain) {
    return (
      <>
        <a href={mainUrl(reportPath(target))} onClick={onClick} aria-haspopup="dialog" className="hover:text-text hover:underline">
          Report
        </a>
        {dialog}
      </>
    );
  }
  return (
    <>
      <LinkButton
        href={reportPath(target)}
        onClick={onClick}
        variant={variant}
        aria-haspopup="dialog"
        aria-label={compact ? 'Report' : undefined}
        title={compact ? `Report this ${target.type === 'album' ? 'album' : 'file'}` : undefined}
        size={compact ? 'icon' : 'md'}
      >
        <Flag aria-hidden className={compact ? 'size-5' : 'size-4'} />
        {!compact && 'Report'}
      </LinkButton>
      {dialog}
    </>
  );
}
