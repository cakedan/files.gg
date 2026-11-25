import { targetFromPath } from '../../lib/access';
import type { FileData } from '../types';

/** What the viewer's Report buttons report: the file or album being shown, or a custom domain (milestone-6 §10.12). */
export type ReportableTarget = { type: 'file' | 'album'; vanity: string } | { type: 'domain'; hostname: string };

const encodeVanity = (vanity: string) => vanity.split('/').map(encodeURIComponent).join('/');

/**
 * `/report/<vanity>` or `/report/a/<vanity>` (milestone-4 §7.2, §10.1). The vanity is always
 * the last path segment (milestone-6 §20.2).
 */
export function reportPath(target: ReportableTarget): string {
  // A domain is reported from its landing card; the link (new tab) is the domain's report page.
  if (target.type === 'domain') return '/report';
  return target.type === 'album' ? `/report/a/${encodeVanity(target.vanity)}` : `/report/${encodeVanity(target.vanity)}`;
}

/**
 * The vanity to report a file by: the payload's `vanity`, else the one in its
 * canonical URL, else the one in this page's path.
 */
export function fileReportTarget(file: Pick<FileData, 'vanity' | 'url'>, pathname: string = window.location.pathname): ReportableTarget | null {
  if (file.vanity) return { type: 'file', vanity: file.vanity };
  let path = pathname;
  if (file.url) {
    try {
      path = new URL(file.url).pathname;
    } catch {
      // Keep this page's path.
    }
  }
  const found = targetFromPath(path);
  return found?.kind === 'file' ? { type: 'file', vanity: found.vanity } : null;
}
