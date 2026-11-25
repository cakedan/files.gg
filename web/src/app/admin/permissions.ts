/**
 * Staff permissions in the UI, exactly as milestone-4 §9.1. The API enforces them too;
 * the UI only hides what can't succeed.
 */

import type { StaffInfo } from '../../lib/api';
import type { AdminFileDetail, ModerationAction } from './adminApi';

export const isAdmin = (staff: StaffInfo) => staff.role === 'admin';

/** Child-safety cases (CSAM reports, matches, CSAM-linked holds): child-safety staff only. */
export const canSeeChildSafety = (staff: StaffInfo) => staff.child_safety;

/**
 * Opening media through a staff grant: moderators and admins, but not for child-safety
 * cases; child-safety staff for those. Never for hash-matched content.
 */
export function canOpenMedia(staff: StaffInfo, { childSafety, hashMatched }: { childSafety: boolean; hashMatched: boolean }) {
  if (hashMatched) return false;
  return childSafety ? staff.child_safety : true;
}

/** Bans: moderators up to 30 days; permanent bans and lifting bans are admin only. */
export const MAX_MODERATOR_BAN = 30 * 86400;
export const canLiftBans = isAdmin;
export const canBanPermanently = isAdmin;

/** Rescans, the staff list and the whole audit log are admin only. */
export const canSeeWholeAudit = isAdmin;
export const canRescan = isAdmin;

export interface ActionOption {
  action: ModerationAction;
  label: string;
  /** `rule` is required (§9.3). */
  needsRule: boolean;
  /** Sends the owner a notice when `notify` is on (§8.1). */
  notifies: boolean;
  danger?: boolean;
  /** Asks for confirmation first. */
  confirm?: boolean;
}

const OPTION: Record<ModerationAction, ActionOption> = {
  hide: { action: 'hide', label: 'Hide', needsRule: true, notifies: true },
  unhide: { action: 'unhide', label: 'Unhide', needsRule: false, notifies: false },
  remove: { action: 'remove', label: 'Remove', needsRule: true, notifies: true, danger: true },
  restore: { action: 'restore', label: 'Restore', needsRule: false, notifies: false },
  mark_nsfw: { action: 'mark_nsfw', label: 'Mark as sensitive', needsRule: true, notifies: true },
  unmark_nsfw: { action: 'unmark_nsfw', label: 'Unmark as sensitive', needsRule: false, notifies: false },
  delete: { action: 'delete', label: 'Delete (keeps a hold)', needsRule: true, notifies: true, danger: true, confirm: true },
  block_hash: { action: 'block_hash', label: 'Block the hash', needsRule: true, notifies: true, danger: true, confirm: true },
  unblock_hash: { action: 'unblock_hash', label: 'Unblock the hash', needsRule: false, notifies: false },
  clear_flag: { action: 'clear_flag', label: 'Clear the scanner flag', needsRule: false, notifies: false },
  retry_scan: { action: 'retry_scan', label: 'Retry the scan', needsRule: false, notifies: false },
  confirm_csam: { action: 'confirm_csam', label: 'Confirm CSAM', needsRule: true, notifies: false, danger: true, confirm: true },
  restrict_uploads: { action: 'restrict_uploads', label: 'Restrict uploads', needsRule: true, notifies: true },
  unrestrict_uploads: { action: 'unrestrict_uploads', label: 'Lift the upload restriction', needsRule: false, notifies: false },
  suspend_user: { action: 'suspend_user', label: 'Suspend the account', needsRule: true, notifies: true, danger: true, confirm: true },
  unsuspend_user: { action: 'unsuspend_user', label: 'Lift the suspension', needsRule: false, notifies: false },
  // Milestone 6 (§10.12, §11.4)
  revoke_sessions: { action: 'revoke_sessions', label: 'Sign out everywhere', needsRule: false, notifies: false, confirm: true },
  revoke_upload_keys: { action: 'revoke_upload_keys', label: 'Revoke every upload key', needsRule: false, notifies: true, danger: true, confirm: true },
  reset_username: { action: 'reset_username', label: 'Reset the username', needsRule: true, notifies: true, confirm: true },
  disable_domain: { action: 'disable_domain', label: 'Disable the domain', needsRule: true, notifies: true, danger: true, confirm: true },
  enable_domain: { action: 'enable_domain', label: 'Enable the domain', needsRule: false, notifies: false },
  set_domain_scope: { action: 'set_domain_scope', label: 'Force “Only my files”', needsRule: true, notifies: true },
};

