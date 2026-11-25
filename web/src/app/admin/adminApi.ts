/**
 * The staff API (milestone-4 §9). It lives in the admin chunk, so nobody else downloads
 * it; the shapes it shares with owners (`OwnerFile`, `OwnerAlbum`, `Notice`) come from
 * lib/api. Every `/admin/*` call answers non-staff with the 404 of an unknown route.
 */

import {
  request,
  type AlbumRef,
  type Notice,
  type OwnerAlbum,
  type OwnerAlbumItem,
  type OwnerAlbumSummary,
  type OwnerFile,
  type QueryValue,
  type ReportReason,
  type Restriction,
  type StaffInfo,
} from '../../lib/api';
import type { Domain, DomainStatus, UploadKey } from '../../lib/accountApi';

/** Milestone 6 adds `domain` cases (§10.12). */
export type CaseKind = 'file' | 'album' | 'user' | 'domain' | 'hash' | 'bug' | 'appeal';
export type Priority = 0 | 1 | 2 | 3;

export interface CaseTarget {
  type: 'file' | 'album' | 'user' | 'domain' | 'hash' | 'bug';
  id: string;
  vanity?: string | null;
  name?: string | null;
  /** The target's effective state (`ok`, `pending`, `hidden`, `removed`, `blocked`, `suspended`, …). */
  state: string;
}

/** §9.2 "Case summary". */
export interface CaseSummary {
  id: string;
  kind: CaseKind;
  priority: Priority;
  status: 'open' | 'closed';
  target: CaseTarget;
  /** Open reports by reason. */
  /** Report reasons with their counts. The API also lists the case's scanner flags here with a count of 0. */
  reasons: Partial<Record<ReportReason | (string & {}), number>>;
  report_count: number;
  distinct_reporters: number;
  /** Open scanner flag codes (§2.3). */
  flags: string[];
  assignee: { id: string; username: string } | null;
  needs_second_review: boolean;
  child_safety: boolean;
  created_at: number;
  age_seconds: number;
}

export interface StaffUrls {
  /** The file, signed with the staff grant for 10 minutes (§10.3). */
  content: string;
  previews: Partial<Record<string, string>>;
  expires_at?: number;
}

export interface StaffMessage {
  id: string;
  author: 'reporter' | 'staff';
  /** Staff only see each other's names; reporters always see "files.gg staff". */
  author_name?: string | null;
  body: string;
  created_at: number;
}

/** A report in a case. Never carries IP hashes (§9.2). */
export interface StaffReport {
  id: string;
  reason: ReportReason;
  status?: 'open' | 'resolved' | 'dismissed';
  details: string;
  album_part: string | null;
  dmca: Record<string, unknown> | null;
  created_at: number;
  reporter: { user_id?: string; signed_in: boolean; account_age_days?: number };
  /** The thread, when the API includes it. */
  messages?: StaffMessage[];
}

export interface CaseFlag {
  id: string;
  source: 'scan' | 'rescan' | 'reports' | 'owner';
  reason: string;
  details: Record<string, unknown> | null;
  created_at: number;
  resolved_at: number | null;
}

/** §9.5. */
export interface AuditEntry {
  id: string;
  actor: { id: string | null; username: string | null; kind: 'staff' | 'system' | 'cli' };
  action: string;
  rule: string | null;
  target: { type: string; id: string } | null;
  note: string | null;
  details: Record<string, unknown> | null;
  reverses_action_id: string | null;
  created_at: number;
  case_id?: string | null;
  report_id?: string | null;
  warning_id?: string | null;
}

export interface TargetOwner {
  user_id: string | null;
  username: string | null;
  fingerprint: string | null;
  account_created_at: number | null;
  anonymous: boolean;
}

export interface ScanFinding {
  check: string;
  code: string;
  detail: string;
}

