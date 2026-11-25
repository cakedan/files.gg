/**
 * Sending reports (milestone-4 §7.3, milestone-6 §11.5). Signed in (the session cookie,
 * as `GET /auth/session` says): `POST /reports`. Signed out: `POST /reports/anonymous`
 * with a Turnstile token (action `report`) and the stored `X-Fingerprint`, if any.
 *
 * Used by lazy report chunks only, so the API client never reaches the viewer's entry
 * bundle. The viewer's form has its own sender (src/viewer/report/send.ts) for custom
 * domains; `albumItemAccessHeaders` is shared.
 */

import { loadAccess } from './access';
import { fetchSession, request, signedInState } from './api';
import type { AlbumPart, DmcaNotice, ReportReason } from './reportTypes';

export { ALBUM_PARTS, REPORT_REASONS, type AlbumPart, type DmcaNotice, type ReportReason } from './reportTypes';

export type ReportTargetBody =
  | { type: 'file'; vanity: string }
  | { type: 'album'; vanity: string; part: AlbumPart }
  | { type: 'bug' }
  | { type: 'url'; url: string };

export interface ReportRequest {
  target: ReportTargetBody;
  reason: ReportReason;
  details?: string | undefined;
  /** Anonymous only; ignored (and not sent) when signed in. */
  contact_email?: string | undefined;
  dmca?: DmcaNotice | undefined;
}

export interface ReportResult {
  id: string;
  status: string;
  /** `csam` reports: the UI shows only "Thank you. This has been escalated." */
  escalated: boolean;
  /** An open report by the same reporter on the same target already existed. */
  duplicate: boolean;
  /** Sent with an account (`POST /reports`), so it shows in My reports. */
  signedIn: boolean;
}

/** The last known session answer (false until `GET /auth/session` has said otherwise). */
export const isSignedIn = (): boolean => signedInState() === true;

/** Asks `GET /auth/session` (§13.1: when a report form opens). A failure counts as signed out. */
export async function checkSignedIn(signal?: AbortSignal): Promise<boolean> {
  try {
    return (await fetchSession(signal)) !== null;
  } catch {
    return false;
  }
}

interface SignedInResponse {
  report?: { id?: unknown; status?: unknown; escalated?: unknown };
  duplicate?: unknown;
  escalated?: unknown;
}

interface AnonymousResponse {
  id?: unknown;
  status?: unknown;
  escalated?: unknown;
  duplicate?: unknown;
}

const str = (value: unknown, fallback: string) => (typeof value === 'string' || typeof value === 'number' ? String(value) : fallback);

/**
 * An item of a password album (`files.gg/a/<vanity>?item=<n>`, milestone-6 §20.2) can only be
 * reported with the album's unlock token (the API refuses it otherwise, so positions can't be
 * probed). Returns the `X-Filesgg-Access` header for such a URL target when this browser has
 * unlocked it.
 */
export function albumItemAccessHeaders(target: ReportTargetBody): Record<string, string> | undefined {
  if (target.type !== 'url') return undefined;
  let url: URL;
  try {
    url = new URL(target.url, 'https://files.gg');
  } catch {
    return undefined;
  }
  const match = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || !/^[1-9][0-9]*$/.test(url.searchParams.get('item') ?? '')) return undefined;
  let vanity: string;
  try {
    vanity = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  const grant = loadAccess('album', vanity);
  return grant ? { 'X-Filesgg-Access': grant.token } : undefined;
}

/**
 * Sends a report. `turnstileToken` is required when signed out (and ignored when
 * signed in). Errors are `ApiError`s with the contract's codes (§12).
 */
export async function sendReport(body: ReportRequest, turnstileToken?: string, signal?: AbortSignal, signedIn: boolean = isSignedIn()): Promise<ReportResult> {
  if (signedIn) {
    const { contact_email: _ignored, ...rest } = body;
    const headers = albumItemAccessHeaders(body.target);
    const response = await request<SignedInResponse>('/reports', { method: 'POST', body: rest, signal, ...(headers ? { headers } : {}) });
    const report = response?.report ?? {};
    return {
      id: str(report.id, ''),
      status: str(report.status, 'open'),
      escalated: response?.escalated === true || report.escalated === true,
      duplicate: response?.duplicate === true,
      signedIn: true,
    };
  }
  const headers = albumItemAccessHeaders(body.target);
  const response = await request<AnonymousResponse>('/reports/anonymous', {
    method: 'POST',
    ...(headers ? { headers } : {}),
    body: { ...body, turnstile_token: turnstileToken },
    signal,
  });
  return {
    id: str(response?.id, ''),
    status: str(response?.status, 'open'),
    escalated: response?.escalated === true,
    duplicate: response?.duplicate === true,
    signedIn: false,
  };
}

export { ApiError } from './api';
