/**
 * Sending a report from the viewer (milestone-4 §7.3, milestone-6 §11.5, §13.1):
 * - **files.gg:** the report form asks `GET /api/auth/session` when it opens (never on
 *   page load). Signed in: `POST /api/reports` with the session cookie. Signed out:
 *   `POST /api/reports/anonymous` with a Turnstile token. Both through lib/api.
 * - **A custom domain:** never signed in (the cookie is files.gg's only), so always
 *   `POST https://api.files.gg/reports/anonymous` without credentials, with a token
 *   from the challenge frame.
 *
 * The signed-in decision comes from the session call, not from anything stored.
 */

import { loadAccess } from '../../lib/access';
import { request } from '../../lib/api';
import { hostContext } from '../host/context';
import { hostRequest } from '../locked/hostApi';
import type { ViewerReportRequest, ViewerReportTarget } from './formLogic';

/** What the form shows once a report is sent. */
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

/** `GET /auth/session` → `{ user: <user> | null }` (milestone-6 §3.4). Never throws. */
export async function checkSignedIn(signal?: AbortSignal): Promise<boolean> {
  if (hostContext().custom) return false;
  try {
    const response = await request<{ user?: unknown } | undefined>('/auth/session', { signal });
    return typeof response?.user === 'object' && response.user !== null;
  } catch {
    // Can't tell: send anonymously, which works for everyone.
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
 * An item of a password album (`/a/<vanity>?item=<n>`, milestone-6 §20.2, on files.gg or
 * this domain) can only be reported with the album's unlock token (milestone-4 §7.3), which
 * this origin keeps. The same rule as lib/reports' `albumItemAccessHeaders`, kept here so
 * the viewer doesn't depend on that module (it decides signed-in by itself).
 */
export function accessHeaders({ target }: { target: ViewerReportTarget }): Record<string, string> | undefined {
  if (target.type !== 'url') return undefined;
  let vanity: string;
  try {
    const url = new URL(target.url, 'https://files.gg');
    const match = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
    if (!match || !/^[1-9][0-9]*$/.test(url.searchParams.get('item') ?? '')) return undefined;
    vanity = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  const grant = loadAccess('album', vanity);
  return grant ? { 'X-Filesgg-Access': grant.token } : undefined;
}

export interface SubmitOptions {
  signedIn: boolean;
  /** Required when signed out. */
  turnstileToken?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Sends a report. Errors are `ApiError`s with the contract's codes. */
export async function submitReport(body: ViewerReportRequest, { signedIn, turnstileToken, signal }: SubmitOptions): Promise<ReportResult> {
  const headers = accessHeaders(body);
  if (signedIn && !hostContext().custom) {
    const { contact_email: _ignored, ...rest } = body;
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
  const anonymous = { ...body, turnstile_token: turnstileToken };
  const response = hostContext().custom
    ? await hostRequest<AnonymousResponse>('/reports/anonymous', { method: 'POST', body: anonymous, signal, ...(headers ? { headers } : {}) })
    : await request<AnonymousResponse>('/reports/anonymous', { method: 'POST', body: anonymous, signal, ...(headers ? { headers } : {}) });
  return {
    id: str(response?.id, ''),
    status: str(response?.status, 'open'),
    escalated: response?.escalated === true,
    duplicate: response?.duplicate === true,
    signedIn: false,
  };
}
