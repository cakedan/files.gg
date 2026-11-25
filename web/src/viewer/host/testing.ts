/**
 * Test helpers for the custom-domain viewer (milestone-6 §13.4). Never imported by
 * application code.
 */

import { parseHostContext, resetHostContext, type HostContext } from './context';

export const CUSTOM_HOST = 'i.example.com';

/**
 * The context the Worker's `#host-data` gives a custom domain, with this page on
 * `https://i.example.com` (jsdom's own origin is localhost, so it's set explicitly).
 */
export function customHostContext(overrides: Partial<HostContext> = {}): HostContext {
  return {
    ...parseHostContext({
      dataHost: 'custom',
      hostJson: JSON.stringify({ host: CUSTOM_HOST, main_origin: 'https://files.gg', api_origin: 'https://api.files.gg' }),
      origin: `https://${CUSTOM_HOST}`,
      locationHost: CUSTOM_HOST,
    }),
    ...overrides,
  };
}

/** Puts the viewer on a custom domain until `resetHostContext()`. */
export function enterCustomHost(overrides: Partial<HostContext> = {}): HostContext {
  const context = customHostContext(overrides);
  resetHostContext(context);
  return context;
}
