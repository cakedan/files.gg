import type { PublicUser } from '../../lib/api';

/** §2.4: a fixed 8-colour palette, picked by `BigInt(id) % 8n`. */
export const AVATAR_COLORS = ['#7c5cff', '#2f9e6f', '#d9480f', '#1c7ed6', '#c2255c', '#e8a10c', '#0b9a9a', '#6c757d'] as const;

export function avatarColor(id: string): string {
  try {
    return AVATAR_COLORS[Number(BigInt(id) % 8n)]!;
  } catch {
    return AVATAR_COLORS[0];
  }
}

/** The first letter of the display name, else of the username, uppercase. */
export function initialOf(user: Pick<PublicUser, 'username' | 'display_name'>): string {
  const source = user.display_name?.trim() || user.username || '?';
  return ([...source][0] ?? '?').toUpperCase();
}

/** "Dan W (@dan.w)", or "@dan.w" without a display name (§2.3). */
export const fullName = (user: Pick<PublicUser, 'username' | 'display_name'>) =>
  user.display_name ? `${user.display_name} (@${user.username})` : `@${user.username}`;
