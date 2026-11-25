/**
 * Cloudflare's documented Turnstile testing site keys
 * (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 * They produce the dummy token `XXXX.DUMMY.TOKEN.XXXX`, which only the matching
 * testing *secret* keys accept, so they can never pass against production.
 */
export const TURNSTILE_TEST_SITE_KEYS = {
  passVisible: '1x00000000000000000000AA',
  failVisible: '2x00000000000000000000AB',
  passInvisible: '1x00000000000000000000BB',
  failInvisible: '2x00000000000000000000BB',
  interactive: '3x00000000000000000000FF',
} as const;

/** Testing secrets, for the API and the dev mock (never used by the browser). */
export const TURNSTILE_TEST_SECRETS = {
  pass: '1x0000000000000000000000000000000AA',
  fail: '2x0000000000000000000000000000000AA',
  spent: '3x0000000000000000000000000000000AA',
} as const;

export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/**
 * The public site key (contract §8). Production builds must set
 * VITE_TURNSTILE_SITE_KEY (vite.config.ts warns when it's missing); dev and tests
 * fall back to the always-pass testing key.
 */
export const TURNSTILE_SITE_KEY: string =
  import.meta.env.VITE_TURNSTILE_SITE_KEY || (import.meta.env.PROD ? '' : TURNSTILE_TEST_SITE_KEYS.passVisible);
