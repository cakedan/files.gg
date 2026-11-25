import { setSignedInState, type User } from '../lib/api';
import { createQueryClient } from '../lib/queryClient';
import { SESSION_QUERY_KEY } from '../lib/session';

/** A signed-in user (milestone-6 §2.1): free, verified, with a password, no Discord. */
export const ME: User = {
  id: '42',
  username: 'mockuser',
  display_name: 'Mock User',
  email: 'mock@example.com',
  email_verified: true,
  pending_email: null,
  has_password: true,
  needs_username: false,
  created_at: 1760000000,
  username_changed_at: null,
  username_change_available_at: null,
  identities: [],
  settings: { show_name_on_albums: false, domain_only: false },
  premium: { active: false, expires_at: null },
  deletion: null,
  staff: null,
  restrictions: [],
};

let current: User | null = null;

/** Who `GET /auth/session` says is signed in (milestone-6 §3.4) in `stubApi`; null signed out. */
export const sessionUser = (): User | null => current;

/** Signs the stubbed API in (the session cookie stands behind this in the real app). */
export function signIn(user: User = ME): void {
  current = user;
}

/** Signed out, and the client forgets its last session answer. Run after every test. */
export function signOut(): void {
  current = null;
  setSignedInState(null);
}

/** A query client that already knows the session, for tests that stub `fetch` by hand. */
export function signedInQueryClient(user: User = ME) {
  signIn(user);
  setSignedInState(true);
  const client = createQueryClient();
  client.setQueryData(SESSION_QUERY_KEY, user);
  return client;
}
