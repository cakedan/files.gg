/**
 * Username and display name rules (milestone-6 §2.2, §2.3), so forms can explain a
 * refusal before sending. The API (`api/utils/usernames.py`) is the authority: its
 * `python -m tools.username_rules` writes `usernameRules.json` next to this file, and
 * `usernames.test.ts` fails if these constants drift from it. They're constants here,
 * not a JSON import, because the dev mock (`mock-api.ts`, type-checked without
 * `resolveJsonModule`) imports this module too.
 */

export type UsernameProblem = 'length' | 'characters' | 'dots' | 'numeric' | 'reserved';
export type UsernameReason = UsernameProblem | 'taken';

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 32;

/** §2.2: refused with `USERNAME_INVALID { reason: "reserved" }`. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'about', 'abuse', 'account', 'accounts', 'admin', 'administrator', 'album', 'albums', 'anonymous', 'api', 'app',
  'assets', 'auth', 'billing', 'blog', 'bot', 'cdn', 'contact', 'convert', 'copyright', 'dashboard', 'deleted',
  'discord', 'dmca', 'docs', 'domains', 'download', 'email', 'files', 'gg', 'guest', 'help', 'info', 'internal',
  'legal', 'login', 'logout', 'mail', 'me', 'mod', 'moderator', 'moderators', 'news', 'noreply', 'null', 'official',
  'owner', 'password', 'premium', 'press', 'privacy', 'register', 'report', 'reports', 'root', 'security', 'settings',
  'signin', 'signup', 'staff', 'status', 'support', 'system', 'team', 'terms', 'test', 'undefined', 'upload',
  'uploads', 'user', 'users', 'verify', 'www',
]);

export const RESERVED_USERNAME_PREFIXES = ['filesgg', 'files.gg', 'files_gg'] as const;

/** Trimmed and lowercased, as the API stores it ("Dan.W" becomes "dan.w"). */
export const normalizeUsername = (input: string): string => input.trim().toLowerCase();

/** The first rule a (normalised) username breaks, or null when it's valid. Taken names need the API. */
export function usernameProblem(input: string): UsernameProblem | null {
  const name = normalizeUsername(input);
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return 'length';
  if (!/^[a-z0-9_.]+$/.test(name)) return 'characters';
  if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) return 'dots';
  if (/^[0-9]+$/.test(name)) return 'numeric';
  if (/^u[0-9]+$/.test(name)) return 'reserved';
  if (RESERVED_USERNAMES.has(name) || RESERVED_USERNAME_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'reserved';
  return null;
}

export const USERNAME_REASON_TEXT: Record<UsernameReason, string> = {
  length: `Use ${USERNAME_MIN} to ${USERNAME_MAX} characters.`,
  characters: 'Use only letters, numbers, underscores and dots.',
  dots: 'Dots can’t be first, last or next to each other.',
  numeric: 'Add at least one letter or underscore.',
  reserved: 'That username is reserved.',
  taken: 'That username is taken.',
};

/** Control characters (Cc) and format characters (Cf: bidi controls, zero-width characters, BOM). */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const DISPLAY_RESERVED = new Set(['staff', 'filesggstaff', 'moderator', 'admin', 'support']);

/** §2.3 cleaning: NFC, invisible and control characters removed, whitespace collapsed, trimmed. */
export function cleanDisplayName(input: string): string {
  return input.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

export type DisplayNameProblem = 'length' | 'reserved';

/** Null for an empty (cleared) or valid display name. */
export function displayNameProblem(input: string): DisplayNameProblem | null {
  const name = cleanDisplayName(input);
  if (!name) return null;
  if ([...name].length > DISPLAY_NAME_MAX) return 'length';
  const folded = name.toLowerCase();
  if (folded.includes('files.gg')) return 'reserved';
  if (DISPLAY_RESERVED.has(folded.replace(/[\s._-]/g, ''))) return 'reserved';
  return null;
}

export const DISPLAY_NAME_REASON_TEXT: Record<DisplayNameProblem, string> = {
  length: `Use up to ${DISPLAY_NAME_MAX} characters.`,
  reserved: 'That display name could be mistaken for files.gg staff.',
};
