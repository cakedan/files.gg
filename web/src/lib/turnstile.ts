/**
 * Cloudflare Turnstile, loaded on demand from Cloudflare (not an npm package):
 * - Cloudflare publishes no official browser/React package, only the script;
 * - Cloudflare warns that proxying or bundling api.js breaks it when they ship updates;
 * - loading it only when a lock screen or anonymous upload needs it keeps it out of
 *   every bundle and off every other page.
 * The CSP needs `script-src` and `frame-src` for https://challenges.cloudflare.com.
 */

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** `view`: opening a view-limited file (milestone-6 §19.4). `convert`: an anonymous conversion (milestone-5 §7.1). */
export type TurnstileAction = 'unlock' | 'upload' | 'login' | 'register' | 'forgot' | 'reset' | 'report' | 'view' | 'convert';

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: TurnstileAction;
  appearance?: 'always' | 'execute' | 'interaction-only';
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'flexible' | 'compact';
  callback?: (token: string) => void;
  'error-callback'?: (code?: string) => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement | string, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
  getResponse(widgetId?: string): string | undefined;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/**
 * Injects Cloudflare's script once; later calls share the same promise. A failed load
 * (network error, or a script that didn't define `window.turnstile`) is forgotten, so
 * the next call (Retry) injects it again.
 */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  const attempt = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    const fail = (message: string) => {
      if (loading === attempt) loading = null;
      script.remove();
      reject(new Error(message));
    };
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : fail('turnstile-missing'));
    script.onerror = () => fail('turnstile-load-failed');
    doc.head.append(script);
  });
  loading = attempt;
  return attempt;
}

/** Test hook: forget a previous (possibly failed) load. */
export function resetTurnstileLoader(): void {
  loading = null;
}
