import type { User } from '../../lib/api';
import { epochMs } from '../../lib/time';
import type { ReauthMethod } from '../account/reauth';

export const isSuspended = (user: User) => user.restrictions.some((restriction) => restriction.kind === 'suspended');

export const FINAL_DELETION_TEXT = 'Your files and albums go offline now. Sign in within 14 days to keep your account; after that it’s deleted for good.';

/** The ways this account can prove it's the owner (§3.5). */
export function methodsOf(user: User): ReauthMethod[] {
  const methods: ReauthMethod[] = [];
  if (user.has_password) methods.push('password');
  if (user.identities.some((identity) => identity.provider === 'discord')) methods.push('discord');
  return methods.length > 0 ? methods : ['password'];
}

/** When a rename is allowed again (§2.2), or null when it's allowed now. */
export function renameAvailableAt(user: User, now = Date.now()): number | null {
  const at = user.username_change_available_at;
  return at !== null && epochMs(at) > now ? epochMs(at) : null;
}
