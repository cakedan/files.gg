import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { reportReasonLabel } from '../safety/labels';
import type { CaseKind, CaseSummary, CaseTarget } from './adminApi';

/** "45 min", "6 h", "3 d". */
export function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

export const KIND_LABELS: Record<CaseKind, string> = {
  file: 'File',
  album: 'Album',
  user: 'Account',
  domain: 'Domain',
  // the target is the content (a blob hash, every file with those bytes), not a hash *match*
  hash: 'Content',
  bug: 'Bug',
  appeal: 'Appeal',
};

/** Scanner and flag codes (§2.3), in words. */
export const FLAG_LABELS: Record<string, string> = {
  csam_match: 'CSAM hash match',
  hash_list: 'Blocked hash',
  pdq_near_match: 'Near-match of blocked content',
  malware: 'Malware',
  unwanted_software: 'Unwanted software',
  blocked_type: 'Blocked file type',
  archive_bomb: 'Archive bomb',
  pdf_dangerous: 'Dangerous PDF',
  pdf_javascript: 'PDF with JavaScript',
  polyglot_archive: 'Image or PDF with an archive appended',
  web_risk: 'Flagged link',
  nsfw_review: 'Owner asked for an NSFW review',
  scan_failing: 'Scan keeps failing (held for review)',
};

export const flagLabel = (code: string) => FLAG_LABELS[code] ?? code.replace(/_/g, ' ');

/** Report reasons (with counts), then scanner flags, each once. The API also lists flags in
 * `reasons` with a count of 0, so those are left to `flags`. */
export function reasonsText(item: Pick<CaseSummary, 'reasons' | 'flags' | 'kind'>) {
  const reports = Object.entries(item.reasons)
    .filter(([reason, count]) => (count ?? 0) > 0 && !item.flags.includes(reason))
    .map(([reason, count]) => `${reportReasonLabel(reason)}${count && count > 1 ? ` ×${count}` : ''}`);
  return [...reports, ...item.flags.map(flagLabel)].join(', ') || (item.kind === 'appeal' ? 'Waiting for a decision' : 'No open reports');
}

/** Where a case target's detail page is. */
export function targetHref(target: Pick<CaseTarget, 'type' | 'id'>): string | null {
  if (target.type === 'file' || target.type === 'hash') return `/admin/files/${target.id}`;
  if (target.type === 'album') return `/admin/albums/${target.id}`;
  if (target.type === 'user') return `/admin/users/${target.id}`;
  if (target.type === 'domain') return `/admin/domains/${target.id}`;
  return null;
}

/** Staff-facing wording for the codes the admin pages act on; anything else uses the shared messages. */
export function adminError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SAME_MODERATOR':
        return 'You took the original action, so another staff member has to decide this appeal.';
      case 'CASE_CLAIMED':
        return 'Someone else has claimed this case.';
      case 'FORBIDDEN':
        return 'Your role can’t do that.';
      case 'INVALID_ACTION':
        return error.message || 'That action doesn’t apply here.';
    }
  }
  return errorMessage(error);
}
