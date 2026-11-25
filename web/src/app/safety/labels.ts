/**
 * Dashboard copy for Milestone 4 (milestone-4 contract §7.3, §8.1, §11.2). The labels
 * are shared by My reports, Notices, the file views and the admin chunk.
 */

import type { OwnerFile, ReportReason, ReportStatus, SafetyState } from '../../lib/api';

/** §7.3: the reason labels. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  csam: 'Child sexual abuse material',
  ncii: 'Intimate images shared without consent',
  violence: 'Violence, terrorism or credible threats',
  malware: 'Malware or phishing',
  adult_unmarked: 'Adult content not marked as sensitive',
  copyright: 'Copyright (DMCA)',
  harassment: 'Harassment or private information',
  spam: 'Spam',
  other: 'Something else',
  bug: 'A problem with files.gg',
};

export const reportReasonLabel = (reason: string) => REPORT_REASON_LABELS[reason as ReportReason] ?? reason;

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

/** §8.1: rule texts, for places that only have the rule code (admin). */
export const RULE_TEXT: Record<string, string> = {
  csam: 'Child sexual abuse material',
  ncii: 'Intimate images shared without consent',
  violence: 'Violence, terrorism or credible threats',
  malware: 'Malware or harmful software',
  phishing: 'Phishing or scams',
  adult_unmarked: 'Adult content that wasn’t marked as sensitive',
  copyright: 'Copyright infringement',
  harassment: 'Harassment',
  private_info: 'Sharing someone’s private information',
  spam: 'Spam',
  other: 'Breaking the Terms of Service',
};

/** What a notice's action did, as a heading. */
const NOTICE_ACTIONS: Record<string, string> = {
  hide: 'Hidden',
  auto_hide: 'Hidden while we review a report',
  remove: 'Removed',
  delete: 'Deleted',
  mark_nsfw: 'Marked as sensitive',
  auto_nsfw: 'Marked as sensitive after reports',
  scan_block: 'Blocked by our scanner',
  block_hash: 'Blocked',
  adult_unmarked: 'Adult content wasn’t marked as sensitive',
  restrict_uploads: 'Uploads restricted',
  suspend_user: 'Account suspended',
};

export const noticeActionLabel = (action: string) => NOTICE_ACTIONS[action] ?? 'Moderation notice';

/** §2.4 "Owner (dashboard)": the badges owners see. `flagged` shows no badge, only its warnings. */
export const SAFETY_BADGES: Partial<Record<SafetyState, string>> = {
  pending: 'Checking…',
  hidden: 'Hidden',
  removed: 'Removed',
  blocked: 'Blocked',
};

/** §11.2: why an upload was rejected after scanning (moved to lib/errors so errorMessage shares it). */
export { UPLOAD_REJECTED_MESSAGES, uploadRejectedMessage } from '../../lib/errors';

/** §11.1's warning copy, shown to the owner in the drawer. */
export const WARNING_TEXT: Record<string, string> = {
  encrypted_archive: 'This archive is encrypted and couldn’t be scanned.',
  encrypted_pdf: 'This PDF is password-protected and couldn’t be scanned.',
  unwanted_software: 'files.gg’s scanner flagged this file as potentially unwanted software.',
  archive_partially_scanned: 'This file was too large to scan completely.',
  too_large_to_scan: 'This file was too large to scan completely.',
};

/** Why the owner can't see the bytes, per state (§2.4). */
export function stateExplanation(file: Pick<OwnerFile, 'safety'>): string | null {
  const safety = file.safety;
  switch (safety?.state) {
    case 'pending':
      return 'We’re checking this file. It isn’t shared until the check finishes, usually within a few seconds.';
    case 'hidden':
      return safety.reason === 'review'
        ? 'This file is hidden while it’s reviewed. Visitors see that it’s unavailable.'
        : 'This file was hidden by the files.gg team. Visitors see that it’s unavailable.';
    case 'removed':
      return 'This file was removed by the files.gg team. Visitors see that it was removed.';
    case 'blocked':
      return 'This file was blocked and can’t be shared.';
    default:
      return null;
  }
}

/** The media can be shown (the CDN serves it) only while the state is `ok` or `flagged`. */
export const canShowMedia = (file: Pick<OwnerFile, 'safety'>) => !file.safety || file.safety.state === 'ok' || file.safety.state === 'flagged';
