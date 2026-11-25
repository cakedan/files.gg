/**
 * The `files.gg/challenge` frame's messages (milestone-6 §10.10). Shared by the frame
 * (web/src/challenge/main.ts) and the custom-domain viewer that embeds it
 * (web/src/viewer/host/useChallengeFrame.ts). No imports: both sides stay tiny.
 *
 * Frame → parent, always with `targetOrigin` = the custom domain's origin:
 * - `{ type: "filesgg:turnstile", token }`: a fresh token (the contract's message);
 * - `{ type: "filesgg:turnstile-error", code }`: Turnstile failed in the frame;
 * - `{ type: "filesgg:turnstile-expired" }`: the last token expired unused.
 * The parent never sends anything to the frame: a fresh token means a fresh frame.
 */

export type ChallengeAction = 'unlock' | 'report';
export const CHALLENGE_ACTIONS: readonly ChallengeAction[] = ['unlock', 'report'];

export const CHALLENGE_PATH = '/challenge';

export const MSG_TOKEN = 'filesgg:turnstile';
export const MSG_ERROR = 'filesgg:turnstile-error';
export const MSG_EXPIRED = 'filesgg:turnstile-expired';

export type ChallengeMessage =
  | { type: typeof MSG_TOKEN; token: string }
  | { type: typeof MSG_ERROR; code: string }
  | { type: typeof MSG_EXPIRED };

/** Turnstile tokens are at most 2,048 characters (Cloudflare's server-side validation docs). */
const TOKEN_MAX = 2048;

/** Validates a message's data; anything unexpected is null. */
export function parseChallengeMessage(data: unknown): ChallengeMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, token, code } = data as { type?: unknown; token?: unknown; code?: unknown };
  if (type === MSG_TOKEN) {
    return typeof token === 'string' && token.length > 0 && token.length <= TOKEN_MAX ? { type, token } : null;
  }
  if (type === MSG_ERROR) return { type, code: typeof code === 'string' ? code.slice(0, 64) : 'unknown' };
  if (type === MSG_EXPIRED) return { type };
  return null;
}

/** `https://files.gg/challenge?host=<host>&action=<action>` (§10.10). */
export function challengeUrl(mainOrigin: string, host: string, action: ChallengeAction, extra?: Record<string, string>): string {
  const query = new URLSearchParams({ host, action, ...extra });
  return `${mainOrigin}${CHALLENGE_PATH}?${query.toString()}`;
}
