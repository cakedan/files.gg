/**
 * Account password rules (milestone-6 §2.6) and a strength meter. The contract asks for
 * zxcvbn-ts; it isn't a dependency of this app, so this is a small estimate of the same
 * kind (length, variety, common patterns). The API's rules are only the three below.
 */

export const PASSWORD_MIN = 8;

export type PasswordProblem = 'too_short' | 'matches_username' | 'matches_email';

export function passwordProblem(password: string, { username, email }: { username?: string | null; email?: string | null } = {}): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN) return 'too_short';
  const folded = password.toLowerCase();
  if (username && folded === username.trim().toLowerCase()) return 'matches_username';
  if (email && folded === email.trim().toLowerCase()) return 'matches_email';
  return null;
}

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN} characters.`,
  matches_username: 'Your password can’t be your username.',
  matches_email: 'Your password can’t be your email.',
};

const COMMON = ['password', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'dragon', 'monkey', 'football', 'baseball', 'abc123', '123456', 'filesgg', 'files.gg'];

/** 0 (very weak) to 4 (strong). */
export function passwordScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  const length = [...password].length;
  const lower = password.toLowerCase();
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^A-Za-z0-9]/.test(password)) classes++;
  const unique = new Set(password).size;
  let score = 0;
  if (length >= PASSWORD_MIN) score++;
  if (length >= 12) score++;
  if (length >= 16 || (length >= 12 && classes >= 3)) score++;
  if (classes >= 3 && length >= 10) score++;
  if (COMMON.some((word) => lower.includes(word))) score -= 2;
  if (unique <= Math.max(2, length / 4)) score -= 2;
  if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer)/i.test(password)) score--;
  return Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;
}

export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;
