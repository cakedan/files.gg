/**
 * The viewer's API calls for protected pages, on either host (milestone-6 §10.11, §13.4):
 * - on files.gg, lib/api's client (same-origin `/api`, the session cookie, CSRF);
 * - on a custom domain, `api_origin` (`https://api.files.gg`) cross-origin with
 *   `credentials: "omit"`: no cookie, no guest, no CSRF header (which would need
 *   a preflight the public routes don't allow), only `X-Filesgg-Access` where the call
 *   needs it. Every URL in the response is rehosted onto this domain (§10.9).
 *
 * Lazy chunks only (lock screen, report form): never in the viewer's entry bundle, which
 * is why it lives here, where eslint lets the viewer use lib/api.
 */

import {
  accessPath,
  api,
  ApiError,
  CLIENT_ERROR,
  openPath,
  parseApiError,
  type AccessKind,
  type OpenResponse,
  type UnlockResponse,
  type ViewResponse,
} from '../../lib/api';
import { hostContext, type HostContext } from '../host/context';
import { rehostPayload } from '../host/rehost';

export interface HostRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

/** A credential-less request to the API origin from a custom domain. Errors are `ApiError`s. */
export async function hostRequest<T>(path: string, options: HostRequestOptions = {}, context: HostContext = hostContext()): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${context.apiOrigin}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      credentials: 'omit',
      mode: 'cors',
      signal: signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, CLIENT_ERROR.network, "Couldn't reach files.gg. Check your connection and try again.");
  }
  if (!response.ok) throw await parseApiError(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(response.status, CLIENT_ERROR.invalidResponse, 'The server sent an invalid response.', text);
  }
  // Payload URLs arrive on cdn.files.gg and files.gg; move them onto this domain.
  return rehostPayload(parsed, context.origin, [context.cdnOrigin, context.mainOrigin]) as T;
}

/** `unlock`, `view`, `refreshUnlock` and `open`, with lib/api's signatures, routed by host. */
export const viewerApi = {
  unlock(kind: AccessKind, vanity: string, password: string, turnstileToken: string): Promise<UnlockResponse> {
    if (!hostContext().custom) return api.unlock(kind, vanity, password, turnstileToken);
    return hostRequest<UnlockResponse>(accessPath('unlock', kind, vanity), {
      method: 'POST',
      body: { password, turnstile_token: turnstileToken },
    });
  },
  view(kind: AccessKind, vanity: string, token: string): Promise<ViewResponse> {
    if (!hostContext().custom) return api.view(kind, vanity, token);
    return hostRequest<ViewResponse>(accessPath('view', kind, vanity), { headers: { 'X-Filesgg-Access': token } });
  },
  refreshUnlock(kind: AccessKind, vanity: string, token: string): Promise<UnlockResponse> {
    if (!hostContext().custom) return api.refreshUnlock(kind, vanity, token);
    return hostRequest<UnlockResponse>(accessPath('refresh', kind, vanity), { method: 'POST', body: { token } });
  },
  /** Milestone 6 §19.4: open (and count) a view-limited file. Opening again refreshes its URLs. */
  open(vanity: string, turnstileToken: string): Promise<OpenResponse> {
    if (!hostContext().custom) return api.openFile(vanity, turnstileToken);
    return hostRequest<OpenResponse>(openPath(vanity), { method: 'POST', body: { turnstile_token: turnstileToken } });
  },
};
