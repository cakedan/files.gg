import { describe, expect, it } from 'vitest';

import { passwordProblem, passwordScore } from './passwordStrength';

describe('account passwords (milestone-6 §2.6, §16.7)', () => {
  const who = { username: 'dan.w', email: 'dan@example.com' };
  it.each([
    ['seven77', 'too_short'],
    ['eight888', null],
    ['x'.repeat(1000), null],
    ['y'.repeat(60000), null],
    ['Dan.W', 'too_short'],
    ['DAN@example.com', 'matches_email'],
  ])('%#: %s', (password, problem) => {
    expect(passwordProblem(password, who)).toBe(problem);
  });

  it('refuses the username itself once long enough', () => {
    expect(passwordProblem('Dan.Walker', { username: 'dan.walker' })).toBe('matches_username');
  });

  it('scores long, varied passwords higher than common ones', () => {
    expect(passwordScore('password123')).toBeLessThanOrEqual(1);
    expect(passwordScore('aaaaaaaaaaaa')).toBe(0);
    expect(passwordScore('Tr0ub4dor&3-horse-staple')).toBe(4);
    expect(passwordScore('')).toBe(0);
  });
});
