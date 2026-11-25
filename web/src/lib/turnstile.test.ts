import { afterEach, describe, expect, it } from 'vitest';

import { TURNSTILE_SITE_KEY, TURNSTILE_TEST_SITE_KEYS } from './config';
import { loadTurnstile, resetTurnstileLoader, TURNSTILE_SCRIPT } from './turnstile';

afterEach(() => {
  delete window.turnstile;
  resetTurnstileLoader();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});

describe('loadTurnstile', () => {
  it("injects Cloudflare's explicit-render script once, on demand", async () => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    const scripts = document.head.querySelectorAll(`script[src="${TURNSTILE_SCRIPT}"]`);
    expect(scripts).toHaveLength(1);
    window.turnstile = { render: () => 'w', reset: () => undefined, remove: () => undefined, getResponse: () => undefined };
    scripts[0]!.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(window.turnstile);
    await expect(second).resolves.toBe(window.turnstile);
  });

  it('rejects on a load error and lets a later call try again', async () => {
    const attempt = loadTurnstile();
    document.head.querySelector('script')!.dispatchEvent(new Event('error'));
    await expect(attempt).rejects.toThrow('turnstile-load-failed');
    expect(document.head.querySelector('script')).toBeNull();
    void loadTurnstile().catch(() => undefined);
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
  });

  it('uses the always-pass testing key in dev and tests', () => {
    expect(TURNSTILE_SITE_KEY).toBe(TURNSTILE_TEST_SITE_KEYS.passVisible);
    expect(TURNSTILE_TEST_SITE_KEYS).toEqual({
      passVisible: '1x00000000000000000000AA',
      failVisible: '2x00000000000000000000AB',
      passInvisible: '1x00000000000000000000BB',
      failInvisible: '2x00000000000000000000BB',
      interactive: '3x00000000000000000000FF',
    });
  });
});
