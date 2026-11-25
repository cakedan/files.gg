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

import { request } from '../../lib/api';
import { albumItemAccessHeaders, type ReportResult } from '../../lib/reports';
import { hostContext } from '../host/context';
import { hostRequest } from '../locked/hostApi';
import type { ViewerReportRequest } from './formLogic';

export type { ReportResult };

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

/** `X-Filesgg-Access` for an item of a password album this browser unlocked (lib/reports). */
const accessHeaders = (body: ViewerReportRequest) =>
  body.target.type === 'domain' ? undefined : albumItemAccessHeaders(body.target);

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