/** `GET /admin/files/<id>` (§9.6). */
export interface AdminFileDetail {
  file: OwnerFile;
  owner: TargetOwner;
  deleted?: boolean;
  moderation_state?: 'visible' | 'hidden' | 'removed';
  moderation_rule?: string | null;
  scan_state: 'pending' | 'passed' | 'flagged' | 'held' | 'blocked';
  /** Held because its scan kept failing (`scan_failing`): `retry_scan` queues a fresh scan. */
  scan_stuck?: boolean;
  scan: { findings: ScanFinding[]; warnings?: string[]; link_warnings?: string[]; cleared?: unknown[] };
  nsfw_score: number | null;
  same_hash: { count: number; ids?: string[] };
  albums: AlbumRef[];
  reports: StaffReport[];
  cases: CaseSummary[];
  actions: AuditEntry[];
  /** Hash-matched CSAM: never displayable, and no URL is ever returned (§3.6). */
  hash_matched?: boolean;
  /** Absent for child-safety cases without the capability, and always for hash-matched content. */
  staff_urls?: StaffUrls;
}

export type AdminAlbumItem = OwnerAlbumItem & { staff_urls?: StaffUrls };

/** `GET /admin/albums/<id>`. */
export interface AdminAlbumDetail {
  album: Omit<OwnerAlbum, 'items'> & { items: AdminAlbumItem[] };
  owner: TargetOwner;
  deleted?: boolean;
  moderation_state: 'visible' | 'hidden' | 'removed';
  moderation_rule: string | null;
  nsfw_marked: boolean;
  nsfw_source: 'owner' | 'moderator' | null;
  reports: StaffReport[];
  cases: CaseSummary[];
  actions: AuditEntry[];
}

export interface AdminRestriction {
  id: string;
  kind: 'uploads' | 'suspended';
  rule: string;
  starts_at: number;
  ends_at: number | null;
  lifted_at: number | null;
  notice_id?: string | null;
}

/** §9.3 entitlement object (`note` is staff only). */
export interface Entitlement {
  id: string;
  kind: 'premium';
  active: boolean;
  granted_at: number;
  granted_by: { id: string; username: string } | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: { id: string; username: string } | null;
  note: string | null;
}

/** §9.3 identities on the admin user page. */
export interface AdminIdentity {
  provider: 'discord';
  provider_user_id: string;
  username: string | null;
  created_at: number;
}

/** `GET /admin/domains/<id>` (§10.12): the domain object plus its owner, Cloudflare id, cases and actions. */
export interface AdminDomainDetail extends Domain {
  owner: { id: string; username: string } | null;
  cf_hostname_id?: string | null;
  cases?: CaseSummary[];
  actions?: AuditEntry[];
}

/** `GET /admin/domains` items (§10.12): the domain object plus its owner. */
export interface AdminDomainSummary extends Domain {
  owner: { id: string; username: string | null } | null;
  cf_hostname_id?: string | null;
}

export interface AdminDomainsParams {
  q?: string | undefined;
  status?: DomainStatus | undefined;
  cursor?: string | undefined;
}

/** `GET /admin/users/<id>`. Milestone 6 adds the account fields (§9.3). */
export interface AdminUserDetail {
  user: { id: string; username: string; display_name?: string | null; email: string | null; created_at: number; verified?: boolean; email_verified?: boolean };
  premium?: boolean;
  entitlements?: Entitlement[];
  identities?: AdminIdentity[];
  sessions?: { active: number };
  upload_keys?: UploadKey[];
  domains?: Domain[];
  deletion?: { requested_at: number; scheduled_for: number } | null;
  staff: StaffInfo | null;
  restrictions: AdminRestriction[];
  warnings: { count: number; strikes?: number; items?: Notice[] };
  counts: { files: number; albums: number; reports_made: number; reports_against: number };
  files: OwnerFile[];
  actions?: AuditEntry[];
  cases?: CaseSummary[];
}

export type TargetDetail = AdminFileDetail | AdminAlbumDetail | AdminUserDetail | AdminDomainDetail;

export const isFileDetail = (detail: TargetDetail | null | undefined): detail is AdminFileDetail => Boolean(detail && 'file' in detail);
export const isAlbumDetail = (detail: TargetDetail | null | undefined): detail is AdminAlbumDetail => Boolean(detail && 'album' in detail);
export const isUserDetail = (detail: TargetDetail | null | undefined): detail is AdminUserDetail => Boolean(detail && 'user' in detail && 'counts' in detail);
export const isDomainDetail = (detail: TargetDetail | null | undefined): detail is AdminDomainDetail => Boolean(detail && 'hostname' in detail && 'status' in detail);

