import { describe, expect, it } from 'vitest';

import { cleanDisplayName, displayNameProblem, normalizeUsername, usernameProblem } from './usernames';

describe('usernames (milestone-6 §2.2, §16.6)', () => {
  it.each([
    ['Dan.W', null],
    ['d', 'length'],
    ['abcdefghijabcdefghijabcdefghijabc', 'length'],
    ['dan-w', 'characters'],
    ['.dan', 'dots'],
    ['dan.', 'dots'],
    ['da..n', 'dots'],
    ['12345', 'numeric'],
    ['u12345', 'reserved'],
    ['admin', 'reserved'],
    ['Files.GG', 'reserved'],
    ['filesgg_dan', 'reserved'],
    ['deleted-123', 'characters'],
    ['_x', null],
  ])('%s → %s', (input, problem) => {
    expect(usernameProblem(input)).toBe(problem);
  });

  it('lowercases and trims', () => {
    expect(normalizeUsername('  Dan.W ')).toBe('dan.w');
  });
});

describe('display names (§2.3)', () => {
  it('cleans invisible characters and whitespace', () => {
    expect(cleanDisplayName('  Dan​   W‮ ')).toBe('Dan W');
    expect(cleanDisplayName('​')).toBe('');
  });

  it('refuses impersonation and long names; empty is fine', () => {
    expect(displayNameProblem('files.gg staff')).toBe('reserved');
    expect(displayNameProblem('S-t_a.f f')).toBe('reserved');
    expect(displayNameProblem('Visit files.gg')).toBe('reserved');
    expect(displayNameProblem('x'.repeat(33))).toBe('length');
    expect(displayNameProblem('')).toBeNull();
    expect(displayNameProblem('Dan W')).toBeNull();
  });
});

describe('the API’s rules (usernameRules.json, from `python -m tools.username_rules`)', () => {
  it('match this module exactly, so the form never accepts a name the API refuses', async () => {
    const rules = (await import('./usernameRules.json')).default;
    const { RESERVED_USERNAMES, RESERVED_USERNAME_PREFIXES, USERNAME_MAX, USERNAME_MIN, DISPLAY_NAME_MAX } = await import('./usernames');
    expect([...RESERVED_USERNAMES].sort()).toEqual([...rules.reserved].sort());
    expect([...RESERVED_USERNAME_PREFIXES]).toEqual(rules.reserved_prefixes);
    expect([USERNAME_MIN, USERNAME_MAX, DISPLAY_NAME_MAX]).toEqual([rules.min_length, rules.max_length, rules.display_name_max_length]);
    expect(rules.characters).toBe('[a-z0-9_.]');
    expect(rules.staff_reset_pattern).toBe('^u[0-9]+$');
    for (const name of rules.display_name_reserved) expect(displayNameProblem(name)).toBe('reserved');
  });
});
