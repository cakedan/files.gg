import { describe, expect, it, vi } from 'vitest';

import { describeExternalLink, openExternal } from './externalLink';

describe('describeExternalLink', () => {
  it('shows the full URL and host for http(s)', () => {
    expect(describeExternalLink('https://example.com/a?b=1#c')).toEqual({
      href: 'https://example.com/a?b=1#c',
      host: 'example.com',
      allowed: true,
    });
  });

  it('refuses script and data URLs', () => {
    expect(describeExternalLink('javascript:alert(1)').allowed).toBe(false);
    expect(describeExternalLink('data:text/html,<b>x</b>').allowed).toBe(false);
    expect(describeExternalLink('not a url').allowed).toBe(false);
  });

  it('allows mailto and shows the address', () => {
    expect(describeExternalLink('mailto:abuse@files.gg')).toMatchObject({ allowed: true, host: 'abuse@files.gg' });
  });

  it('keeps credentials visible in the full URL so files.gg@evil tricks show', () => {
    const info = describeExternalLink('https://files.gg@evil.example/login');
    expect(info.host).toBe('evil.example');
    expect(info.href).toContain('files.gg@evil.example');
  });
});

describe('openExternal', () => {
  it('opens allowed links with noopener and never opens refused ones', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(openExternal(describeExternalLink('https://example.com/'))).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(openExternal(describeExternalLink('javascript:alert(1)'))).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