/** §9.2 "Case": the summary plus reports, flags in full, history and the target. */
export interface CaseDetail extends Omit<CaseSummary, 'flags'> {
  reports: StaffReport[];
  flags: CaseFlag[];
  actions: AuditEntry[];
  target_detail: TargetDetail | null;
  /** Appeal cases: the notice and the original action. */
  appeal?: {
    notice: Notice;
    user?: { id: string; username: string | null };
    message?: string | null;
    counter_notice?: Record<string, unknown> | null;
    original_action: AuditEntry | null;
  } | null;
  hash_matched?: boolean;
  outcome?: 'actioned' | 'dismissed' | null;
  outcome_reason?: string | null;
  cybertip_report_id?: string | null;
  cybertip_filed_at?: number | null;
}

/** `GET /admin/summary`. */
export interface AdminSummary {
  open: { p0: number; p1: number; p2: number; p3: number };
  unassigned: number;
  mine: number;
  past_goal: { p0: number; other: number };
  appeals: number;
  bugs: number;
  scans_stalled: number;
  /** Child-safety staff only. */
  cybertip_unrecorded: number;
  newest_p0_at: number | null;
}

export interface CasesParams {
  status?: 'open' | 'closed' | 'all' | undefined;
  priority?: Priority | undefined;
  reason?: string | undefined;
  kind?: CaseKind | undefined;
  /** `me`, `none` or a staff user id. */
  assignee?: string | undefined;
  needs_second_review?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type ModerationAction =
  | 'hide'
  | 'unhide'
  | 'remove'
  | 'restore'
  | 'mark_nsfw'
  | 'unmark_nsfw'
  | 'delete'
  | 'block_hash'
  | 'unblock_hash'
  | 'clear_flag'
  | 'retry_scan'
  | 'confirm_csam'
  | 'restrict_uploads'
  | 'unrestrict_uploads'
  | 'suspend_user'
  | 'unsuspend_user'
  // Milestone 6 (§10.12, §11.4)
  | 'revoke_sessions'
  | 'revoke_upload_keys'
  | 'reset_username'
  | 'disable_domain'
  | 'enable_domain'
  | 'set_domain_scope';

/** `POST /admin/actions` (§9.3). */
export interface ActionBody {
  action: ModerationAction;
  target: { type: 'file' | 'album' | 'user' | 'hash' | 'domain'; id: string };
  rule?: string;
  /** Staff-only. */
  note?: string;
  /** For the owner's notice. */
  message?: string;
  notify?: boolean;
  case_id?: string;
  /** Seconds. */
  duration?: number;
  hold_days?: number;
  also_block_hash?: boolean;
  /** `revoke_upload_keys`: `{ key_id }` revokes one key instead of all (§11.4). */
  details?: Record<string, unknown>;
}

export interface ActionResult {
  action: AuditEntry;
  notice_ids: string[];
}

export interface Ban {
  id: string;
  kind: 'fingerprint' | 'ip';
  /** Where the fingerprint or IP hash came from; never the value itself. */
  source: { file_id?: string; report_id?: string; fingerprint?: string };
  rule: string;
  note?: string | null;
  created_at: number;
  expires_at: number | null;
  lifted_at: number | null;
}

export interface BanBody {
  kind: 'fingerprint' | 'ip';
  from: { file_id: string } | { report_id: string } | { fingerprint: string };
  /** Seconds; moderators up to 30 days, none (permanent) is admin only. */
  duration?: number;
  rule: string;
  note?: string;
}

export interface AuditParams {
  actor_id?: string | undefined;
  action?: string | undefined;
  file_id?: string | undefined;
  album_id?: string | undefined;
  user_id?: string | undefined;
  case_id?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface LookupUser {
  id: string;
  username: string;
  email?: string | null;
  created_at?: number;
  staff?: StaffInfo | null;
  restrictions?: Restriction[];
}

export interface LookupResult {
  files: Array<OwnerFile & { owner?: TargetOwner; deleted?: boolean }>;
  albums: Array<OwnerAlbumSummary & { owner?: TargetOwner; deleted?: boolean }>;
  users: LookupUser[];
  /** Milestone 6: hostnames match too (§10.12). */
  domains?: Domain[];
}

export interface StaffMember {
  user_id: string;
  username: string;
  role: 'moderator' | 'admin';
  child_safety: boolean;
  granted_at: number;
}

export interface RescanBody {
  checks: Array<'clamav' | 'csam' | 'pdq' | 'web_risk'>;
  kinds?: string[];
  /** Epoch seconds. */
  uploaded_after?: number;
}

const caseUrl = (id: string) => `/admin/cases/${encodeURIComponent(id)}`;
const query = (params: object) => params as Record<string, QueryValue>;

export const adminApi = {
  summary: (signal?: AbortSignal) => request<AdminSummary>('/admin/summary', { signal }),
  cases: (params: CasesParams, signal?: AbortSignal) => request<Page<CaseSummary>>('/admin/cases', { query: query(params), signal }),
  case: (id: string, signal?: AbortSignal) => request<CaseDetail>(caseUrl(id), { signal }),
  /** `409 CASE_CLAIMED { assignee_id }`; admins can take it with `force`. */
  claim: (id: string, force = false) => request<CaseDetail>(`${caseUrl(id)}/claim`, { method: 'POST', body: force ? { force: true } : {} }),
  release: (id: string) => request<CaseDetail>(`${caseUrl(id)}/release`, { method: 'POST', body: {} }),
  message: (id: string, reportId: string, body: string) =>
    request<StaffMessage>(`${caseUrl(id)}/messages`, { method: 'POST', body: { report_id: reportId, body } }),
  close: (id: string, body: { outcome: 'actioned' | 'dismissed'; reason: string; reporter_message?: string }) =>
    request<CaseDetail>(`${caseUrl(id)}/close`, { method: 'POST', body }),
  /** `409 SAME_MODERATOR` (§9.4). */
  decideAppeal: (id: string, body: { decision: 'grant' | 'deny'; message: string }) =>
    request<CaseDetail>(`${caseUrl(id)}/appeal`, { method: 'POST', body }),
  cybertip: (id: string, reportId: string) => request<CaseDetail>(`${caseUrl(id)}/cybertip`, { method: 'POST', body: { report_id: reportId } }),
  updateCase: (id: string, body: { needs_second_review: boolean }) => request<CaseDetail>(caseUrl(id), { method: 'PATCH', body }),
  action: (body: ActionBody) => request<ActionResult>('/admin/actions', { method: 'POST', body }),
  bans: (params: { active?: boolean; cursor?: string }, signal?: AbortSignal) => request<Page<Ban>>('/admin/bans', { query: query(params), signal }),
  createBan: (body: BanBody) => request<Ban>('/admin/bans', { method: 'POST', body }),
  liftBan: (id: string) => request<Ban>(`/admin/bans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  audit: (params: AuditParams, signal?: AbortSignal) => request<Page<AuditEntry>>('/admin/audit', { query: query(params), signal }),
  lookup: (q: string, signal?: AbortSignal) => request<LookupResult>('/admin/lookup', { query: { q }, signal }),
  file: (id: string, signal?: AbortSignal) => request<AdminFileDetail>(`/admin/files/${encodeURIComponent(id)}`, { signal }),
  album: (id: string, signal?: AbortSignal) => request<AdminAlbumDetail>(`/admin/albums/${encodeURIComponent(id)}`, { signal }),
  user: (id: string, signal?: AbortSignal) => request<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`, { signal }),
  rescans: (body: RescanBody) => request<{ queued: number }>('/admin/rescans', { method: 'POST', body }),
  staff: (signal?: AbortSignal) => request<{ items: StaffMember[] }>('/admin/staff', { signal }),

  // Milestone 6: premium (§9.3) and domains (§10.12)
  grantPremium: (userId: string, body: { expires_at?: number | null; note: string }) =>
    request<Entitlement>(`/admin/users/${encodeURIComponent(userId)}/entitlements`, { method: 'POST', body: { kind: 'premium', ...body } }),
  changeEntitlement: (userId: string, id: string, body: { expires_at: number | null; note: string }) =>
    request<Entitlement>(`/admin/users/${encodeURIComponent(userId)}/entitlements/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  revokeEntitlement: (userId: string, id: string, note: string) =>
    request<Entitlement>(`/admin/users/${encodeURIComponent(userId)}/entitlements/${encodeURIComponent(id)}`, { method: 'DELETE', body: { note } }),
  domain: (id: string, signal?: AbortSignal) => request<AdminDomainDetail>(`/admin/domains/${encodeURIComponent(id)}`, { signal }),
  domains: (params: AdminDomainsParams, signal?: AbortSignal) => request<Page<AdminDomainSummary>>('/admin/domains', { query: query(params), signal }),
};
