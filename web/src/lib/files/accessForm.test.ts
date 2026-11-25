import { describe, expect, it } from 'vitest';

import { breaksPasswordLinks, initialAccessForm, linkWithPassword, resolveAccessForm, type AccessCurrent } from './accessForm';

const NOW = 1_795_600_000_000;
const link: AccessCurrent = { visibility: 'link', unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false };
const locked: AccessCurrent = { ...link, visibility: 'password', unlock_ttl: 86400, password_expires_at: 1_795_700_000 };
const ctx = (currents: AccessCurrent[], extra = {}) => ({ anonymous: false, currents, bulk: false, ...extra });

describe('access form', () => {
  it('starts from the current settings (common values for a selection)', () => {
    expect(initialAccessForm([locked])).toMatchObject({ visibility: 'password', unlockTtl: 86400, passwordExpiry: 'custom', passwordExpiryCustomAt: 1_795_700_000_000 });
    expect(initialAccessForm([link, locked])).toMatchObject({ visibility: 'link', unlockTtl: 3600, passwordExpiry: 'never' });
  });

  it('link and private send only the visibility; private needs an account', () => {
    expect(resolveAccessForm({ ...initialAccessForm([locked]), visibility: 'link' }, ctx([locked]), NOW).body).toEqual({ visibility: 'link' });
    const anon = resolveAccessForm({ ...initialAccessForm([link]), visibility: 'private' }, ctx([link], { anonymous: true }), NOW);
    expect(anon.body).toBeNull();
    expect(anon.errors.visibility).toBe('Sign in to keep files private.');
  });

  it('a new password needs one typed (6–128) or generated', () => {
    const state = { ...initialAccessForm([link]), visibility: 'password' as const };
    expect(resolveAccessForm(state, ctx([link]), NOW).errors.password).toBe('Enter a password, or generate one.');
    expect(resolveAccessForm({ ...state, password: 'short' }, ctx([link]), NOW).errors.password).toBe('Use at least 6 characters.');
    expect(resolveAccessForm({ ...state, password: 'long enough' }, ctx([link]), NOW).body).toEqual({
      visibility: 'password',
      password: 'long enough',
      unlock_ttl: 3600,
      password_expires_at: null,
      show_name_when_locked: false,
    });
    expect(resolveAccessForm({ ...state, generatePassword: true }, ctx([link]), NOW).body).toMatchObject({ generate_password: true });
  });

  it('an empty password keeps the current one, and untouched timing is not sent', () => {
    const { body } = resolveAccessForm({ ...initialAccessForm([locked]), showName: true }, ctx([locked]), NOW);
    expect(body).toEqual({ visibility: 'password', show_name_when_locked: true });
  });

  it('timing: "never" clears it (single), is left out (bulk), and must fit the file life', () => {
    const touched = { ...initialAccessForm([locked]), timingTouched: true, passwordExpiry: 'never' as const };
    expect(resolveAccessForm(touched, ctx([locked]), NOW).body).toMatchObject({ unlock_ttl: 86400, password_expires_at: null });
    expect(resolveAccessForm(touched, ctx([locked], { bulk: true }), NOW).body).not.toHaveProperty('password_expires_at');
    const expiring = { ...locked, expires_at: NOW / 1000 + 7200 };
    const tooLong = resolveAccessForm({ ...touched, unlockTtl: 86400, passwordExpiry: 86400 }, ctx([expiring]), NOW);
    expect(tooLong.errors).toEqual({ unlockTtl: 'That’s longer than the file lasts.', passwordExpiry: 'The file expires before that.' });
    expect(resolveAccessForm({ ...touched, unlockTtl: 600, passwordExpiry: 3600 }, ctx([expiring]), NOW).body).toMatchObject({ unlock_ttl: 600, password_expires_in: 3600 });
  });

  it('warns only when existing password links would break', () => {
    expect(breaksPasswordLinks(initialAccessForm([link]), [link])).toBe(false);
    expect(breaksPasswordLinks(initialAccessForm([locked]), [locked])).toBe(false);
    expect(breaksPasswordLinks({ ...initialAccessForm([locked]), generatePassword: true }, [locked])).toBe(true);
    expect(breaksPasswordLinks({ ...initialAccessForm([locked]), visibility: 'private' }, [locked])).toBe(true);
  });

  it('builds #pw= links', () => {
    expect(linkWithPassword('https://files.gg/abc.png', 'amber tunnel')).toBe('https://files.gg/abc.png#pw=amber%20tunnel');
  });
});
