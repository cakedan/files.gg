/**
 * Milestone 6 account calls (docs/redesign/contracts/milestone-6.md §2–§10): signing in,
 * settings, upload keys, domains and data export. Dashboard only, so the viewer's bundles
 * never carry them. Every call is same-origin through lib/api's `request`, which adds
 * the CSRF header on writes and the guest token while signed out (claiming, §4.2).
 */

import { request, type Identity, type UploadDefaults, type User, type ViewLimitAction } from './api';
import type { UsernameReason } from './usernames';

/** Sign-in responses (§3.2): the cookie is set by the response; the body never has the token. */
export interface SignInResponse {
  expires_at: number;
  user: User;
}

/** `GET /auth/config` (§15). */
export interface AuthConfig {
  discord: boolean;
}

export type DiscordPurpose = 'login' | 'link' | 'reauth';

export interface DiscordProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** §5.3 outcomes of `POST /auth/discord/callback`. */
export type DiscordCallbackResponse =
  | ({ status: 'signed_in' } & SignInResponse)
  | {
      status: 'signup_required';
      signup_token: string;
      suggested_username: string;
      discord: DiscordProfile;
      email: { address: string | null; usable: boolean; reason: null | 'unverified' | 'missing' | 'in_use' };
    }
  | { status: 'linked'; identity: Identity }
  | { status: 'reauthenticated' };

export interface UsernameCheck {
  username: string;
  available: boolean;
  reason?: UsernameReason;
}

/** §8.3 session object. */
export interface AccountSession {
  id: string;
  current: boolean;
  method: 'password' | 'discord' | 'register' | 'reset';
  created_at: number;
  last_used_at: number;
  expires_at: number;
  device: string;
  country: string | null;
}

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

/** §8.7 export object. */
export interface DataExport {
  id: string;
  status: ExportStatus;
  created_at: number;
  ready_at: number | null;
  expires_at: number | null;
  size: number | null;
}

export type UploadKeyScope = 'files:upload' | 'albums:append';

/** §7.3 key object. Never the secret. */
export interface UploadKey {
  id: string;
  name: string;
  /** `fgg_` plus 8 characters. */
  prefix: string;
  scopes: UploadKeyScope[];
  domain: { id: string; hostname: string } | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  state: 'active' | 'revoked' | 'expired';
}

export interface CreateUploadKeyBody {
  name: string;
  scopes?: UploadKeyScope[];
  domain_id?: string | null;
  /** Seconds: 30, 90 or 365 days; null never expires. */
  expires_in?: number | null;
  /** The ShareX defaults, so the API's own `sharex` and `curl` carry the same `Arguments`. */
  sharex?: {
    expires_in?: number;
    visibility?: string;
    generate_password?: boolean;
    nsfw?: boolean;
    album?: string;
    /** Milestone 6 §19.3: 1–1000, with its action. */
    view_limit?: number;
    view_limit_action?: ViewLimitAction;
  };
}

/** `201` from creating a key: the only time `secret` is ever returned. */
export interface CreatedUploadKey {
  key: UploadKey;
  secret: string;
  /** The API's own `.sxcu` object (without Arguments); the web app builds its own (lib/sharex.ts). */
  sharex?: Record<string, unknown>;
  curl?: string;
}

export type DomainStatus = 'pending_dns' | 'pending_cert' | 'active' | 'failing' | 'failed' | 'paused' | 'disabled';

export interface DomainRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
  ok: boolean;
}

/** §10.5 domain object. */
export interface Domain {
  id: string;
  hostname: string;
  status: DomainStatus;
  status_reason: string | null;
  serving: boolean;
  is_default: boolean;
  scope: 'own' | 'any';
  records: DomainRecord[];
  cloudflare: { status: string | null; ssl_status: string | null } | null;
  created_at: number;
  verified_at: number | null;
  last_checked_at: number | null;
  pending_until: number | null;
  failing_since: number | null;
  disabled_reason: string | null;
}

export interface DomainOnlyState {
  enabled: boolean;
  effective: boolean;
  paused: boolean;
}

export interface DomainsResponse {
  items: Domain[];
  limit: number;
  domain_only: DomainOnlyState;
}

export interface DomainOnlyPreview {
  affected_files: number;
  affected_albums: number;
}

const keyUrl = (id: string) => `/users/@me/upload-keys/${encodeURIComponent(id)}`;
const domainUrl = (id: string) => `/users/@me/domains/${encodeURIComponent(id)}`;
const sessionUrl = (id: string) => `/users/@me/sessions/${encodeURIComponent(id)}`;

/** The download is a same-origin navigation, so the browser sends the cookie (§8.7). */
export const exportDownloadPath = (id: string) => `/api/users/@me/exports/${encodeURIComponent(id)}/download`;