/** Audit rows that aren't actions from the panel (§9.3 system actions, §9.5). */
const LOG_LABELS: Record<string, string> = {
  view_content: 'Opened media',
  claim: 'Claimed the case',
  release: 'Released the case',
  close_case: 'Closed the case',
  staff_message: 'Replied to a reporter',
  flag_second_review: 'Changed second review',
  appeal_granted: 'Granted the appeal',
  appeal_denied: 'Denied the appeal',
  cybertip_filed: 'Recorded a CyberTipline report',
  scan_block: 'Scanner blocked',
  scan_hold: 'Scanner held for review',
  scan_flag: 'Scanner flagged',
  csam_match: 'CSAM hash match',
  auto_hide: 'Hidden after reports',
  auto_nsfw: 'Marked as sensitive after reports',
  preserve_evidence: 'Preserved evidence',
  pdq_sweep_hit: 'Near-match found by a sweep',
  ban: 'Banned',
  unban: 'Lifted a ban',
  rescan: 'Queued rescans',
  grant_staff: 'Granted staff',
  revoke_staff: 'Revoked staff',
  grant_entitlement: 'Granted premium',
  change_entitlement: 'Changed premium',
  revoke_entitlement: 'Revoked premium',
  entitlement_expired: 'Premium expired',
};

export const actionLabel = (action: string) => OPTION[action as ModerationAction]?.label ?? LOG_LABELS[action] ?? action.replace(/_/g, ' ');

interface FileContext {
  moderationState: 'visible' | 'hidden' | 'removed';
  scanState: AdminFileDetail['scan_state'];
  /** Held because its scan kept failing. */
  scanStuck?: boolean;
  nsfw: boolean;
  hashMatched: boolean;
  csamRelated: boolean;
}

/** The actions that apply to a file in its current state (§9.3), for this staff member. */
export function fileActions(staff: StaffInfo, file: FileContext): ActionOption[] {
  // CSAM blocks can't be lifted through the API (§9.3); hash-matched content gets nothing.
  if (file.hashMatched) return [];
  const list: ModerationAction[] = [];
  if (file.moderationState === 'visible') list.push('hide', 'remove');
  if (file.moderationState === 'hidden') list.push('unhide', 'remove');
  if (file.moderationState === 'removed') list.push('restore');
  list.push(file.nsfw ? 'unmark_nsfw' : 'mark_nsfw');
  if (file.scanState === 'flagged' || file.scanState === 'held') list.push('clear_flag');
  if (file.scanState === 'pending' && file.scanStuck) list.push('retry_scan');
  if (file.scanState === 'blocked') {
    if (!file.csamRelated) list.push('unblock_hash');
  } else {
    list.push('block_hash');
  }
  list.push('delete');
  if (staff.child_safety) list.push('confirm_csam');
  return list.map((action) => OPTION[action]);
}

export function albumActions(_staff: StaffInfo, album: { moderationState: 'visible' | 'hidden' | 'removed'; nsfwMarked: boolean }): ActionOption[] {
  const list: ModerationAction[] = [];
  if (album.moderationState === 'visible') list.push('hide', 'remove');
  if (album.moderationState === 'hidden') list.push('unhide', 'remove');
  if (album.moderationState === 'removed') list.push('restore');
  list.push(album.nsfwMarked ? 'unmark_nsfw' : 'mark_nsfw', 'delete');
  return list.map((action) => OPTION[action]);
}

export function userActions(staff: StaffInfo, user: { restricted: boolean; suspended: boolean; csamSuspension: boolean }): ActionOption[] {
  // Milestone 6 §11.4: moderators and admins can end sessions and reset a username.
  const list: ModerationAction[] = [user.restricted ? 'unrestrict_uploads' : 'restrict_uploads', 'revoke_sessions', 'reset_username'];
  // Suspending and unsuspending are admin only; CSAM suspensions can't be lifted.
  if (isAdmin(staff)) {
    if (!user.suspended) list.push('suspend_user');
    else if (!user.csamSuspension) list.push('unsuspend_user');
  }
  return list.map((action) => OPTION[action]);
}

/** Milestone 6 (§9.3): granting, changing and revoking premium is admin only. */
export const canManagePremium = isAdmin;

/** §10.12: the domain actions for a domain in its current state (moderators and admins). */
export function domainActions(_staff: StaffInfo, domain: { status: string; scope: 'own' | 'any' }): ActionOption[] {
  const list: ModerationAction[] = domain.status === 'disabled' ? ['enable_domain'] : ['disable_domain'];
  if (domain.scope === 'any') list.push('set_domain_scope');
  return list.map((action) => OPTION[action]);
}

/** The option for one action, for panels that offer a single one (revoking one upload key). */
export const actionOption = (action: ModerationAction): ActionOption => OPTION[action];
