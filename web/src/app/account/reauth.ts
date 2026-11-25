/** Re-authentication helpers (milestone-6 §3.5). */

export type ReauthMethod = 'password' | 'discord';

/** Thrown (and ignored by forms) when the person closes the re-authentication dialog. */
export class ReauthCancelled extends Error {
  override readonly name = 'ReauthCancelled';
  constructor() {
    super('Re-authentication was cancelled.');
  }
}

export const isReauthCancelled = (error: unknown) => error instanceof ReauthCancelled;

/** The methods in `403 REAUTH_REQUIRED { methods }`, password first. */
export function reauthMethods(error: unknown): ReauthMethod[] {
  const methods = (error as { body?: { methods?: unknown } } | undefined)?.body?.methods;
  const list = Array.isArray(methods) ? methods.filter((method): method is ReauthMethod => method === 'password' || method === 'discord') : [];
  return list.length > 0 ? [...new Set(list)].sort() : ['password'];
}