export const accountApi = {
  config: (signal?: AbortSignal) => request<AuthConfig>('/auth/config', { signal }),

  // Email and password (§4)
  login: (body: { email: string; password: string; turnstile_token: string }) =>
    request<SignInResponse>('/auth/login', { method: 'POST', body }),
  register: (body: { email: string; username: string; password: string; display_name?: string; turnstile_token: string }) =>
    request<SignInResponse>('/auth/register', { method: 'POST', body }),
  logout: () => request<void>('/auth/logout', { method: 'POST', auth: false }),
  verify: (token: string) => request<void>('/auth/verify', { method: 'POST', body: { token }, auth: false }),
  resendVerification: () => request<void>('/auth/verify/resend', { method: 'POST', auth: false }),
  forgot: (body: { email: string; turnstile_token: string }) => request<void>('/auth/forgot', { method: 'POST', body, auth: false }),
  reset: (body: { token: string; password: string; turnstile_token: string }) =>
    request<SignInResponse>('/auth/forgot/reset', { method: 'POST', body }),
  reauth: (password: string) => request<void>('/auth/reauth', { method: 'POST', body: { password }, auth: false }),

  // Discord (§5)
  discordAuthorize: (purpose: DiscordPurpose, codeChallenge: string) =>
    request<{ url: string; state: string }>('/auth/discord/authorize', { method: 'POST', body: { purpose, code_challenge: codeChallenge }, auth: false }),
  discordCallback: (body: { code: string; state: string; code_verifier: string; turnstile_token?: string }) =>
    request<DiscordCallbackResponse>('/auth/discord/callback', { method: 'POST', body }),
  discordSignup: (body: { signup_token: string; username: string; display_name?: string; turnstile_token: string }) =>
    request<SignInResponse>('/auth/discord/signup', { method: 'POST', body }),

  // Profile (§8.1)
  updateMe: (body: { display_name?: string | null; settings?: { show_name_on_albums?: boolean; upload_defaults?: Partial<UploadDefaults> } }) =>
    request<User>('/users/@me', { method: 'PATCH', body }),
  setUsername: (username: string) => request<User>('/users/@me/username', { method: 'PUT', body: { username } }),
  checkUsername: (username: string, signal?: AbortSignal) =>
    request<UsernameCheck>('/users/@me/username/check', { query: { username }, signal, auth: false }),

  // Login methods (§8.2)
  identities: (signal?: AbortSignal) => request<{ items: Identity[] }>('/users/@me/identities', { signal }),
  unlinkDiscord: () => request<void>('/users/@me/identities/discord', { method: 'DELETE' }),

  // Sessions (§8.3)
  sessions: (signal?: AbortSignal) => request<{ items: AccountSession[] }>('/users/@me/sessions', { signal }),
  revokeSession: (id: string) => request<void>(sessionUrl(id), { method: 'DELETE' }),
  revokeAllSessions: () => request<{ revoked: number }>('/users/@me/sessions', { method: 'DELETE' }),

  // Email and password (§8.4, §8.5)
  changeEmail: (email: string) => request<{ pending_email: string | null }>('/users/@me/email', { method: 'POST', body: { email } }),
  cancelPendingEmail: () => request<void>('/users/@me/email/pending', { method: 'DELETE' }),
  setPassword: (body: { current_password?: string; new_password: string }) => request<void>('/users/@me/password', { method: 'PUT', body }),

  // Data export and deletion (§8.7, §8.8)
  exports: (signal?: AbortSignal) => request<{ items: DataExport[] }>('/users/@me/exports', { signal }),
  requestExport: () => request<{ export: DataExport }>('/users/@me/exports', { method: 'POST' }),
  requestDeletion: (confirmUsername: string) =>
    request<{ deletion: NonNullable<User['deletion']> }>('/users/@me/delete', { method: 'POST', body: { confirm_username: confirmUsername } }),
  cancelDeletion: () => request<User>('/users/@me/delete/cancel', { method: 'POST' }),

  // Upload keys (§7.3)
  uploadKeys: (signal?: AbortSignal) => request<{ items: UploadKey[]; limit: number }>('/users/@me/upload-keys', { signal }),
  createUploadKey: (body: CreateUploadKeyBody) => request<CreatedUploadKey>('/users/@me/upload-keys', { method: 'POST', body }),
  updateUploadKey: (id: string, body: { name?: string; domain_id?: string | null }) => request<UploadKey>(keyUrl(id), { method: 'PATCH', body }),
  revokeUploadKey: (id: string) => request<void>(keyUrl(id), { method: 'DELETE' }),

  // Domains (§10.5)
  domains: (signal?: AbortSignal) => request<DomainsResponse>('/users/@me/domains', { signal }),
  addDomain: (hostname: string) => request<Domain>('/users/@me/domains', { method: 'POST', body: { hostname } }),
  checkDomain: (id: string) => request<Domain>(`${domainUrl(id)}/verify`, { method: 'POST' }),
  retryDomain: (id: string) => request<Domain>(`${domainUrl(id)}/retry`, { method: 'POST' }),
  updateDomain: (id: string, body: { default?: boolean; scope?: 'own' | 'any'; confirm?: boolean }) =>
    request<Domain>(domainUrl(id), { method: 'PATCH', body }),
  removeDomain: (id: string) => request<void>(domainUrl(id), { method: 'DELETE' }),
  setDomainOnly: (enabled: boolean, confirm?: boolean) =>
    request<DomainOnlyState & Partial<DomainOnlyPreview>>('/users/@me/domain-only', { method: 'PUT', body: confirm ? { enabled, confirm } : { enabled } }),
  domainOnlyPreview: (signal?: AbortSignal) => request<DomainOnlyPreview>('/users/@me/domain-only/preview', { signal }),
};
