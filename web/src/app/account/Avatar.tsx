import type { PublicUser } from '../../lib/api';
import { avatarColor, initialOf } from './avatarUtils';

/** The generated initials tile (milestone-6 §2.4): nothing is uploaded or stored. */
export function Avatar({ user, size = 'md' }: { user: Pick<PublicUser, 'id' | 'username' | 'display_name'>; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'size-7 text-xs', md: 'size-9 text-sm', lg: 'size-14 text-xl' } as const;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-xl font-semibold text-white ${sizes[size]}`}
      style={{ backgroundColor: avatarColor(user.id) }}
      data-testid="avatar"
    >
      {initialOf(user)}
    </span>
  );
}
