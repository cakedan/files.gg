import type { ReportPageTarget } from '../types';
import { ReportForm } from './ReportForm';
import { initialReportUrl } from './formLogic';

/**
 * `files.gg/report`, `files.gg/<vanity>/report` and `files.gg/a/<vanity>/report`
 * (`data-page="report"`, milestone-4 §10.1). The page never says whether the vanity
 * exists; the API answers that when the form is sent.
 */
export default function ReportPage({ target }: { target: ReportPageTarget }) {
  return (
    <main className="flex min-h-dvh items-start justify-center px-3 py-6 sm:items-center">
      <section className="viewer-card w-[min(36rem,100vw-1.5rem)] p-5 sm:p-6">
        <ReportForm target={target} initialUrl={target.type === 'any' ? initialReportUrl() : undefined} />
      </section>
    </main>
  );
}
