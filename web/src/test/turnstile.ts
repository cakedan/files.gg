import { vi } from 'vitest';

import type { TurnstileApi, TurnstileRenderOptions } from '../lib/turnstile';

/**
 * A stand-in for Cloudflare's widget: issues the testing dummy token on render and
 * after each reset (like the always-pass testing site key), or fails on demand.
 */
export function installTurnstile({ fail = false } = {}) {
  const widgets = new Map<string, TurnstileRenderOptions>();
  let next = 0;
  const issue = (id: string) =>
    setTimeout(() => {
      const options = widgets.get(id);
      if (!options) return;
      if (fail) options['error-callback']?.('110200');
      else options.callback?.('XXXX.DUMMY.TOKEN.XXXX');
    }, 0);
  const api: TurnstileApi = {
    render: vi.fn((_el, options) => {
      const id = `w${next++}`;
      widgets.set(id, options);
      issue(id);
      return id;
    }),
    reset: vi.fn((id?: string) => id && issue(id)),
    remove: vi.fn((id?: string) => id && widgets.delete(id)),
    getResponse: vi.fn(() => undefined),
  };
  window.turnstile = api;
  return { api, widgets };
}
