/**
 * The `files.gg/challenge` frame's pure logic (milestone-6 §10.10): which parent it
 * answers, and the Turnstile options. main.ts wires it to the DOM.
 *
 * Who the frame answers:
 * - production reads `#challenge-data` only, which the Worker inlines after checking
 *   that `host` is a serving custom domain (domain lookup) and `action` is allowed.
 *   Query parameters are ignored, so a page can't name another parent;
 * - the host must be a plain hostname, never files.gg or one of its subdomains;
 * - the page must be framed, and when the browser exposes `location.ancestorOrigins`,
 *   the parent must be `https://<host>` (the Worker's `frame-ancestors` says the same);
 * - every message goes out with `targetOrigin` = `https://<host>`, so the browser
 *   drops it if any other page is the parent.
 */

import type { TurnstileRenderOptions } from '../lib/turnstile';
import { CHALLENGE_ACTIONS, MSG_ERROR, MSG_EXPIRED, MSG_TOKEN, type ChallengeAction, type ChallengeMessage } from './protocol';

export interface ChallengeConfig {
  host: string;
  action: ChallengeAction;
  /** Where messages go: `https://<host>`. */
  targetOrigin: string;
  /** Dev fixtures only: `error` posts a failure at once, `silent` never answers. */
  simulate?: 'error' | 'silent' | undefined;
}

export interface ConfigInput {
  /** Text of `#challenge-data`, or null when absent. */
  json: string | null;
  /** `location.search`, read only in development. */
  search: string;
  /** `import.meta.env.DEV`. */
  dev: boolean;
  /** This frame's own hostname (`files.gg`). */
  mainHost: string;
  /** This frame's protocol; development targets `http:` parents. */
  protocol: string;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const DEV_HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*)(?::\\d{1,5})?$`);

/** Whether `host` may be this frame's parent. */
export function validParentHost(host: string, mainHost: string, dev: boolean): boolean {
  if (dev) return DEV_HOST.test(host);
  if (!HOSTNAME.test(host) || IPV4.test(host)) return false;
  const main = mainHost.toLowerCase();
  return host !== main && !host.endsWith(`.${main}`);
}

export function readChallengeConfig({ json, search, dev, mainHost, protocol }: ConfigInput): ChallengeConfig | null {
  let data: { host?: unknown; action?: unknown } | null = null;
  try {
    const parsed: unknown = json ? JSON.parse(json) : null;
    if (typeof parsed === 'object' && parsed !== null) data = parsed;
  } catch {
    data = null;
  }
  const query = new URLSearchParams(search);
  // The dev server has no Worker to inline the data, so development reads the query.
  if (!data && dev) data = { host: query.get('host'), action: query.get('action') };
  if (!data) return null;
  const host = typeof data.host === 'string' ? data.host.toLowerCase() : '';
  const wanted = data.action;
  const action = CHALLENGE_ACTIONS.find((a) => a === wanted);
  if (!action || !validParentHost(host, mainHost, dev)) return null;
  const simulate = dev ? query.get('simulate') : null;
  return {
    host,
    action,
    targetOrigin: `${dev && protocol === 'http:' ? 'http:' : 'https:'}//${host}`,
    ...(simulate === 'error' || simulate === 'silent' ? { simulate } : {}),
  };
}

/**
 * Whether to answer at all: framed, and (where the browser says) framed by the right
 * origin. `"null"` means the browser masked the parent (referrer policy), so the
 * `targetOrigin` check alone decides.
 */
export function parentAllowed(config: ChallengeConfig, framed: boolean, ancestorOrigins: ArrayLike<string> | undefined): boolean {
  if (!framed) return false;
  const parent = ancestorOrigins && ancestorOrigins.length > 0 ? ancestorOrigins[0] : undefined;
  return parent === undefined || parent === 'null' || parent === config.targetOrigin;
}

/** Turnstile's `cData` allows only `[A-Za-z0-9_-]`, so the host's dots become `_` (and a dev port's `:` a `-`). */
export const cDataFor = (host: string): string => host.replace(/\./g, '_').replace(/:/g, '-').slice(0, 255);

/** lib/turnstile's options plus the ones only the frame uses. */
export interface FrameTurnstileOptions extends TurnstileRenderOptions {
  cData: string;
  'refresh-expired': 'auto' | 'manual' | 'never';
}

/**
 * Managed mode, shown (`appearance: always`): the frame is a fixed box in the lock
 * screen or report form, so the visitor sees the check rather than an empty space.
 */
export function turnstileOptions(
  config: ChallengeConfig,
  sitekey: string,
  post: (message: ChallengeMessage) => void,
  onTimeout: () => void,
): FrameTurnstileOptions {
  return {
    sitekey,
    action: config.action,
    cData: cDataFor(config.host),
    appearance: 'always',
    theme: 'dark',
    size: 'normal',
    'refresh-expired': 'auto',
    callback: (token) => post({ type: MSG_TOKEN, token }),
    'error-callback': (code) => post({ type: MSG_ERROR, code: String(code ?? 'unknown') }),
    'expired-callback': () => post({ type: MSG_EXPIRED }),
    // An interactive challenge nobody answered: start a new one.
    'timeout-callback': onTimeout,
  };
}
