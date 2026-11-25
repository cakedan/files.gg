import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64url, browser, loadOAuth, makeVerifier, OAUTH_KEY, pkceChallenge, startDiscord, withoutPrompt } from './discord';

afterEach(() => sessionStorage.clear());

describe('PKCE (milestone-6 §5.2, §16.2)', () => {
  it('computes the contract S256 vector', async () => {
    await expect(pkceChallenge('dBjftJeZ4CVP-mJ92IGzWRE3ZTJ0-YHlfYSV0xHrl4w')).resolves.toBe('SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8');
  });

  it('makes 43-character base64url verifiers from 32 random bytes, never the same twice', () => {
    const a = makeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeVerifier()).not.toBe(a);
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('starts Discord: the challenge of a stored verifier, the API state stored, then the redirect', async () => {
    let body: { purpose: string; code_challenge: string } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ url: 'https://discord.com/oauth2/authorize?state=s1&prompt=none', state: 's1' }), { status: 200 });
      }),
    );
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    await startDiscord('login', '/files');
    const stored = loadOAuth()!;
    expect(stored).toMatchObject({ state: 's1', purpose: 'login', next: '/files', retried: false });
    expect(body).toEqual({ purpose: 'login', code_challenge: await pkceChallenge(stored.verifier) });
    expect(assign).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?state=s1&prompt=none');
    expect(JSON.parse(sessionStorage.getItem(OAUTH_KEY)!).verifier).toBe(stored.verifier);
  });

  it('retries without prompt (§5.2 step 6)', () => {
    expect(withoutPrompt('https://discord.com/oauth2/authorize?state=s&prompt=none&code_challenge=c')).toBe('https://discord.com/oauth2/authorize?state=s&code_challenge=c');
  });

  it('ignores malformed stored state', () => {
    sessionStorage.setItem(OAUTH_KEY, '{"state":1}');
    expect(loadOAuth()).toBeNull();
    sessionStorage.setItem(OAUTH_KEY, 'nope');
    expect(loadOAuth()).toBeNull();
  });
});
