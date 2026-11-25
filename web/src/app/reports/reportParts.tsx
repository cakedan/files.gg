import type { Report, ReportStatus } from '../../lib/api';
import { REPORT_STATUS_LABELS } from '../safety/labels';

const STATUS_STYLES: Record<ReportStatus, string> = {
  open: 'bg-gg/15 text-gg',
  resolved: 'bg-surface-2 text-text',
  dismissed: 'bg-surface-2 text-muted',
};

/** Open, Resolved, Dismissed, or Closed once read only (milestone-4 §7.6). */
export function ReportStatusPill({ report }: { report: Pick<Report, 'status' | 'closed'> }) {
  const label = report.closed ? 'Closed' : REPORT_STATUS_LABELS[report.status];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${report.closed ? 'bg-surface-2 text-muted' : STATUS_STYLES[report.status]}`}>
      {label}
    </span>
  );
}
